# TestAgent

TestAgent 是一个 AI 辅助测试助手，帮助你分析测试项目、梳理测试点、生成自动化测试脚本，同时支持自定义插件扩展功能。

---

## 快速开始

### 1. 初始化项目

```bash
# 克隆仓库并初始化子模块
git clone <repository-url>
cd testagent-kilo
git submodule update --init --recursive

# 安装依赖
bun install
bun install --cwd packages/testagent-core
```

### 2. 启动开发环境

在项目根目录执行：

```bash
bun run extension
```

该命令会自动完成：
1. 构建 CLI 二进制文件（`packages/testagent-core` → `packages/kilo-vscode/bin/`）
2. 构建 VS Code 扩展（extension + webview + Agent Manager）
3. 启动 VS Code 开发模式并加载扩展

**跳过 CLI 构建**（当二进制文件已存在时）：
```bash
bun run extension --no-build
```

---

## 打包 VSIX 插件

### 打包 Node.js 运行时版本（推荐）

#### 步骤 1：生成 SDK（首次或 API 变更时）

```bash
cd packages/kilo-vscode
bun run rebuild-sdk
```

> 💡 **提示**：SDK 只需生成一次，后续打包无需重复执行，除非 API 发生变更。

#### 步骤 2：构建 CLI 二进制文件

**macOS / Linux:**
```bash
cd packages/testagent-core
bun run bun:mac
```

**Windows:**
```bash
cd packages/testagent-core
bun run bun:windows
```

#### 步骤 3：打包 VSIX

```bash
cd packages/kilo-vscode
bun run testagent-nodejs:vsix
```

生成的 VSIX 文件位于 `packages/kilo-vscode/` 目录下。

---

## 项目结构

```
testagent-kilo/
├── packages/
│   ├── testagent-core/      # CLI 核心代码（子模块）
│   ├── kilo-vscode/          # VS Code 扩展
│   ├── opencode-mocker/      # Mock 工具（子模块）
│   └── ...
└── README.md
```

---

## 常见问题

### Q: 如何更新子模块？
```bash
git submodule update --remote --merge
```

### Q: 如何清理构建产物？
```bash
# 清理 CLI 构建
cd packages/testagent-core && bun run clean

# 清理扩展构建
cd packages/kilo-vscode && bun run clean
```

### Q: 开发时修改了 CLI 代码，如何重新构建？
```bash
# 方式 1：使用 extension 命令（推荐）
bun run extension

# 方式 2：手动构建
cd packages/testagent-core
bun run bun:mac  # 或 bun:windows
```

---

## 开发工具

- **Bun**: 1.3.10+
- **Node.js**: 22+ (用于 Node.js 运行时版本)
- **VS Code**: 最新版本

---

## 许可证

MIT
