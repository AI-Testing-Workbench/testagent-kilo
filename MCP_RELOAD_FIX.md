# MCP Reload 后 Settings Panel 的 config.mcp 未更新 - 问题修复总结

## 问题描述

调用 MCP reload 后，Settings panel 中的 `config().mcp` 显示的仍是旧值，没有反映最新配置。

## 根本原因

**架构问题：多个 KiloProvider 实例各自独立**

```
┌─────────────────────────────────────────────────────────────┐
│                      extension.ts                            │
│                                                              │
│  ┌─────────────────┐         ┌─────────────────────────┐   │
│  │ sidebar provider │         │ settingsEditorProvider  │   │
│  │ (KiloProvider)   │         │ (SettingsEditorProvider) │   │
│  │                 │         │                          │   │
│  │  webview: sidebar│         │  ┌────────────────────┐  │   │
│  └─────────────────┘         │  │ settings provider  │  │   │
│                              │  │ (KiloProvider)     │  │   │
│                              │  │                    │  │   │
│                              │  │ webview: settings  │  │   │
│                              │  └────────────────────┘  │   │
│                              └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**问题链路**：

1. `testagent.new.reloadMcp` 命令只调用了 **sidebar provider** 的 `reloadMcp()`
2. sidebar provider 调用 `fetchAndSendConfig(true)` 发送 `configLoaded` 消息
3. 该消息通过 `postMessage()` 发送到 **sidebar webview**
4. **Settings panel 有自己独立的 KiloProvider 实例**，其 webview 从未收到 `configLoaded` 消息
5. Settings panel 的 `config` signal 没有更新，UI 显示旧值

## 关键代码位置

**extension.ts 第 267-279 行（修复前）**：
```typescript
vscode.commands.registerCommand("testagent.new.reloadMcp", async () => {
  await provider.reloadMcp()  // 只调用了 sidebar provider
})
```

**SettingsEditorProvider.ts 第 113 行**：
```typescript
// Settings panel 创建了独立的 KiloProvider 实例
const provider = new KiloProvider(this.extensionUri, this.connectionService, this.context, {
  projectDirectory,
})
```

## 修复方案

### 1. SettingsEditorProvider.ts - 添加 `reloadMcp()` 方法

通知所有 panel providers 进行 MCP reload：

```typescript
async reloadMcp(): Promise<void> {
  await Promise.all(
    Array.from(this.providers.values()).map((provider) => provider.reloadMcp())
  )
}
```

### 2. extension.ts - 同时调用所有 providers

```typescript
vscode.commands.registerCommand("testagent.new.reloadMcp", async () => {
  await Promise.all([
    provider.reloadMcp(),
    settingsEditorProvider.reloadMcp(),
  ])
})
```

### 3. messages.ts - 添加 `refresh` 标志

确保前端丢弃 draft 使用最新配置：

```typescript
export interface ConfigLoadedMessage {
  type: "configLoaded"
  config: Config
  refresh?: boolean  // 新增：标识这是 MCP reload 刷新，需丢弃 draft
}
```

### 4. KiloProvider.ts - fetchAndSendConfig 支持 refresh 参数

```typescript
private async fetchAndSendConfig(refresh = false): Promise<void> {
  // ...
  const message: { type: "configLoaded"; config: unknown; refresh?: boolean } = {
    type: "configLoaded",
    config,
  }
  if (refresh) message.refresh = true
  // ...
}
```

### 5. config.tsx - 处理 refresh 标志

```typescript
if (message.refresh) {
  setDraft({})
  setIsDirty(false)
  setConfig(message.config)
  setSaved(message.config)
  setLoading(false)
  return
}
```

## 涉及文件

| 文件 | 修改内容 |
|------|----------|
| `packages/kilo-vscode/src/extension.ts` | reload 命令同时通知所有 providers |
| `packages/kilo-vscode/src/SettingsEditorProvider.ts` | 添加 reloadMcp() 方法 |
| `packages/kilo-vscode/src/KiloProvider.ts` | fetchAndSendConfig 支持 refresh 参数 |
| `packages/kilo-vscode/webview-ui/src/types/messages.ts` | ConfigLoadedMessage 添加 refresh 字段 |
| `packages/kilo-vscode/webview-ui/src/context/config.tsx` | 处理 refresh 标志，丢弃 draft |

## 教训

1. **多 webview 架构需要注意消息广播** - 每个 KiloProvider 实例对应独立的 webview，消息不会自动广播到所有 webview
2. **全局命令需要通知所有相关组件** - 当有多个独立实例时，全局操作需要遍历所有实例
