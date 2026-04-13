# TestAgent

TestAgent是一个AI辅助测试助手，它可以帮助你分析测试项目，梳理测试点，生成自动化测试脚本，同时支持自定义插件拓展功能。

## 开发

拉取子目录依赖 && 安装依赖

```bash
git submodule update --init --recursive


bun install 

// git submodule依赖安装
bun install --cwd packages/testagent-opencode

```

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

📢 如果CLI 二级制无变化 可以不操作第一步，直接第二步构建插件

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

