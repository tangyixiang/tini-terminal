use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RemoteFileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub permissions: u32,
    pub mtime: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SftpListResult {
    pub current_dir: String,
    pub files: Vec<RemoteFileInfo>,
}

pub struct SftpManager;

impl SftpManager {
    pub fn get_home_dir(sess_arc: Arc<Mutex<Session>>) -> Result<String, String> {
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;
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
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;

            let target_path = if remote_path.is_empty() || remote_path == "." || remote_path == "~" {
                sftp.realpath(Path::new("."))
                    .unwrap_or_else(|_| std::path::PathBuf::from("/"))
            } else {
                sftp.realpath(Path::new(remote_path))
                    .unwrap_or_else(|_| std::path::PathBuf::from(remote_path))
            };

            let current_dir = target_path.to_string_lossy().to_string();
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

                let full_path = path.to_string_lossy().to_string();
                let is_dir = stat.is_dir();
                let size = stat.size.unwrap_or(0);
                let permissions = stat.perm.unwrap_or(0);
                let mtime = stat.mtime.unwrap_or(0);

                list.push(RemoteFileInfo {
                    name: filename,
                    path: full_path,
                    size,
                    is_dir,
                    permissions,
                    mtime,
                });
            }

            // 排序：目录在前，文件在后，按名称升序
            list.sort_by(|a, b| {
                if a.is_dir && !b.is_dir {
                    std::cmp::Ordering::Less
                } else if !a.is_dir && b.is_dir {
                    std::cmp::Ordering::Greater
                } else {
                    a.name.cmp(&b.name)
                }
            });

            Ok(SftpListResult {
                current_dir,
                files: list,
            })
        })();
        sess.set_blocking(false);
        res
    }

    pub fn mkdir(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
    ) -> Result<(), String> {
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;
            sftp.mkdir(Path::new(remote_path), 0o755)
                .map_err(|e| format!("新建文件夹失败: {}", e))?;
            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn create_file(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
    ) -> Result<(), String> {
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;
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
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;
            sftp.rename(Path::new(old_path), Path::new(new_path), None)
                .map_err(|e| format!("重命名失败: {}", e))?;
            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn remove(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
        is_dir: bool,
    ) -> Result<(), String> {
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;
            let path = Path::new(remote_path);
            if is_dir {
                sftp.rmdir(path)
                    .map_err(|e| format!("删除文件夹失败（目录可能非空或无权限）: {}", e))?;
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
    ) -> Result<String, String> {
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;

            let mut file = sftp
                .open(Path::new(remote_path))
                .map_err(|e| format!("打开远程文件失败: {}", e))?;

            let mut buf = Vec::new();
            file.read_to_end(&mut buf)
                .map_err(|e| format!("读取远程文件内容失败: {}", e))?;

            String::from_utf8(buf)
                .map_err(|e| format!("文件包含非 UTF-8 字符: {}", e))
        })();
        sess.set_blocking(false);
        res
    }

    pub fn write_file(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
        content: &str,
    ) -> Result<(), String> {
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;

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
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;

            let clean_dir = remote_dir.trim_end_matches('/');
            let full_path = if clean_dir.is_empty() {
                format!("/{}", file_name)
            } else {
                format!("{}/{}", clean_dir, file_name)
            };

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

    pub fn upload_local_file(
        sess_arc: Arc<Mutex<Session>>,
        local_path: &str,
        remote_path: &str,
    ) -> Result<(), String> {
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;

            let mut local_file = std::fs::File::open(Path::new(local_path))
                .map_err(|e| format!("打开本地待上传文件失败 ({}): {}", local_path, e))?;

            let mut remote_file = sftp
                .create(Path::new(remote_path))
                .map_err(|e| format!("创建远程目标文件失败 ({}): {}", remote_path, e))?;

            let mut buf = [0u8; 16384];
            loop {
                match local_file.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        remote_file
                            .write_all(&buf[..n])
                            .map_err(|e| format!("写入远程目标文件失败: {}", e))?;
                    }
                    Err(e) => return Err(format!("读取本地文件数据中断: {}", e)),
                }
            }

            remote_file
                .flush()
                .map_err(|e| format!("刷新远程文件写入失败: {}", e))?;

            Ok(())
        })();
        sess.set_blocking(false);
        res
    }

    pub fn download_to_downloads_dir(
        sess_arc: Arc<Mutex<Session>>,
        remote_path: &str,
    ) -> Result<String, String> {
        let sess = sess_arc.lock().unwrap();
        sess.set_blocking(true);
        let res = (|| {
            let sftp = sess
                .sftp()
                .map_err(|e| format!("初始化 SFTP 失败: {}", e))?;

            let remote_path_buf = Path::new(remote_path);
            let file_name = remote_path_buf
                .file_name()
                .ok_or_else(|| "无效的文件名".to_string())?
                .to_string_lossy();

            let mut remote_file = sftp
                .open(remote_path_buf)
                .map_err(|e| format!("打开远程文件失败: {}", e))?;

            let downloads_dir = std::env::var("HOME")
                .map(|h| std::path::PathBuf::from(h).join("Downloads"))
                .unwrap_or_else(|_| {
                    if cfg!(target_os = "windows") {
                        std::env::var("USERPROFILE")
                            .map(|p| std::path::PathBuf::from(p).join("Downloads"))
                            .unwrap_or_else(|_| std::path::PathBuf::from("."))
                    } else {
                        std::path::PathBuf::from(".")
                    }
                });

            if !downloads_dir.exists() {
                let _ = std::fs::create_dir_all(&downloads_dir);
            }

            let mut local_dest = downloads_dir.join(file_name.as_ref());
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

            let mut buf = [0u8; 16384];
            loop {
                match remote_file.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        local_file
                            .write_all(&buf[..n])
                            .map_err(|e| format!("写入本地文件失败: {}", e))?;
                    }
                    Err(e) => return Err(format!("下载传输中断: {}", e)),
                }
            }

            Ok(local_dest.to_string_lossy().to_string())
        })();
        sess.set_blocking(false);
        res
    }
}
