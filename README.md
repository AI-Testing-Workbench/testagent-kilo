# testagent

testagent 是基于 [Kilo Code](https://github.com/Kilo-Org/kilocode) 的 VS Code AI 编程助手扩展，集成了自定义功能和工作流优化。

Fork 链路：`opencode` → `kilo` → `testagent`

## 项目结构

| 目录 | 说明 |
|------|------|
| `packages/kilo-vscode/` | VS Code 扩展主体（侧边栏 + Agent Manager） |
| `packages/testagent-opencode/` | testagent 定制的 CLI 核心引擎（fork 自 opencode） |
| `packages/opencode/` | 上游 Kilo CLI（不直接修改） |
| `packages/sdk/js/` | 自动生成的 TypeScript SDK，勿手动编辑 `src/gen/` |
| `packages/kilo-ui/` | SolidJS 组件库，扩展 webview 与 app 共用 |

## 开发

在项目根目录执行：

```bash
bun run extension
```

该命令会自动完成以下步骤：
1. 在 `packages/testagent-opencode` 中构建 CLI 二进制（根据当前系统执行 `bun bun:mac` 或 `bun bun:windows`），产物自动复制到 `packages/kilo-vscode/bin/`
2. 构建 VS Code 扩展（esbuild 打包 extension + webview + Agent Manager）
3. 以开发模式启动 VS Code，加载本地扩展

跳过 CLI 构建（二进制已存在时）：

```bash
bun run extension --no-build
```

## 打包 VSIX

**第一步**：在 `packages/testagent-opencode` 中构建 CLI 二进制：

```bash
# macOS
bun bun:mac

# Windows
bun bun:windows
```

产物会自动复制到 `packages/kilo-vscode/bin/` 目录。

**第二步**：在 `packages/kilo-vscode` 中打包扩展：

```bash
bun run testagent:vsix
```

VSIX 文件输出到 `packages/kilo-vscode/` 目录下。

## 上游同步

修改共享的 Kilo 代码时，用 `testagent_change` 注释标记变更，便于后续合并上游时识别：

```typescript
// 单行
const value = 42 // testagent_change

// 多行
// testagent_change start
const foo = 1
const bar = 2
// testagent_change end
```

以下路径是 testagent 专属目录，**不需要**加标记：
- `packages/opencode/src/testagent/`
- `packages/opencode/test/testagent/`
