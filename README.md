# AI Terminal (AI SSH Client)

跨平台 AI SSH 终端：一个以高品质 Terminal 为核心、内置 AI Agent 的服务器管理客户端。

项目融合了 **阿里云 WebSSH 的终端手感**、**Claude Code / Cursor 级 Agent 运维能力** 与 **Termius / Xshell 级服务器管理体验**。

---

## 核心特性

### 1. 阿里云 WebSSH 级终端手感
- **GPU 硬件加速**：基于 xterm.js 与 WebGL 渲染插件，保障万行高频日志、top/htop 与编译输出流畅无丢帧。
- **严格字符等宽**：严格采用等宽字体栈（JetBrains Mono、SF Mono、Cascadia Mono、Menlo、Monaco、Consolas），字符间距设为 0，彻底消除表格、ASCII 字符与 vim 分屏错位。
- **专业终端配色与排版**：行高固定为 1.42（14px 字号 / 20px 行高），采用深灰黑低对比背景（#12131b）与柔和浅灰文字（#d4d4d8），低饱和 ANSI 语法高亮。
- **极低输入延迟**：键盘输入通过 xterm 的 `onData` 直接穿透至 Rust 后端通道，完全绕开前端状态分发层。
- **双向流式通道**：基于 Tauri 2 的 Channel 机制，本地 PTY 与远程 SSH 字节流直灌终端缓冲区。

### 2. 服务器连接与会话管理
- **本地虚拟终端**：集成 portable-pty，支持一键启动系统原生 Shell（zsh 或 bash）。
- **全功能 SSH 认证**：支持标准 SSH 密码认证、私钥文件路径认证、私钥明文内容认证、Passphrase 解密以及本地 SSH Agent。
- **多 Tab 并发会话**：支持同时打开多个本地与远程终端会话，切换标签页无缝保留前后端缓冲区。
- **分组与检索**：支持对主机进行自定义分组、标签分类与实时快速检索。
- **SFTP 文件管理抽屉**：支持远程目录树遍历、文件查看、在线编辑与覆写保存。
- **本地持久化**：使用 SQLite 本地数据库保存服务器列表与系统设置，无第三方云端依赖，数据安全可控。

### 3. AI Agent 智能运维体系
- **OpenAI 兼容协议**：支持 DeepSeek（deepseek-chat / deepseek-reasoner）、OpenAI（gpt-4o）、Ollama、vLLM 及各类自定义兼容网关。
- **闭环工具系统**：
  - `terminal_exec`：在活动主机执行 Shell 命令并实时捕获退出码、stdout 与 stderr。
  - `file_read`：读取指定远程文件内容。
  - `file_write`：修改或覆盖远程配置文件。
  - `file_list`：列出指定目录下的文件与目录详情。
  - `system_info`：一键获取远程主机的 OS 版本、运行时间与资源状态。
- **三档安全权限控制**：
  - 只读模式（read_only）：禁止执行任何修改命令与文件写入。
  - 需确认模式（ask，默认）：每步关键操作在面板中生成独立的单步审批卡片，由用户决定 [允许执行] 或 [拒绝]。
  - 全权授权模式（full）：自主执行全量诊断与运维计划。
- **高危命令拦截器**：内置静态语法模式匹配，针对 `rm -rf /`、`mkfs`、`dd`、`reboot`、`shutdown`、`iptables -F` 等破坏性指令强制弹窗拦截。

---

## 技术架构

```text
+-------------------------------------------------------------+
|                        AI Terminal                          |
|                                                             |
| 前端展现层 (React 19 + TypeScript + Vite + Tailwind CSS v4) |
| - 服务器管理侧栏 (ServerSidebar)                            |
| - 高品质终端渲染 (XTerminal + xterm.js + WebGL)              |
| - AI 运维智能体面板 (AgentPanel)                            |
| - SFTP 文件管理抽屉 (FileManagerDrawer)                     |
| - 状态持久化 (Zustand)                                      |
|                                                             |
| 桌面通信层 (Tauri 2 IPC + Channel Streaming)                |
|                                                             |
| 核心后端层 (Rust 1.98.1 + Tokio)                            |
| - 本地 PTY 驱动器 (portable-pty)                            |
| - 异步 SSH 引擎 (ssh2)                                      |
| - SFTP 传输管理 (sftp)                                      |
| - 本地持久存储 (rusqlite / SQLite)                          |
| - 危险命令检测拦截器 (safety)                               |
| - AI API 连通适配器 (agent)                                 |
+-------------------------------------------------------------+
```

---

## 环境准备

编译与运行本项目前，请确保操作系统已安装以下环境：

1. **Node.js**：版本 >= 18（推荐 v20 或 v24）
2. **包管理器**：npm（推荐）、pnpm 或 yarn
3. **Rust 工具链**：版本 >= 1.77.2（推荐使用 rustup 安装 stable 工具链）
4. **系统原生依赖**：
   - **macOS**：需安装 Xcode Command Line Tools（运行 `xcode-select --install`）
   - **Linux**：需安装 webkit2gtk、libssl-dev、libgtk-3-dev 等 Tauri 编译依赖
   - **Windows**：需安装 Microsoft Visual Studio C++ 生成工具与 WebView2

