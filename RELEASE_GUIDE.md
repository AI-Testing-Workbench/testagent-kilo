# TestAgent VS Code 插件发布指南

## 概述

本文档描述如何本地构建 VS Code 插件并创建 GitHub Release，不发布到 VS Code Marketplace 和 Open VSX。

## 前置条件

1. **GitHub Personal Access Token**
   - 需要 `repo` 权限
   - 创建地址: https://github.com/settings/tokens

2. **安装依赖**
   ```bash
   bun install
   ```

## 发布流程

### Step 1: 设置环境变量

```bash
export GITHUB_TOKEN=你的token
```

### Step 2: 递增版本号

当前版本: `1.0.0`

```bash
# 手动递增版本号 (patch: 1.0.0 -> 1.0.1)
# 编辑根目录 package.json，将 version 从 "1.0.0" 改为 "1.0.1"

# 或者用脚本自动递增
bun run script/bump-version.ts patch
```

### Step 3: 构建 CLI 二进制

```bash
# 从项目根目录运行
./packages/opencode/script/build.ts
```

这会为以下平台构建 CLI:
- linux-x64, linux-arm64
- linux-x64-musl, linux-arm64-musl (Alpine)
- darwin-x64, darwin-arm64 (macOS)
- windows-x64, windows-arm64

输出目录: `packages/opencode/dist/`

### Step 4: 构建 VSIX 包

```bash
cd packages/kilo-vscode

# 设置 CLI 构建目录
export CLI_DIST_DIR=../../packages/opencode/dist
export KILO_VERSION=1.0.1

# 构建
bun run script/build.ts
```

输出目录: `packages/kilo-vscode/out/`

生成的文件:
- `kilo-vscode-linux-x64.vsix`
- `kilo-vscode-linux-arm64.vsix`
- `kilo-vscode-alpine-x64.vsix`
- `kilo-vscode-alpine-arm64.vsix`
- `kilo-vscode-darwin-x64.vsix`
- `kilo-vscode-darwin-arm64.vsix`
- `kilo-vscode-win32-x64.vsix`
- `kilo-vscode-win32-arm64.vsix`

### Step 5: 创建 Git Tag

```bash
# 提交版本变更
git add .
git commit -m "release: v1.0.1"

# 创建 tag
git tag v1.0.1

# 推送到 GitHub
git push origin main --tags
```

### Step 6: 创建 GitHub Release (不用 gh CLI)

使用 curl 调用 GitHub API:

```bash
# 创建 draft release
curl -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/AI-Testing-Workbench/testagent-kilo/releases \
  -d '{
    "tag_name": "v1.0.1",
    "name": "v1.0.1",
    "body": "## What'\''s Changed\n\n- Release notes here",
    "draft": true
  }'

# 记录返回的 release_id，用于上传文件
```

### Step 7: 上传 VSIX 文件到 Release

```bash
RELEASE_ID=返回的release_id

for target in linux-x64 linux-arm64 alpine-x64 alpine-arm64 darwin-x64 darwin-arm64 win32-x64 win32-arm64; do
  curl -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @packages/kilo-vscode/out/kilo-vscode-${target}.vsix \
    "https://uploads.github.com/repos/AI-Testing-Workbench/testagent-kilo/releases/${RELEASE_ID}/assets?name=kilo-vscode-${target}.vsix"
done
```

### Step 8: 发布 Release

```bash
curl -X PATCH \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/AI-Testing-Workbench/testagent-kilo/releases/${RELEASE_ID} \
  -d '{"draft": false}'
```

## 一键发布脚本

可以创建一个脚本自动化整个流程:

```bash
# 运行发布脚本
./script/release-local.ts
```

## 版本号规则

- **patch**: 修复 bug，小改动 (1.0.0 -> 1.0.1)
- **minor**: 新功能，向后兼容 (1.0.0 -> 1.1.0)
- **major**: 重大变更，不兼容 (1.0.0 -> 2.0.0)

## 常见问题

### Q: 构建失败，提示 CLI dist 目录不存在

确保先运行 `./packages/opencode/script/build.ts` 构建 CLI。

### Q: GitHub API 返回 401

检查 GITHUB_TOKEN 是否正确设置，是否有 repo 权限。

### Q: 上传文件失败

检查 release_id 是否正确，文件路径是否存在。

## 相关文件

| 文件 | 作用 |
|------|------|
| `script/version.ts` | 版本计算、创建 tag 和 draft release |
| `script/publish.ts` | 主发布脚本 |
| `packages/kilo-vscode/script/build.ts` | 构建 VSIX 包 |
| `packages/opencode/script/build.ts` | 构建 CLI 二进制 |