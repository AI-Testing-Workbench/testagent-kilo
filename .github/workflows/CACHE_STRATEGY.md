# GitHub Actions 缓存策略

## 概述

为了加快 CI/CD 构建速度,我们在 `publish.yml` 工作流中实现了 `node_modules` 缓存机制。

## 缓存机制

### 缓存键 (Cache Key)

```yaml
key: ${{ runner.os }}-${{ matrix.target }}-nodejs-modules-${{ steps.nodejs_cache_key.outputs.hash }}
```

**组成部分**:
- `runner.os`: 操作系统 (Linux, macOS, Windows)
- `matrix.target`: 目标平台 (linux-x64, darwin-arm64, win32-x64 等)
- `hash`: `package.json` 的 SHA256 哈希值

### 缓存恢复键 (Restore Keys)

```yaml
restore-keys: |
  ${{ runner.os }}-${{ matrix.target }}-nodejs-modules-
```

如果精确匹配的缓存不存在,会尝试使用相同 OS 和平台的最新缓存。

## 工作流程

### 首次构建 (缓存未命中)

1. ✅ 构建 Node.js 服务器
2. 📦 计算 `package.json` 哈希值
3. 🔍 尝试恢复缓存 → **未命中**
4. 📥 安装 npm 依赖
5. 📥 下载平台特定的原生模块 (node-pty, @parcel/watcher)
6. ✅ 验证依赖完整性
7. 📦 打包 VSIX
8. 💾 **保存 node_modules 到缓存**

**耗时**: ~2-3 分钟 (取决于网络速度)

### 后续构建 (缓存命中)

1. ✅ 构建 Node.js 服务器
2. 📦 计算 `package.json` 哈希值
3. 🔍 尝试恢复缓存 → **命中!**
4. ⚡ 跳过依赖安装
5. ✅ 验证缓存的依赖
6. 📦 打包 VSIX

**耗时**: ~30 秒 (节省 1.5-2.5 分钟)

## 缓存失效条件

缓存会在以下情况下失效:

1. **package.json 变更** - 添加/删除/更新依赖
2. **平台变更** - 不同的目标平台有独立的缓存
3. **手动清除** - 在 GitHub Actions 设置中手动删除缓存
4. **缓存过期** - GitHub 会自动删除 7 天未使用的缓存

## 缓存大小

每个平台的缓存大小约为:
- **Linux**: ~50-80 MB
- **macOS**: ~50-80 MB  
- **Windows**: ~60-90 MB

总缓存大小: ~400-600 MB (7 个平台)

## 性能提升

| 场景 | 无缓存 | 有缓存 | 节省时间 |
|------|--------|--------|---------|
| 单平台构建 | ~3 分钟 | ~30 秒 | **83%** |
| 全平台构建 (7个) | ~21 分钟 | ~3.5 分钟 | **83%** |

## 监控缓存

### 查看缓存命中状态

在 GitHub Actions 日志中查找:

```
✅ Cache hit! Using cached node_modules
```

或

```
📥 Cache miss. Will install dependencies and cache them
```

### 查看缓存列表

1. 进入仓库的 **Actions** 标签
2. 点击左侧的 **Caches**
3. 查看所有缓存及其大小和最后使用时间

## 故障排除

### 缓存损坏

如果缓存的 `node_modules` 损坏,可以:

1. 在 GitHub Actions 设置中删除相关缓存
2. 重新运行工作流,会重新安装依赖并创建新缓存

### 依赖验证失败

脚本会在打包前验证关键依赖:
- `@lydell/node-pty-{platform}`
- `@parcel/watcher-{platform}`

如果验证失败,构建会报错并提示缺失的依赖。

## 最佳实践

1. **不要手动修改 node_modules** - 始终通过 `package.json` 管理依赖
2. **定期清理旧缓存** - GitHub 会自动清理,但可以手动删除不再使用的缓存
3. **监控缓存命中率** - 如果命中率低,检查是否频繁修改 `package.json`

## 相关文件

- **工作流**: `.github/workflows/publish.yml`
- **打包脚本**: `packages/kilo-vscode/script/package-nodejs-server.ts`
- **缓存路径**: `packages/kilo-vscode/nodejs-server/node_modules`
