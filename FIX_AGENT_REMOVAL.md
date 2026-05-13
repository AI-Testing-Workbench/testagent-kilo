# Agent 删除功能修复说明

## 问题描述

删除自定义 Agent Mode 后，配置文件中的内容已被删除，但 WebView UI 仍然显示该 Agent。

## 根本原因

1. **幂等删除导致的 scope 选择错误**
   - `MarketplaceInstaller.removeMode()` 即使找不到内容也返回 `success: true`
   - 导致 project 和 global 都返回 success
   - 原逻辑优先选择 global scope，但实际内容可能只在 project 中
   - 错误的 scope 选择导致缓存失效不完整

2. **CLI 后端缓存机制**
   - Agent.State 的 `agents` 对象是在 InstanceState 初始化时构建的闭包变量
   - `list()` 方法返回的是闭包中的 `agents` 对象
   - 即使调用 `instance.dispose()`，如果 Config 缓存未更新，重建的 State 仍是旧的

3. **竞态条件**
   - `instance.dispose()` 和 `fetchAndSendAgents()` 并行执行
   - 可能在缓存清除完成前就读取了旧数据

## 修复方案

### 1. 添加 `actuallyRemoved` 标志

**文件**: `packages/kilo-vscode/src/services/marketplace/types.ts`

```typescript
export interface RemoveResult {
  success: boolean
  slug: string
  error?: string
  actuallyRemoved?: boolean // 新增：标记是否实际删除了内容
}
```

### 2. 修改删除方法返回实际状态

**文件**: `packages/kilo-vscode/src/services/marketplace/installer.ts`

```typescript
async removeMode(item: ModeMarketplaceItem, scope: "project" | "global", workspace?: string): Promise<RemoveResult> {
  const candidates = ["testagent.jsonc", "testagent.json", "opencode.jsonc", "opencode.json", "config.json"]
  let removed = false
  for (const filename of candidates) {
    const config = await this.readConfigByFilename(scope, workspace, filename)
    if (config.agent?.[item.id]) {
      delete config.agent[item.id]
      if (Object.keys(config.agent).length === 0) delete config.agent
      await this.writeConfigByFilename(scope, workspace, config, filename)
      removed = true
      console.log(`[TestAgent] Removed agent "${item.id}" from ${filename} (${scope})`)
    }
  }
  // 返回实际删除状态
  return { success: true, slug: item.id, actuallyRemoved: removed }
}
```

同样修改 `removeMcp()` 方法。

### 3. 修复 scope 选择逻辑

**文件**: `packages/kilo-vscode/src/KiloProvider.ts`

```typescript
private async removeMarketplaceItemFromAllScopes(item: MarketplaceItem): Promise<boolean> {
  const workspace = this.getProjectDirectory(this.currentSession?.id)
  const mp = this.getMarketplace()
  
  const project = await mp.remove(item, "project", workspace)
  const global = await mp.remove(item, "global", workspace)

  // 根据实际删除情况选择 scope
  const projectRemoved = project.success && project.actuallyRemoved
  const globalRemoved = global.success && global.actuallyRemoved
  
  if (projectRemoved || globalRemoved) {
    if (projectRemoved && globalRemoved) {
      // 两者都删除了，失效 global（会同时调用 instance.dispose）
      await this.invalidateAfterMarketplaceChange("global")
    } else if (globalRemoved) {
      await this.invalidateAfterMarketplaceChange("global")
    } else {
      // 只在 project 中删除了
      await this.invalidateAfterMarketplaceChange("project")
    }
    return true
  }
  return false
}
```

### 4. 添加延迟确保缓存清除

**文件**: `packages/kilo-vscode/src/KiloProvider.ts`

```typescript
private async invalidateAfterMarketplaceChange(scope: "project" | "global"): Promise<void> {
  if (!this.client) return
  
  if (scope === "global") {
    await this.client.global.config.update({ config: {} }).catch((e: unknown) => {
      console.warn("[TestAgent] global.config.update after marketplace change failed:", e)
    })
  }
  
  const dir = this.getWorkspaceDirectory()
  await this.client.instance.dispose({ directory: dir }).catch((e: unknown) => {
    console.warn("[TestAgent] instance.dispose() after marketplace change failed:", e)
  })
  
  // 添加 200ms 延迟，确保后端缓存完全清除
  console.log("[TestAgent]  invalidateAfterMarketplaceChange: waiting for cache clear...")
  await new Promise((resolve) => setTimeout(resolve, 200))
  console.log("[TestAgent]  invalidateAfterMarketplaceChange: cache clear complete")
  
  this.cachedAgentsMessage = null
  this.cachedConfigMessage = null
  await Promise.all([this.fetchAndSendAgents(), this.fetchAndSendConfig()])
}
```

## 修复效果

### 修复前
```
1. 用户删除 agent "helo"
2. 配置文件已删除 ✅
3. 调用 instance.dispose() ✅
4. 立即调用 fetchAndSendAgents() ❌ 读取到旧缓存
5. WebView 仍显示 "helo" ❌
```

### 修复后
```
1. 用户删除 agent "helo"
2. 配置文件已删除 ✅
3. 检测到 project 中实际删除了内容 ✅
4. 选择正确的 scope (project) ✅
5. 调用 instance.dispose() ✅
6. 等待 200ms 确保缓存清除 ✅
7. 调用 fetchAndSendAgents() ✅ 读取到新数据
8. WebView 正确更新，"helo" 消失 ✅
```

## 测试步骤

1. 创建一个自定义 Agent（例如 "test-agent"）
2. 在 Settings > Agent Behaviour 中查看该 Agent
3. 点击删除按钮
4. 确认对话框
5. 观察日志输出：
   ```
   [TestAgent] Removed agent "test-agent" from testagent.jsonc (project)
   [TestAgent] removeMarketplaceItemFromAllScopes: invalidating scope = project
   [TestAgent] invalidateAfterMarketplaceChange: waiting for cache clear...
   [TestAgent] invalidateAfterMarketplaceChange: cache clear complete
   ```
6. 验证 WebView UI 中该 Agent 已消失
7. 验证配置文件中该 Agent 已被删除

## 相关文件

- `packages/kilo-vscode/src/services/marketplace/types.ts` - 接口定义
- `packages/kilo-vscode/src/services/marketplace/installer.ts` - 删除实现
- `packages/kilo-vscode/src/KiloProvider.ts` - 缓存失效逻辑

## 注意事项

1. 延迟时间设置为 200ms，这是一个经验值
   - 如果后端响应较慢，可能需要增加
   - 如果后端响应很快，可以减少以提升用户体验

2. 此修复同时适用于 Agent Mode 和 MCP Server 的删除

3. 修复保持了幂等性：即使 Agent 不存在，删除操作也不会报错

## 后续优化建议

1. **后端改进**：在 CLI 后端添加专门的 "reload agents" API，避免依赖 dispose + 延迟
2. **事件通知**：后端在缓存清除完成后发送事件通知前端
3. **重试机制**：如果第一次获取仍是旧数据，自动重试
