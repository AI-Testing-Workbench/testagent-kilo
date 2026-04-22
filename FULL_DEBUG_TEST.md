# 完整的 EditorContext 调试测试

## 准备工作

### 1. 重新编译 CLI

```bash
cd packages/testagent-opencode/packages/opencode
bun run build
```

### 2. 复制二进制文件到扩展

```bash
# macOS/Linux
cp packages/testagent-opencode/packages/opencode/dist/testagent packages/kilo-vscode/bin/testagent

# Windows
# cp packages/testagent-opencode/packages/opencode/dist/testagent.exe packages/kilo-vscode/bin/testagent.exe
```

### 3. 启动扩展开发模式

```bash
cd packages/kilo-vscode
bun run extension
```

---

## 测试步骤

### 步骤 1: 打开开发者工具

在新打开的 VS Code 窗口（Extension Development Host）中：

1. 按 `Cmd+Shift+P` (macOS) 或 `Ctrl+Shift+P` (Windows/Linux)
2. 输入 "Developer: Toggle Developer Tools"
3. 切换到 **Console** 标签

### 步骤 2: 查看 CLI 日志

同时打开 CLI 的输出：

1. 在扩展开发窗口中，点击 `View` → `Output`
2. 在下拉菜单中选择 "TestAgent" 或 "Kilo"

### 步骤 3: 打开测试文件

在扩展开发窗口中打开几个文件：

- README.md
- package.json
- 任何 .ts 或 .js 文件

确保至少有一个文件是激活状态（当前编辑的文件）。

### 步骤 4: 发送测试消息

在 Kilo 聊天面板中输入：

```
你好
```

---

## 预期日志输出

### 客户端日志（开发者工具 Console）

你应该看到：

```
[TestAgent] 🎯 gatherEditorContext called
[TestAgent] 📁 Workspace directory: /Users/xxx/your-project
[TestAgent] 👀 Visible files: ["README.md", "package.json"]
[TestAgent] 📑 Open tabs: ["README.md", "package.json", "src/index.ts"]
[TestAgent] ✏️ Active file: "README.md"
[TestAgent] 🐚 Shell: "/bin/zsh"
[TestAgent] 📦 Final EditorContext: {
  "visibleFiles": ["README.md", "package.json"],
  "openTabs": ["README.md", "package.json", "src/index.ts"],
  "activeFile": "README.md",
  "shell": "/bin/zsh"
}
[TestAgent] 🔍 EditorContext collected: {
  "visibleFiles": ["README.md", "package.json"],
  "openTabs": ["README.md", "package.json", "src/index.ts"],
  "activeFile": "README.md",
  "shell": "/bin/zsh"
}
```

### 服务端日志（Output 面板 → TestAgent）

你应该看到：

```
[TestAgent CLI] 📥 Received PromptInput:
[TestAgent CLI] 📦 editorContext: {
  "visibleFiles": ["README.md", "package.json"],
  "openTabs": ["README.md", "package.json", "src/index.ts"],
  "activeFile": "README.md",
  "shell": "/bin/zsh"
}
[TestAgent CLI] 💾 Created UserMessage with editorContext: {
  "visibleFiles": ["README.md", "package.json"],
  "openTabs": ["README.md", "package.json", "src/index.ts"],
  "activeFile": "README.md",
  "shell": "/bin/zsh"
}
[TestAgent CLI] 🔄 Processing editorContext for prompt generation
[TestAgent CLI] 📋 lastUser.editorContext: {
  "visibleFiles": ["README.md", "package.json"],
  "openTabs": ["README.md", "package.json", "src/index.ts"],
  "activeFile": "README.md",
  "shell": "/bin/zsh"
}
[TestAgent CLI] 🌐 environmentDetails called with: {
  "visibleFiles": ["README.md", "package.json"],
  "openTabs": ["README.md", "package.json", "src/index.ts"],
  "activeFile": "README.md",
  "shell": "/bin/zsh"
}
[TestAgent CLI] 📝 environmentDetails result: <environment_details>
Current time: 2026-04-21T14:30:45+08:00
Active file: README.md
Visible files:
  README.md
  package.json
Open tabs:
  README.md
  package.json
  src/index.ts
</environment_details>
[TestAgent CLI] ✅ Injecting environment block into user message at index: 0
[TestAgent CLI] 🌍 SystemPrompt.environment called
[TestAgent CLI] 📦 editorContext: {
  "visibleFiles": ["README.md", "package.json"],
  "openTabs": ["README.md", "package.json", "src/index.ts"],
  "activeFile": "README.md",
  "shell": "/bin/zsh"
}
[TestAgent CLI] 🔧 staticEnvLines called with: {
  "visibleFiles": ["README.md", "package.json"],
  "openTabs": ["README.md", "package.json", "src/index.ts"],
  "activeFile": "README.md",
  "shell": "/bin/zsh"
}
[TestAgent CLI] 📋 staticEnvLines result: ["  Default shell: /bin/zsh"]
[TestAgent CLI] 📄 Generated system prompt (first 500 chars): You are powered by...
```

