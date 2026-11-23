use serde::{Deserialize, Serialize};
use ssh2::{OpenFlags, OpenType, Session, Sftp};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

/// 编辑器默认允许直接读取的最大文件体积（2MB）
const MAX_INLINE_READ_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RemoteFileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub permissions: u32,
    pub mtime: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SftpListResult {
    pub current_dir: String,
    pub files: Vec<RemoteFileInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TransferProgressPayload {
    pub transfer_id: String,
    pub file_name: String,
    pub transferred: u64,
    pub total: u64,
    pub done: bool,
}

#[derive(Clone)]
pub struct TransferRegistry {
    cancelled: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl TransferRegistry {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn register(&self, transfer_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.cancelled.lock() {
            map.insert(transfer_id.to_string(), Arc::clone(&flag));
        }
        flag
    }

    pub fn cancel(&self, transfer_id: &str) {
        if let Ok(map) = self.cancelled.lock() {
            if let Some(flag) = map.get(transfer_id) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn unregister(&self, transfer_id: &str) {
        if let Ok(mut map) = self.cancelled.lock() {
            map.remove(transfer_id);
        }
    }
}

pub struct SftpManager;

fn join_remote_path(base: &str, name: &str) -> String {
    let clean_base = base.trim().replace('\\', "/");
    let clean_base = clean_base.trim_end_matches('/');
    let clean_name = name.trim_start_matches('/').replace('\\', "/");
    if clean_base.is_empty() {
        format!("/{}", clean_name)
    } else {
        format!("{}/{}", clean_base, clean_name)
    }
}

fn ensure_remote_parent_dirs(sftp: &Sftp, remote_path: &str) {
    let normalized = remote_path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 1 {
        return;
    }
    let is_abs = normalized.starts_with('/');
    let mut current = if is_abs {
        String::from("/")
    } else {
        String::new()
    };
    for part in &parts[..parts.len() - 1] {
        if !current.ends_with('/') && !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        let _ = sftp.mkdir(Path::new(&current), 0o755);
    }
}

fn ensure_remote_dir_all(sftp: &Sftp, remote_dir: &str) {
    let normalized = remote_dir.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    let is_abs = normalized.starts_with('/');
    let mut current = if is_abs {
        String::from("/")
    } else {
        String::new()
    };
    for part in parts {
        if !current.ends_with('/') && !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        let _ = sftp.mkdir(Path::new(&current), 0o755);
    }
}

fn collect_local_files_recursive(
    root: &Path,
    remote_root: &str,
    out: &mut Vec<(PathBuf, String, u64)>,
    dirs_to_create: &mut Vec<String>,
) -> Result<(), String> {
    let meta = std::fs::metadata(root)
        .map_err(|e| format!("读取本地路径信息失败 ({}): {}", root.display(), e))?;
    if meta.is_file() {
        out.push((root.to_path_buf(), remote_root.to_string(), meta.len()));
        return Ok(());
    }
    if meta.is_dir() {
        dirs_to_create.push(remote_root.to_string());
        let entries = std::fs::read_dir(root)
            .map_err(|e| format!("读取本地目录失败 ({}): {}", root.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("遍历本地目录项失败: {}", e))?;
            let child_path = entry.path();
            let child_name = entry.file_name().to_string_lossy().to_string();
            let child_remote = join_remote_path(remote_root, &child_name);
            collect_local_files_recursive(&child_path, &child_remote, out, dirs_to_create)?;
        }
    }
    Ok(())
}

fn remove_recursive_inner(sftp: &Sftp, remote_path: &Path) -> Result<(), String> {
    let entries = sftp
        .readdir(remote_path)
        .map_err(|e| format!("读取待删除目录失败 ({}): {}", remote_path.display(), e))?;
    for (child_path, stat) in entries {
        let name = child_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if name == "." || name == ".." {
            continue;
        }
        // S_IFMT = 0o170000, S_IFLNK = 0o120000：软链接直接 unlink，绝不跟随递归删除目标目录
        let is_symlink = stat
            .perm
            .map(|p| (p & 0o170000) == 0o120000)
            .unwrap_or(false);
        if stat.is_dir() && !is_symlink {
            remove_recursive_inner(sftp, &child_path)?;
        } else {
            sftp.unlink(&child_path)
                .map_err(|e| format!("删除文件失败 ({}): {}", child_path.display(), e))?;
        }
    }
    sftp.rmdir(remote_path)
        .map_err(|e| format!("删除目录失败 ({}): {}", remote_path.display(), e))?;
    Ok(())
}

impl SftpManager {
    pub fn get_home_dir(sess_arc: Arc<Mutex<Session>>) -> Result<String, String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;
            let home = sftp
                .realpath(Path::new("."))
                .map_err(|e| format!("获取当前用户根目录失败: {}", e))?;
            Ok(home.to_string_lossy().to_string())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn list_dir(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
    ) -> Result<SftpListResult, String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;

            let target_path = if remote_path.is_empty() || remote_path == "." || remote_path == "~" {
                sftp.realpath(Path::new("."))
                    .map_err(|e| format!("无法解析当前用户根目录: {}", e))?
            } else {
                sftp.realpath(Path::new(remote_path))
                    .map_err(|e| format!("无法解析目标目录 {}: {}", remote_path, e))?
            };

            let current_dir = target_path.to_string_lossy().replace('\\', "/");
            let entries = sftp
                .readdir(&target_path)
                .map_err(|e| format!("读取远程目录失败 ({}): {}", current_dir, e))?;

            let mut list = Vec::new();
            for (path, stat) in entries {
                let filename = path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| ".".to_string());

                if filename == "." || filename == ".." {
                    continue;
                }

                let full_path = path.to_string_lossy().replace('\\', "/");
                let permissions = stat.perm.unwrap_or(0);
                let is_symlink = (permissions & 0o170000) == 0o120000;
                // 若是软链接，探测其指向目标是目录还是文件，便于点击进入
                let is_dir = if is_symlink {
                    sftp.stat(&path).map(|s| s.is_dir()).unwrap_or(false)
                } else {
                    stat.is_dir()
                };
                let size = stat.size.unwrap_or(0);
                let mtime = stat.mtime.unwrap_or(0);

                list.push(RemoteFileInfo {
                    name: filename,
                    path: full_path,
                    size,
                    is_dir,
                    is_symlink,
                    permissions,
                    mtime,
                });
            }

            list.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });

            Ok(SftpListResult {
                current_dir,
                files: list,
            })
        })();
        sess.set_blocking(false);
        res
    }

    pub fn mkdir(sess_arc: Arc<Mutex<Session>>, remote_path: &str) -> Result<(), String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;
            sftp.mkdir(Path::new(remote_path), 0o755)
                .map_err(|e| format!("新建文件夹失败: {}", e))?;
            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn create_file(sess_arc: Arc<Mutex<Session>>, remote_path: &str) -> Result<(), String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;
            let _file = sftp
                .create(Path::new(remote_path))
                .map_err(|e| format!("新建文件失败: {}", e))?;
            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn rename(
        sess_arc: Arc<Mutex<Session>>,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;
            sftp.rename(Path::new(old_path), Path::new(new_path), None)
                .map_err(|e| format!("重命名失败: {}", e))?;
            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn chmod(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
        mode: u32,
    ) -> Result<(), String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;
            let path = Path::new(remote_path);
            let mut stat = sftp
                .stat(path)
                .map_err(|e| format!("获取文件属性失败: {}", e))?;
            stat.perm = Some(mode & 0o7777);
            sftp.setstat(path, stat)
                .map_err(|e| format!("修改文件权限失败: {}", e))?;
            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn remove(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
        is_dir: bool,
        recursive: bool,
    ) -> Result<(), String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;
            let path = Path::new(remote_path);
            if is_dir {
                if recursive {
                    remove_recursive_inner(&sftp, path)?;
                } else {
                    sftp.rmdir(path)
                        .map_err(|e| format!("删除文件夹失败（目录非空或无权限）: {}", e))?;
                }
            } else {
                sftp.unlink(path)
                    .map_err(|e| format!("删除文件失败: {}", e))?;
            }
            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn read_file(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
        max_bytes: Option<u64>,
    ) -> Result<String, String> {
        let limit = max_bytes.unwrap_or(MAX_INLINE_READ_BYTES);
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;

            let path = Path::new(remote_path);
            if let Ok(stat) = sftp.stat(path) {
                if let Some(size) = stat.size {
                    if size > limit {
                        return Err(format!(
                            "文件体积过大 ({:.2} MB，超过在线预览上限 {:.2} MB)，请直接下载到本地查看",
                            size as f64 / (1024.0 * 1024.0),
                            limit as f64 / (1024.0 * 1024.0)
                        ));
                    }
                }
            }

            let mut file = sftp
                .open(path)
                .map_err(|e| format!("打开远程文件失败: {}", e))?;

            let mut buf = Vec::new();
            let mut chunk = [0u8; 32768];
            loop {
                match file.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        if (buf.len() + n) as u64 > limit {
                            return Err(format!(
                                "文件实际体积超过在线预览上限 ({:.2} MB)，请下载后查看",
                                limit as f64 / (1024.0 * 1024.0)
                            ));
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    Err(e) => return Err(format!("读取远程文件内容失败: {}", e)),
                }
            }

            // 检测二进制文件特征（前 8KB 含 NUL 字节）
            let sample_len = buf.len().min(8192);
            if buf[..sample_len].contains(&0) {
                return Err("该文件为二进制文件，不支持文本编辑器直接打开，请下载到本地".to_string());
            }

            String::from_utf8(buf)
                .map_err(|_| "文件包含非 UTF-8 编码字节，不支持文本在线编辑，请下载到本地查看".to_string())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn write_file(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
        content: &str,
    ) -> Result<(), String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;

            ensure_remote_parent_dirs(&sftp, remote_path);

            let mut file = sftp
                .create(Path::new(remote_path))
                .map_err(|e| format!("创建/打开远程文件失败: {}", e))?;

            file.write_all(content.as_bytes())
                .map_err(|e| format!("写入远程文件失败: {}", e))?;

            file.flush()
                .map_err(|e| format!("刷新远程文件写入失败: {}", e))?;

            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn upload_bytes(
        sess_arc: Arc<Mutex<Session>>,
        remote_dir: &str,
        file_name: &str,
        data: &[u8],
    ) -> Result<(), String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;

            let full_path = join_remote_path(remote_dir, file_name);
            ensure_remote_parent_dirs(&sftp, &full_path);

            let mut file = sftp
                .create(Path::new(&full_path))
                .map_err(|e| format!("创建远程文件失败 ({}): {}", full_path, e))?;

            file.write_all(data)
                .map_err(|e| format!("写入远程文件失败: {}", e))?;

            file.flush()
                .map_err(|e| format!("刷新远程文件写入失败: {}", e))?;

            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    /// 分块流式上传接口（供浏览器文件选择器大文件分片上传，杜绝前端内存 OOM）
    pub fn upload_chunk(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
        offset: u64,
        data: &[u8],
    ) -> Result<(), String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;

            if offset == 0 {
                ensure_remote_parent_dirs(&sftp, remote_path);
            }

            let flags = if offset == 0 {
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
            } else {
                OpenFlags::CREATE | OpenFlags::WRITE
            };

            let mut file = sftp
                .open_mode(Path::new(remote_path), flags, 0o644, OpenType::File)
                .map_err(|e| format!("打开远程目标文件失败 ({}): {}", remote_path, e))?;

            if offset > 0 {
                file.seek(SeekFrom::Start(offset))
                    .map_err(|e| format!("定位远程写入偏移失败: {}", e))?;
            }

            file.write_all(data)
                .map_err(|e| format!("写入远程分片数据失败: {}", e))?;
            file.flush()
                .map_err(|e| format!("刷新远程文件写入失败: {}", e))?;
            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    /// 跨平台上传本地文件或文件夹（支持目录递归、实时进度推送与取消）
    pub fn upload_local_path(
        sess_arc: Arc<Mutex<Session>>,
        local_path: &str,
        remote_dir: &str,
        transfer_id: Option<String>,
        cancel_flag: Option<Arc<AtomicBool>>,
        progress_channel: Option<Channel<TransferProgressPayload>>,
    ) -> Result<usize, String> {
        let local = Path::new(local_path);
        if !local.exists() {
            return Err(format!("本地路径不存在: {}", local_path));
        }

        let base_name = local
            .file_name()
            .ok_or_else(|| format!("无效的本地文件名: {}", local_path))?
            .to_string_lossy()
            .to_string();

        let target_root = join_remote_path(remote_dir, &base_name);
        let mut files: Vec<(PathBuf, String, u64)> = Vec::new();
        let mut dirs_to_create: Vec<String> = Vec::new();
        collect_local_files_recursive(local, &target_root, &mut files, &mut dirs_to_create)?;

        let total_bytes: u64 = files.iter().map(|(_, _, sz)| *sz).sum();
        let mut uploaded_bytes: u64 = 0;

        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;

            for d in &dirs_to_create {
                ensure_remote_dir_all(&sftp, d);
            }

            let mut count = 0usize;
            let mut buf = [0u8; 65536];
            let tid = transfer_id.clone().unwrap_or_default();

            for (src_path, dst_remote, _) in &files {
                if let Some(ref flag) = cancel_flag {
                    if flag.load(Ordering::SeqCst) {
                        return Err("上传已取消".to_string());
                    }
                }

                ensure_remote_parent_dirs(&sftp, dst_remote);
                let mut local_file = std::fs::File::open(src_path)
                    .map_err(|e| format!("打开本地文件失败 ({}): {}", src_path.display(), e))?;
                let mut remote_file = sftp
                    .create(Path::new(dst_remote))
                    .map_err(|e| format!("创建远程目标文件失败 ({}): {}", dst_remote, e))?;

                let mut last_emit = std::time::Instant::now();
                loop {
                    if let Some(ref flag) = cancel_flag {
                        if flag.load(Ordering::SeqCst) {
                            return Err("上传已取消".to_string());
                        }
                    }
                    match local_file.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            remote_file
                                .write_all(&buf[..n])
                                .map_err(|e| format!("写入远程目标文件失败: {}", e))?;
                            uploaded_bytes += n as u64;
                            if let Some(ref ch) = progress_channel {
                                if last_emit.elapsed() >= std::time::Duration::from_millis(80) {
                                    let _ = ch.send(TransferProgressPayload {
                                        transfer_id: tid.clone(),
                                        file_name: base_name.clone(),
                                        transferred: uploaded_bytes,
                                        total: total_bytes,
                                        done: false,
                                    });
                                    last_emit = std::time::Instant::now();
                                }
                            }
                        }
                        Err(e) => return Err(format!("读取本地文件数据中断: {}", e)),
                    }
                }
                remote_file
                    .flush()
                    .map_err(|e| format!("刷新远程文件写入失败: {}", e))?;
                count += 1;
            }

            if let Some(ref ch) = progress_channel {
                let _ = ch.send(TransferProgressPayload {
                    transfer_id: tid,
                    file_name: base_name,
                    transferred: total_bytes,
                    total: total_bytes,
                    done: true,
                });
            }

            Ok(count.max(1))
        })();
        sess.set_blocking(false);
        res
    }

    pub fn upload_local_file(
        sess_arc: Arc<Mutex<Session>>,
        local_path: &str,
        remote_path: &str,
    ) -> Result<(), String> {
        let local = Path::new(local_path);
        if local.is_dir() {
            let parent = Path::new(remote_path)
                .parent()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| "/".to_string());
            Self::upload_local_path(sess_arc, local_path, &parent, None, None, None)?;
            return Ok(());
        }
        let parent = Path::new(remote_path)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| "/".to_string());
        Self::upload_local_path(sess_arc, local_path, &parent, None, None, None)?;
        Ok(())
    }

    pub fn download_to_downloads_dir(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
        transfer_id: Option<String>,
        cancel_flag: Option<Arc<AtomicBool>>,
        progress_channel: Option<Channel<TransferProgressPayload>>,
    ) -> Result<String, String> {
        let sess = sess_arc.lock().map_err(|_| "SFTP 会话锁异常".to_string())?;
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 通道失败: {}", e))?;

            let remote_path_buf = Path::new(remote_path);
            let file_name = remote_path_buf
                .file_name()
                .ok_or_else(|| "无效的文件名".to_string())?
                .to_string_lossy()
                .to_string();

            let total_bytes = sftp
                .stat(remote_path_buf)
                .ok()
                .and_then(|s| s.size)
                .unwrap_or(0);

            let mut remote_file = sftp
                .open(remote_path_buf)
                .map_err(|e| format!("打开远程文件失败: {}", e))?;

            // 全平台使用 dirs::download_dir() 解析系统下载目录（兼容 Windows 自定义目录、Linux XDG、macOS）
            let downloads_dir = dirs::download_dir()
                .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
                .unwrap_or_else(|| PathBuf::from("."));

            if !downloads_dir.exists() {
                let _ = std::fs::create_dir_all(&downloads_dir);
            }

            let mut local_dest = downloads_dir.join(&file_name);
            if local_dest.exists() {
                let stem = remote_path_buf
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy();
                let ext = remote_path_buf
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_default();
                let mut counter = 1;
                while local_dest.exists() {
                    local_dest = downloads_dir.join(format!("{}_{}{}", stem, counter, ext));
                    counter += 1;
                }
            }

            let mut local_file = std::fs::File::create(&local_dest)
                .map_err(|e| format!("创建本地文件失败 ({}): {}", local_dest.display(), e))?;

            let mut buf = [0u8; 65536];
            let mut downloaded: u64 = 0;
            let tid = transfer_id.unwrap_or_default();
            let mut last_emit = std::time::Instant::now();

            loop {
                if let Some(ref flag) = cancel_flag {
                    if flag.load(Ordering::SeqCst) {
                        drop(local_file);
                        let _ = std::fs::remove_file(&local_dest);
                        return Err("下载已取消".to_string());
                    }
                }
                match remote_file.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        local_file
                            .write_all(&buf[..n])
                            .map_err(|e| format!("写入本地文件失败: {}", e))?;
                        downloaded += n as u64;
                        if let Some(ref ch) = progress_channel {
                            if last_emit.elapsed() >= std::time::Duration::from_millis(80) {
                                let _ = ch.send(TransferProgressPayload {
                                    transfer_id: tid.clone(),
                                    file_name: file_name.clone(),
                                    transferred: downloaded,
                                    total: total_bytes.max(downloaded),
                                    done: false,
                                });
                                last_emit = std::time::Instant::now();
                            }
                        }
                    }
                    Err(e) => return Err(format!("下载传输中断: {}", e)),
                }
            }

            if let Some(ref ch) = progress_channel {
                let _ = ch.send(TransferProgressPayload {
                    transfer_id: tid,
                    file_name,
                    transferred: downloaded,
                    total: total_bytes.max(downloaded),
                    done: true,
                });
            }

            Ok(local_dest.to_string_lossy().to_string())
        })();
        sess.set_blocking(false);
        res
    }
}