---

## 编译与运行指南

### 1. 安装项目依赖

在项目根目录下执行以下命令安装前端依赖包：

```bash
npm install
```

### 2. 本地开发调试

#### 启动完整的 Tauri 桌面端开发环境（推荐）

该命令将同时启动 Vite 前端服务并唤起原生桌面窗口：

```bash
npm run tauri dev
```

#### 仅启动前端浏览器预览

仅调试页面样式与布局时使用：

```bash
npm run dev
```

启动后可在浏览器中访问 `http://localhost:5173` 进行界面预览。

### 3. 运行自动化测试

#### 运行 Rust 后端单元测试

测试覆盖高危指令拦截规则与 SQLite 数据持久化逻辑：

```bash
cd src-tauri
cargo test
```

#### 运行前端构建检查

验证 TypeScript 类型定义与生产包打包情况：

```bash
npm run build
```

### 4. 发布与打包构建

执行以下命令生成针对当前操作系统的生产环境桌面安装包：

```bash
npm run tauri build
```

构建产物将输出至：
- **macOS**：`src-tauri/target/release/bundle/dmg/` 或 `src-tauri/target/release/bundle/macos/`
- **Linux**：`src-tauri/target/release/bundle/deb/` 或 `src-tauri/target/release/bundle/appimage/`
- **Windows**：`src-tauri/target/release/bundle/nsis/` 或 `src-tauri/target/release/bundle/msi/`

---

## 项目目录结构

```text
ai-terminal/
├── src/                            # 前端源码
│   ├── components/
│   │   ├── agent/                  # AI 运维智能体组件
│   │   │   └── AgentPanel.tsx
│   │   ├── layout/                 # 布局组件（标题栏、底部状态栏）
│   │   │   ├── StatusBar.tsx
│   │   │   └── TitleBar.tsx
│   │   ├── modals/                 # 业务配置弹窗
│   │   │   ├── ServerModal.tsx     # 主机配置弹窗
│   │   │   └── SettingsModal.tsx   # AI 供应商与系统设置弹窗
│   │   ├── servers/                # 服务器侧边栏组件
│   │   │   └── ServerSidebar.tsx
│   │   ├── sftp/                   # SFTP 远程文件管理抽屉
│   │   │   └── FileManagerDrawer.tsx
│   │   └── terminal/               # xterm.js WebGL 终端核心组件
│   │       └── XTerminal.tsx
│   ├── lib/
│   │   └── agent/                  # AI 工具定义与调用调度器
│   │       ├── runner.ts
│   │       └── tools.ts
│   ├── stores/                     # Zustand 全局状态管理
│   │   ├── useAgentStore.ts
│   │   ├── useServerStore.ts
│   │   ├── useSettingsStore.ts
│   │   └── useTerminalStore.ts
│   ├── types/                      # TypeScript 类型定义
│   │   ├── index.ts
│   │   └── tauri.d.ts
│   ├── App.tsx                     # 根组件
│   ├── index.css                   # 全局样式与终端等宽字体规则
│   └── main.tsx                    # 前端入口
├── src-tauri/                      # Tauri 2 后端源码 (Rust)
│   ├── capabilities/               # 应用权限配置
│   │   └── default.json
│   ├── src/
│   │   ├── agent.rs                # AI 服务与连通性测试模块
│   │   ├── lib.rs                  # Tauri 命令注册中心
│   │   ├── main.rs                 # 桌面应用入口
│   │   ├── pty.rs                  # 本地虚拟 PTY 驱动器
│   │   ├── safety.rs               # 危险命令拦截器与测试用例
│   │   ├── sftp.rs                 # SFTP 远程文件系统交互
│   │   ├── ssh.rs                  # SSH2 客户端、交互会话与命令同步执行
│   │   └── storage.rs              # SQLite 数据库持久化与测试用例
│   ├── Cargo.toml                  # Rust 依赖声明
│   └── tauri.conf.json             # Tauri 桌面窗口与打包配置
├── prototype.html                  # 1:1 高保真前端原型页面
├── package.json                    # 前端依赖与脚本声明
├── tsconfig.json                   # TypeScript 配置
├── vite.config.ts                  # Vite 与 Tailwind 插件配置
└── 需求.md                         # 初始产品需求与架构设计方案
```

---

## 使用说明

1. **添加主机**：点击顶部导航栏的 [添加主机] 按钮，录入主机名称、IP、端口、用户名，选择私钥文件认证或密码认证。
2. **连接终端**：双击左侧主机列表项即可打开远程 SSH 终端，或点击常用分组中的 [本地 Shell] 开启本地终端。
3. **配置 AI 智能体**：点击右上角设置齿轮图标，选择提供商（如 DeepSeek），填入 API Base URL 与 API Key 并保存。
4. **智能排障与运维**：在右侧 AI 面板中输入运维任务（例如：“检查 80 端口占用情况与防火墙规则”），Agent 将自主规划步骤、调用工具并展示执行结果。
5. **权限保护**：在需确认模式下，涉及服务器变更的命令均需用户点击 [允许执行] 确认后方可落地。
