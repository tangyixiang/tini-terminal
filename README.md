# Tini Terminal

一个跨平台、极简高效且内置 AI Agent 的 SSH 终端工具。融合专业级 WebGL 终端渲染、本地与远程服务器管理以及大模型智能运维能力。

---

## 主要特性

- **硬件加速终端**：基于 xterm.js 与 WebGL 渲染插件，严格字符等宽与专业终端色彩，高频日志输出与全屏 CLI 工具（top/htop/vim）流畅无丢帧。
- **本地与远程会话管理**：支持一键启动系统原生 Shell（PTY），支持 SSH 密码、私钥（路径或明文）、Passphrase 与本地 Agent 认证，多 Tab 会话秒级切换与状态保留。
- **AI Agent 智能运维**：兼容 DeepSeek、OpenAI、Ollama 与各类兼容网关，自主规划排障步骤，支持 Shell 命令执行、远程文件读写与系统状态诊断。
- **三档安全拦截机制**：内置只读（read_only）、需确认（ask，默认）与全权（full）三档策略，对 `rm -rf /`、`mkfs`、`reboot` 等高危破坏性指令进行静态语法匹配与强制弹窗拦截。
- **SFTP 远程文件管理**：侧边抽屉式文件管理器，支持远程目录树浏览、文件在线查看与编辑覆写保存。
- **纯本地持久化**：使用本地 SQLite 存储主机配置、标签分组与使用偏好，数据不经过任何第三方云端，私密可控。

---

## 技术架构

```text
+-------------------------------------------------------------+
|                        Tini Terminal                        |
|                                                             |
| 前端交互层 (React 19 + TypeScript + Tailwind CSS v4 + Vite) |
| - 服务器管理与分组导航 (ServerSidebar)                      |
| - WebGL 硬件加速终端 (XTerminal + xterm.js)                 |
| - AI 运维智能体面板 (AgentPanel + ToolRunner)               |
| - SFTP 远程文件管理抽屉 (FileManagerDrawer)                 |
| - 全局响应式状态管理 (Zustand)                              |
|                                                             |
| 桌面通信层 (Tauri 2 IPC Command & Channel Streaming)        |
|                                                             |
| 核心后端层 (Rust 2021 + Tokio)                              |
| - 本地 PTY 会话驱动器 (portable-pty)                        |
| - 异步 SSH2 / SFTP 传输核心 (ssh2)                          |
| - 本地持久化存储引擎 (rusqlite / SQLite)                    |
| - 高危指令语法分析与拦截器 (safety / regex)                 |
| - AI API 协议适配与连通性检测 (agent / reqwest)              |
+-------------------------------------------------------------+
```

---

## 下载与安装

### 预编译安装包

