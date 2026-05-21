# S Space

一个 AI native 桌面产品 MVP：选择本地仓库，并在右侧可折叠终端里直接执行 CLI 任务。

## 技术栈

- Tauri v2
- Rust
- React + TypeScript
- xterm.js
- portable-pty

## 开发

```bash
npm install
npm run tauri dev
```

Rust 使用仓库内的 `rust-toolchain.toml` 自动选择 stable 工具链。Linux 开发机需要安装 Tauri 的系统依赖（WebKitGTK、GTK、rsvg 等）。

当前 MVP 能力：

1. 选择本地仓库目录。
2. 右侧终端 Tab 可展开/收起。
3. 终端以所选仓库为工作目录启动，可运行交互式 CLI。
4. 中间 App Content 区域保留，方便继续扩展仓库问答和 AI 工作流。
