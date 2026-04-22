# 编辑器上下文调试指南

## 步骤 1: 启动扩展

```bash
cd packages/kilo-vscode
bun run extension
```

## 步骤 2: 打开开发者工具

1. 在新窗口中按 `Cmd+Shift+P` (macOS) 或 `Ctrl+Shift+P` (Windows)
2. 输入 "Developer: Toggle Developer Tools"
3. 切换到 Console 标签

## 步骤 3: 打开测试文件

在新窗口中打开这些文件：

- README.md
- package.json
- 任何 .ts 或 .js 文件

## 步骤 4: 发送测试消息

在 Kilo 聊天中输入：

```
你好
```

## 步骤 5: 检查日志

### 应该看到的日志：

```
[TestAgent] 🎯 gatherEditorContext called
[TestAgent] 📁 Workspace directory: /path/to/your/project
[TestAgent] 👀 Visible files: [...]
[TestAgent] 📑 Open tabs: [...]
[TestAgent] ✏️ Active file: ...
[TestAgent] 🐚 Shell: ...
[TestAgent] 📦 Final EditorContext: {...}
[TestAgent] 🔍 EditorContext collected: {...}
```

### 如果看不到日志：

#### 检查 1: 是否在正确的窗口

- ✅ 应该在**扩展开发窗口**（新打开的窗口）
- ❌ 不是在原始 VS Code 窗口

#### 检查 2: 是否打开了文件

- 打开至少一个普通文件（.md, .ts, .js 等）
- 不要只打开设置或输出面板

#### 检查 3: 扩展是否正确加载

在开发者工具 Console 中输入：

```javascript
console.log("Test")
```

如果看到 "Test"，说明控制台工作正常。

#### 检查 4: 重新编译扩展

```bash
# 停止扩展开发窗口
# 在终端中
cd packages/kilo-vscode
rm -rf dist
bun run extension
```

## 步骤 6: 验证数据发送

如果看到了 EditorContext 日志，接下来验证是否发送到 CLI：

### 查看网络请求

在开发者工具的 Network 标签中：

1. 筛选 "prompt_async"
2. 查看请求的 Payload
3. 应该包含 `editorContext` 字段

### 示例 Payload：

```json
{
  "sessionID": "...",
  "parts": [...],
  "editorContext": {
    "visibleFiles": ["README.md"],
    "openTabs": ["README.md", "package.json"],
    "activeFile": "README.md",
    "shell": "/bin/zsh"
  }
}
```

## 故障排查

### 问题 1: 看不到任何日志

**原因**: 扩展未正确加载或在错误的窗口查看
**解决**:

1. 确认在扩展开发窗口（标题栏显示 "[Extension Development Host]"）
2. 重新启动扩展

### 问题 2: 日志显示但字段为空

**原因**: 没有打开文件或文件被过滤
**解决**:

1. 打开普通文件（不是设置、输出等）
2. 检查 .kilocodeignore 文件

### 问题 3: EditorContext 为空对象 {}

**原因**: 所有字段都被过滤或为空
**解决**:

1. 确保至少打开一个文件
2. 检查 workspaceDir 是否正确
3. 检查 shell 环境变量

### 问题 4: 有日志但 AI 不识别

**原因**: CLI 可能没有正确处理 editorContext
**解决**:

1. 确认 CLI 已重新编译
2. 检查 CLI 日志（Output 面板 → TestAgent）
3. 验证数据库中是否保存了 editorContext

## 成功标志

✅ 看到完整的 EditorContext 日志
✅ Network 请求包含 editorContext
✅ AI 能识别当前文件
✅ AI 能列出打开的文件

## 下一步

如果所有日志都正常，但 AI 仍然不识别：

1. 检查 CLI 是否正确处理（查看 CLI 日志）
2. 验证数据库存储
3. 检查提示词注入逻辑