前往项目的 [Releases 页面](https://github.com/tangyixiang/tini-terminal/releases) 下载对应操作系统的安装包：

- **macOS**：`.dmg`（支持 Apple Silicon M 系列与 Intel 架构）
- **Windows**：`.exe`（基于 NSIS 架构打包）
- **Linux**：`.deb`（支持 Debian / Ubuntu 系发行版）

### macOS 用户安装注意

因开源个人构建未加入商业付费开发者证书签名，若在 macOS 打开应用时提示 **“文件已损坏，您应该将它移到废纸篓”**，此为系统 Gatekeeper 安全拦截机制所致。

请在终端中执行以下命令清除下载隔离属性即可正常使用：

```bash
xattr -cr /Applications/tini-terminal.app
```

---

## 开发与编译

### 前置环境

- [Node.js](https://nodejs.org/)（版本 >= 18.0，推荐 v20+）
- [Rust 工具链](https://rustup.rs/)（版本 >= 1.77.2，推荐 stable 分支）
- [Cargo](https://doc.rust-lang.org/cargo/) 包管理器
- 系统依赖（Linux 环境需安装 `libwebkit2gtk-4.1-dev`、`libssl-dev`、`libgtk-3-dev` 等原生库；macOS 需安装 Command Line Tools）

### 1. 安装项目依赖

```bash
npm install
```

### 2. 桌面端本地开发调试

启动桌面端开发模式（自动启动 Vite 服务并唤起 Tauri 原生桌面窗口）：

```bash
npm run tauri dev
```

如仅需启动前端浏览器页面调试：

```bash
npm run dev
```

### 3. 构建发布安装包

构建当前平台专属的最终发布包（产物位于 `src-tauri/target/release/bundle/`）：

```bash
npm run tauri build
```

如需在 macOS 上打包通用双架构（Universal Binary）安装包：

```bash
npm run tauri build -- --target universal-apple-darwin
```

### 4. 代码规范与测试

```bash
# 运行 Rust 后端单元测试（覆盖高危指令拦截与 SQLite 持久化）
cargo test --manifest-path src-tauri/Cargo.toml

# 运行前端代码规范检查
npm run lint

# 验证 TypeScript 类型与前端打包
npm run build
```

---

## 快捷键与操作说明

| 快捷键 / 操作 | 功能描述 |
| :--- | :--- |
| `Ctrl + Shift + C` / `Cmd + Shift + C` | 复制终端内当前选中文本 |
| `Ctrl + Shift + V` / `Cmd + Shift + V` | 粘贴剪贴板内容到当前活动终端 |
| `Enter`（AI 输入框） | 发送运维提示词并触发 Agent 执行 |
| `Shift + Enter`（AI 输入框） | 在 AI 提示词输入框中换行 |
| `双击主机列表项` | 快速连接并打开目标主机终端会话 |
| `二级标签栏操作项` | 清屏、一键复制终端完整输出或重试连接 |
| `侧边栏 SFTP 按钮` | 呼出当前主机远程文件管理抽屉 |
| `拖拽分栏分隔线` | 自由调整服务器列表栏与 AI 面板宽度 |

---

## 目录结构

```text
tini-terminal/
├── .github/
│   └── workflows/
│       └── release.yml         # 多平台自动化构建打包 GitHub Action 工作流
├── src/                        # 前端工程源码 (React 19 + TypeScript + Tailwind CSS v4)
│   ├── components/             # 界面核心组件
│   │   ├── agent/              # AI 智能体面板、微型控制台与输出渲染
│   │   ├── layout/             # 窗口自定义标题栏与底部状态栏
│   │   ├── modals/             # 主机配置弹窗与系统设置弹窗
│   │   ├── servers/            # 服务器侧栏、分组与检索视图
│   │   ├── sftp/               # 远程文件管理抽屉与文本编辑器
│   │   ├── terminal/           # WebGL 终端渲染、会话驱动与输入流管理
│   │   └── workspace/          # 运维工作区与上下文面板
│   ├── lib/                    # AI 工具执行调度器与工具集封装
│   ├── stores/                 # Zustand 状态管理 (主机、终端、配置、智能体)
│   ├── types/                  # 全局 TypeScript 类型与 Tauri API 声明
│   ├── App.tsx                 # 前端根组件
│   ├── index.css               # 全局样式与终端等宽字体规则
│   └── main.tsx                # 前端入口文件
├── src-tauri/                  # Tauri 2 原生桌面端核心 (Rust 2021)
│   ├── capabilities/           # 窗口与原生功能权限配置
│   ├── src/                    # Rust 后端源码
│   │   ├── agent.rs            # AI 服务适配与网络连通性
│   │   ├── lib.rs              # Tauri IPC 命令注册中心
│   │   ├── main.rs             # 桌面程序入口
│   │   ├── pty.rs              # 本地虚拟 PTY 驱动器
│   │   ├── safety.rs           # 危险命令静态拦截器
│   │   ├── sftp.rs             # SFTP 远程文件传输与读写
│   │   ├── ssh.rs              # 异步 SSH2 客户端会话驱动
│   │   ├── storage.rs          # 本地 SQLite 数据持久化
│   │   ├── session/            # 会话生命周期与工作目录追踪
│   │   ├── task/               # 异步执行任务管理器
│   │   └── workspace/          # 运维工作区与上下文数据模型
│   ├── Cargo.toml              # 后端 Rust 依赖清单
│   └── tauri.conf.json         # 桌面窗口、资源与多平台打包配置
├── dist/                       # 前端静态资源构建输出目录
├── index.html                  # HTML 宿主入口
├── vite.config.ts              # Vite 与样式插件配置
└── package.json                # 前端依赖与构建脚本配置
```

---

## 开源协议

本项目基于 MIT 协议 开源。
