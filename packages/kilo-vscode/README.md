### TestAgent

TestAgent for TScode是一个开源 AI 编程代理，将 TestAgent CLI 直接集成到你的 VS Code 开发工作流中。


## 功能特性

### 侧边栏聊天界面

- 在 VS Code 侧边栏中直接与 TestAgent 对话
- 支持多会话管理，可同时运行多个独立会话
- Git 工作树隔离 — 每个会话可在独立 worktree 中工作，互不干扰
- 支持代码检查点与任务管理

### 编辑器内终端

- 点击编辑器标题栏按钮，快速打开 TestAgent 独立终端实例
- 每个终端使用随机端口，互不影响
- 关闭终端不影响扩展主服务

### 代码助手

- **内联自动补全**：支持 500+ AI 模型，包括 Claude (Anthropic)、Gemini、Grok、GPT、Codex、GLM 等
- **代码动作**：选中代码后右键或使用快捷键，快速执行生成提交信息、解释代码、修复代码、优化代码等操作
- **终端命令辅助**：在终端中可直接对命令进行解释、修复或生成

### 浏览器自动化

- 支持 Playwright MCP，可自动化浏览器操作
- 可在会话中直接控制浏览器进行测试或数据采集

### 自定义模式与规则

- 支持自定义 Agent 模式（Plan、Code、Debug 等）
- 支持通过 rules 和 workflows 配置自动化规则
- 支持 Skills 系统，扩展 agent 能力
- 支持 MCP (Model Context Protocol) 服务器

## 快捷键

| 功能 | macOS | Windows / Linux |
|------|-------|-----------------|
| 打开 TestAgent 侧边栏 | `Cmd+Shift+O` | `Ctrl+Shift+O` |
| 新建会话 | `Cmd+Shift+N` | `Ctrl+Shift+N` |
| 聚焦聊天输入框 | `Cmd+Shift+I` | `Ctrl+Shift+I` |
| 插入文件引用 | `Cmd+Option+K` | `Alt+Ctrl+K` |
| 生成提交信息 | `Cmd+Shift+G` | `Ctrl+Shift+G` |
| 解释选中代码 | `Cmd+Shift+E` | `Ctrl+Shift+E` |
| 修复选中代码 | `Cmd+Shift+F` | `Ctrl+Shift+F` |
| 优化选中代码 | `Cmd+Shift+O` | `Ctrl+Shift+O` |
