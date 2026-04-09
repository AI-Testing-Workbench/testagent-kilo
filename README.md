# testagent-opencode

基于 [Kilo Code](https://github.com/Kilo-Org/kilocode) 的 VS Code 插件，使用自定义 opencode server 构建。

## 打包步骤

### 1. 构建 opencode server 二进制
在testagent-opencode根目录执行如下命令

```bash
# Windows
bun bun:windows

# macOS
bun bun:mac
```
需要将打包后的文件重命名testagent.exe|testagent -> kilo.exe|kilo


### 2. 回到testagent-kilo内复制二进制到插件目录

```bash
# 在项目根目录执行
mkdir -p packages/kilo-vscode/bin

# Windows
cp packages/opencode/dist/@kilocode/cli-windows-x64/bin/kilo.exe packages/kilo-vscode/bin/

# macOS
cp packages/opencode/dist/@kilocode/cli-darwin-x64/bin/kilo packages/kilo-vscode/bin/
```

### 3. 构建插件代码

```bash
# 在 packages/kilo-vscode/ 目录执行
bun run rebuild-sdk
bun run typecheck
bun run lint
node esbuild.js --production
```

### 4. 打包成 .vsix

```bash
vsce package --no-dependencies
```

生成的 `kilo-code-7.1.21.vsix` 即可在对应平台的 VS Code 上安装使用。