---

## 故障排查

### 问题 1: 客户端没有日志

**症状**: 开发者工具 Console 中看不到任何 `[TestAgent]` 日志

**可能原因**:

1. 在错误的窗口查看（应该在扩展开发窗口）
2. 扩展未正确加载
3. 代码未重新编译

**解决方案**:

```bash
# 停止扩展开发窗口
# 重新编译和启动
cd packages/kilo-vscode
rm -rf dist
bun run extension
```

### 问题 2: 客户端有日志但服务端没有

**症状**:

- ✅ 看到客户端日志（gatherEditorContext）
- ❌ 看不到服务端日志（CLI）

**可能原因**:

1. CLI 未重新编译
2. 使用了旧的二进制文件
3. CLI 日志级别设置过滤了 console.log

**解决方案**:

```bash
# 1. 重新编译 CLI
cd packages/testagent-opencode/packages/opencode
bun run build

# 2. 确认二进制文件已更新
ls -lh packages/kilo-vscode/bin/testagent

# 3. 复制新的二进制文件
cp packages/testagent-opencode/packages/opencode/dist/testagent packages/kilo-vscode/bin/testagent

# 4. 重启扩展
```

### 问题 3: editorContext 为空对象 {}

**症状**: 日志显示 `editorContext: {}`

**可能原因**:

1. 没有打开任何文件
2. 打开的文件被 .kilocodeignore 过滤
3. workspaceDir 为空

**解决方案**:

1. 确保打开至少一个普通文件（.md, .ts, .js 等）
2. 检查 .kilocodeignore 文件
3. 确认在一个有效的工作区中

### 问题 4: 有日志但 AI 不识别

**症状**:

- ✅ 客户端和服务端都有完整日志
- ✅ editorContext 数据正确
- ❌ AI 回答时不知道当前文件

**可能原因**:

1. 环境详情未正确注入到提示词
2. LLM 忽略了环境详情
3. 提示词格式问题

**调试步骤**:

1. 检查是否看到 "✅ Injecting environment block" 日志
2. 检查 "environmentDetails result" 的内容
3. 测试更明确的问题，例如："我现在打开了哪些文件？"

---

## 验证清单

使用这个清单确认每个步骤都正常：

### 客户端（VS Code 扩展）

- [ ] 看到 "🎯 gatherEditorContext called"
- [ ] 看到 "📁 Workspace directory"
- [ ] 看到 "👀 Visible files" 有内容
- [ ] 看到 "📑 Open tabs" 有内容
- [ ] 看到 "✏️ Active file" 有内容
- [ ] 看到 "🐚 Shell" 有内容
- [ ] 看到 "📦 Final EditorContext" 完整对象

### 服务端（CLI）

- [ ] 看到 "📥 Received PromptInput"
- [ ] 看到 "📦 editorContext" 完整对象
- [ ] 看到 "💾 Created UserMessage with editorContext"
- [ ] 看到 "🔄 Processing editorContext for prompt generation"
- [ ] 看到 "🌐 environmentDetails called"
- [ ] 看到 "📝 environmentDetails result" 完整 XML
- [ ] 看到 "✅ Injecting environment block"
- [ ] 看到 "🌍 SystemPrompt.environment called"
- [ ] 看到 "🔧 staticEnvLines called"
- [ ] 看到 "📋 staticEnvLines result" 包含 shell

### AI 行为

- [ ] AI 能识别当前激活的文件
- [ ] AI 能列出可见的文件
- [ ] AI 能列出打开的标签页
- [ ] AI 知道默认 shell

---

## 成功示例

### 测试对话 1: 当前文件识别

**用户**: "这个文件是做什么的？"

**AI（成功）**: "根据你当前打开的 README.md 文件，这是项目的说明文档..."

**AI（失败）**: "请问你指的是哪个文件？"

### 测试对话 2: 文件列表

**用户**: "我现在打开了哪些文件？"

**AI（成功）**: "根据你的编辑器状态，你当前打开了以下文件：

- README.md（当前激活）
- package.json
- src/index.ts"

**AI（失败）**: "我无法看到你打开的文件。"

### 测试对话 3: Shell 信息

**用户**: "我的默认 shell 是什么？"

**AI（成功）**: "你的默认 shell 是 /bin/zsh"

**AI（失败）**: "我不知道你的 shell 配置。"

---

## 下一步

如果所有日志都正常但 AI 仍然不识别：

1. **检查提示词**: 查看发送给 LLM 的完整提示词
2. **测试不同模型**: 某些模型可能更好地理解环境详情
3. **调整提示词格式**: 可能需要更明确的指示

如果日志不完整：

1. **贴出你看到的日志**: 把客户端和服务端的日志都贴出来
2. **检查编译**: 确认 CLI 已重新编译
3. **验证二进制**: 确认使用的是新编译的二进制文件

---

**准备好了吗？开始测试吧！** 🚀

把你看到的日志（客户端和服务端）都贴给我，我会帮你分析！
