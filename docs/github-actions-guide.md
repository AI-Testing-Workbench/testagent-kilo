# GitHub Actions 配置指南

## 目录
- [概览](#概览)
- [核心 Workflows](#核心-workflows)
- [自定义 Actions](#自定义-actions)
- [发布流程](#发布流程)
- [PR 管理](#pr-管理)
- [环境变量和 Secrets](#环境变量和-secrets)
- [最佳实践](#最佳实践)

---

## 概览

testagent-kilo 项目使用 GitHub Actions 进行 CI/CD，包括：
- ✅ 自动化测试（单元测试、E2E 测试）
- ✅ 类型检查
- ✅ 代码质量检查
- ✅ 自动发布（CLI、VS Code 扩展、Docker 镜像）
- ✅ PR 标准检查
- ✅ 文档构建和链接检查

**Runner 类型**：
- `blacksmith-*vcpu-ubuntu-2404` - Linux (Blacksmith 提供的高性能 runner)
- `blacksmith-*vcpu-windows-2025` - Windows
- `macos-latest` - macOS (用于 Tauri 构建)

---

## 核心 Workflows

### 1. **test.yml** - 测试工作流

**触发条件**：
- Push 到 `main` 分支
- Pull Request
- 手动触发 (`workflow_dispatch`)

**并发控制**：
```yaml
concurrency:
  group: ${{ case(github.ref == 'refs/heads/main', ...) }}
  cancel-in-progress: true
```
- `main` 分支：每次运行独立（不取消）
- PR/其他分支：同一 PR 的新运行会取消旧运行

**Jobs**：

#### a) `unit` - 单元测试
```yaml
strategy:
  matrix:
    settings:
      - name: linux
        host: blacksmith-8vcpu-ubuntu-2404
      - name: windows
        host: blacksmith-8vcpu-windows-2025
```

**步骤**：
1. Checkout 代码
2. 设置 Node.js 24
3. 设置 Bun（使用自定义 action）
4. 配置 Git 身份
5. 缓存 Turbo 构建缓存
6. 运行测试：`bun turbo test:ci`
7. 发布测试报告（JUnit 格式）
8. 上传测试产物

**环境变量**：
```yaml
KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: ${{ runner.os == 'Windows' && 'true' || 'false' }}
```
Windows 上禁用文件监听器（性能优化）

#### b) `e2e` - E2E 测试（已禁用）
```yaml
if: false  # kilocode_change - packages/app 不再维护
```

#### c) `required` - 必需检查
汇总所有测试结果，确保所有测试通过。

---

### 2. **typecheck.yml** - 类型检查

**触发条件**：
- Push 到 `main`
- Pull Request
- 手动触发

**步骤**：
```bash
bun typecheck
```

使用 `tsgo`（而非 `tsc`）进行类型检查。

---

### 3. **publish.yml** - 发布工作流

**触发条件**：
- 手动触发（`workflow_dispatch`）

**输入参数**：
```yaml
inputs:
  bump: [patch, minor, major]  # 版本号升级类型
  version: string              # 覆盖版本号（可选）
  pre_release: boolean         # 是否为预发布版本
```

**并发控制**：
```yaml
concurrency: ${{ github.workflow }}-${{ github.ref }}-${{ inputs.version || inputs.bump }}
```
确保同一版本只有一个发布流程在运行。

**权限**：
```yaml
permissions:
  id-token: write    # npm provenance
  contents: write    # 创建 release
  packages: write    # 发布 Docker 镜像
```

**Jobs 流程**：

```
version
  ↓
build-cli
  ↓
build-vscode
  ↓
smoke-test (预发布门控)
  ↓
publish
```

#### a) `version` - 版本管理
```bash
./script/version.ts
```

**环境变量**：
- `KILO_BUMP`: patch/minor/major
- `KILO_VERSION`: 覆盖版本号
- `KILO_PRE_RELEASE`: 是否预发布
- `KILO_API_KEY`: Kilo API 密钥
- `KILO_ORG_ID`: Kilo 组织 ID

**输出**：
- `version`: 新版本号
- `release`: GitHub Release ID
- `tag`: Git 标签

#### b) `build-cli` - 构建 CLI
```bash
./packages/opencode/script/build.ts
```

构建所有平台的 CLI 二进制文件：
- Linux (x64, arm64)
- macOS (x64, arm64)
- Windows (x64)

**产物**：
- `kilo-cli` artifact（包含所有平台的二进制文件）

#### c) `build-vscode` - 构建 VS Code 扩展
```bash
bun script/build.ts
```

**步骤**：
1. 下载 CLI 产物
2. 安装 `@vscode/vsce`
3. 构建 VSIX 包

**产物**：
- `kilo-vscode` artifact（VSIX 文件）

#### d) `smoke-test` - 冒烟测试
在发布前运行冒烟测试，确保 CLI 基本功能正常。

**输入**：
- `cli_version`: 要测试的 CLI 版本

#### e) `publish` - 发布
```bash
./script/publish.ts
```

**发布目标**：
1. **npm**: `@kilocode/cli` 包
2. **VS Code Marketplace**: Kilo Code 扩展
3. **Open VSX**: Kilo Code 扩展
4. **GitHub Release**: 发布 CLI 二进制文件
5. **Docker**: `ghcr.io/kilo-org/kilocode` 镜像
6. **AUR**: Arch Linux 用户仓库

**环境变量**：
- `NODE_AUTH_TOKEN`: npm token
- `NPM_CONFIG_PROVENANCE`: npm provenance
- `VSCE_PAT`: VS Code Marketplace token
- `OPENVSX_TOKEN`: Open VSX token
- `AUR_KEY`: AUR SSH 密钥

---

### 4. **pr-standards.yml** - PR 标准检查

**触发条件**：
- PR 打开、编辑、同步

**Jobs**：

#### a) `check-author` - 检查作者（已禁用）
```yaml
if: false  # kilocode_change - kilocode 仓库不需要
```

#### b) `check-standards` - 检查 PR 标准（已禁用）
检查：
- PR 标题格式（Conventional Commits）
- 关联的 Issue

**标题格式**：
```
feat: description
feat(scope): description
fix: description
fix(scope): description
docs: description
chore: description
refactor: description
test: description
```

**Issue 关联**：
- 使用 `Fixes #123` 或 `Closes #123`
- `docs`/`refactor`/`feat` PR 可以跳过

#### c) `check-compliance` - 检查 PR 模板合规性（已禁用）
检查 PR 描述是否包含：
- "What does this PR do?" 部分
- "Type of change" 复选框
- "How did you verify" 部分
- "Checklist" 复选框
- "Issue for this PR" 部分

**不合规处理**：
- 添加 `needs:compliance` 标签
- 发布评论说明问题
- 2 小时后自动关闭（由其他 workflow 处理）

---

### 5. **其他 Workflows**

#### a) `check-opencode-annotations.yml`
检查 `packages/opencode/` 中的 Kilo 特定修改是否正确标注 `kilocode_change` 标记。

**豁免路径**：
- `packages/opencode/src/kilocode/`
- `packages/opencode/test/kilocode/`
- 路径中包含 `kilocode` 的文件

#### b) `source-check-links.yml`
检查源代码中的 URL 链接是否有效。

**运行脚本**：
```bash
bun run script/extract-source-links.ts
```

#### c) `docs-build.yml` / `docs-check-links.yml`
构建文档并检查文档中的链接。

#### d) `containers.yml`
构建和发布 Docker 容器镜像。

#### e) `storybook.yml`
构建和部署 Storybook（UI 组件文档）。

#### f) `visual-regression.yml`
运行视觉回归测试（VS Code 扩展 UI）。

---

## 自定义 Actions

### 1. **setup-bun** - 设置 Bun 环境

**位置**：`.github/actions/setup-bun/action.yml`

**功能**：
1. 检测 runner 架构，选择合适的 Bun 下载 URL
2. 安装 Bun（从 `package.json` 读取版本）
3. 缓存 Bun 依赖
4. 安装 Python setuptools（兼容性）
5. 安装项目依赖

**特殊处理**：
- Windows: 使用 `--linker hoisted`（解决 patch 问题）
- X64: 使用 baseline 版本（兼容性）

**缓存策略**：
```yaml
key: ${{ runner.os }}-bun-${{ hashFiles('**/bun.lock') }}
```

### 2. **setup-kilo** - 安装 Kilo CLI

**位置**：`.github/actions/setup-kilo/action.yml`

**功能**：
```bash
curl -fsSL https://kilo.ai/cli/install | bash
echo "$HOME/.kilo/bin" >> $GITHUB_PATH
```

### 3. **setup-git-committer** - 设置 Git 提交者

**位置**：`.github/actions/setup-git-committer/action.yml`

**功能**：
- 使用 GitHub App 生成 token
- 配置 Git 身份为 `kilo-maintainer[bot]`

**输入**：
- `kilo-maintainer-app-id`
- `kilo-maintainer-app-secret`

---

## 发布流程

### 完整发布流程图

```
1. 手动触发 publish workflow
   ↓
2. version job: 计算新版本号
   ↓
3. build-cli job: 构建所有平台的 CLI
   ↓
4. build-vscode job: 构建 VS Code 扩展
   ↓
5. smoke-test job: 运行冒烟测试
   ↓
6. publish job:
   - 发布到 npm
   - 发布到 VS Code Marketplace
   - 发布到 Open VSX
   - 创建 GitHub Release
   - 构建并推送 Docker 镜像
   - 更新 AUR 包
```

### 版本号规则

**Bump 类型**：
- `patch`: 1.0.0 → 1.0.1（bug 修复）
- `minor`: 1.0.0 → 1.1.0（新功能）
- `major`: 1.0.0 → 2.0.0（破坏性变更）

**预发布版本**：
- `pre_release: true` → `1.0.0-rc.1`
- 发布到 npm 的 `rc` tag
- VS Code Marketplace 标记为 pre-release

### 发布命令示例

```bash
# 发布 patch 版本
gh workflow run publish.yml -f bump=patch

# 发布 minor 版本
gh workflow run publish.yml -f bump=minor

# 发布预发布版本
gh workflow run publish.yml -f bump=minor -f pre_release=true

# 发布指定版本
gh workflow run publish.yml -f version=1.2.3
```

---

## 环境变量和 Secrets

### Repository Secrets

**必需的 Secrets**：

#### 1. **Kilo API**
```
KILO_API_KEY          # Kilo API 密钥
KILO_ORG_ID           # Kilo 组织 ID
```

#### 2. **GitHub App**
```
KILO_MAINTAINER_APP_ID      # GitHub App ID
KILO_MAINTAINER_APP_SECRET  # GitHub App 私钥
```

#### 3. **发布相关**
```
NPM_TOKEN             # npm 发布 token
VSCE_TOKEN            # VS Code Marketplace token
OPENVSX_TOKEN         # Open VSX token
AUR_KEY               # AUR SSH 私钥
```

#### 4. **Apple 签名（Tauri）**
```
APPLE_CERTIFICATE              # Apple 开发者证书
APPLE_CERTIFICATE_PASSWORD     # 证书密码
APPLE_API_ISSUER               # Apple API Issuer ID
APPLE_API_KEY                  # Apple API Key ID
APPLE_API_KEY_PATH             # Apple API Key 文件路径
```

#### 5. **Tauri 签名**
```
TAURI_SIGNING_PRIVATE_KEY           # Tauri 签名私钥
TAURI_SIGNING_PRIVATE_KEY_PASSWORD  # 私钥密码
```

### 环境变量

**常用环境变量**：

```yaml
# 强制使用 Node 24 运行 Actions
FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

# 禁用文件监听器（Windows）
KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: true

# 禁用分享功能（测试）
KILO_DISABLE_SHARE: true

# 禁用会话摄取（测试）
KILO_DISABLE_SESSION_INGEST: true

# E2E 测试需要付费账户
KILO_E2E_REQUIRE_PAID: true

# npm provenance
NPM_CONFIG_PROVENANCE: true

# Playwright 浏览器路径
PLAYWRIGHT_BROWSERS_PATH: ${{ github.workspace }}/.playwright-browsers

# Tauri AppImage 格式
TAURI_BUNDLER_NEW_APPIMAGE_FORMAT: true
```

---

## 最佳实践

### 1. **缓存策略**

#### Bun 依赖缓存
```yaml
- uses: actions/cache@v4
  with:
    path: ${{ steps.cache.outputs.dir }}
    key: ${{ runner.os }}-bun-${{ hashFiles('**/bun.lock') }}
    restore-keys: |
      ${{ runner.os }}-bun-
```

#### Turbo 构建缓存
```yaml
- uses: actions/cache@v4
  with:
    path: node_modules/.cache/turbo
    key: turbo-${{ runner.os }}-${{ hashFiles('turbo.json', '**/package.json') }}-${{ github.sha }}
    restore-keys: |
      turbo-${{ runner.os }}-${{ hashFiles('turbo.json', '**/package.json') }}-
      turbo-${{ runner.os }}-
```

#### Playwright 浏览器缓存
```yaml
- uses: actions/cache@v4
  with:
    path: ${{ github.workspace }}/.playwright-browsers
    key: ${{ runner.os }}-${{ runner.arch }}-playwright-${{ steps.playwright-version.outputs.version }}-chromium
```

### 2. **并发控制**

**main 分支**：保留所有运行
```yaml
group: ${{ format('{0}-{1}', github.workflow, github.run_id) }}
cancel-in-progress: false
```

**PR/其他分支**：取消旧运行
```yaml
group: ${{ format('{0}-{1}', github.workflow, github.event.pull_request.number || github.ref) }}
cancel-in-progress: true
```

### 3. **矩阵策略**

**跨平台测试**：
```yaml
strategy:
  fail-fast: false  # 一个平台失败不影响其他平台
  matrix:
    settings:
      - name: linux
        host: blacksmith-8vcpu-ubuntu-2404
      - name: windows
        host: blacksmith-8vcpu-windows-2025
      - name: macos
        host: macos-latest
```

### 4. **产物管理**

**上传产物**：
```yaml
- uses: actions/upload-artifact@v4
  with:
    name: unit-${{ matrix.settings.name }}-${{ github.run_attempt }}
    retention-days: 7
    path: packages/*/.artifacts/unit/junit.xml
```

**下载产物**：
```yaml
- uses: actions/download-artifact@v4
  with:
    name: kilo-cli
    path: packages/opencode/dist
```

### 5. **错误处理**

**总是运行**：
```yaml
- name: Upload artifacts
  if: always()
  uses: actions/upload-artifact@v4
```

**条件执行**：
```yaml
- name: Install Playwright browsers
  if: steps.playwright-cache.outputs.cache-hit != 'true'
  run: bunx playwright install chromium
```

### 6. **超时设置**

```yaml
- name: Run app e2e tests
  run: bun --cwd packages/app test:e2e:local
  timeout-minutes: 30
```

### 7. **Shell 配置**

**Windows 兼容性**：
```yaml
defaults:
  run:
    shell: bash  # 在 Windows 上也使用 bash
```

---

## 调试技巧

### 1. **启用调试日志**

在 workflow 中添加：
```yaml
env:
  ACTIONS_STEP_DEBUG: true
  ACTIONS_RUNNER_DEBUG: true
```

### 2. **手动触发 Workflow**

```bash
# 使用 GitHub CLI
gh workflow run test.yml

# 带参数
gh workflow run publish.yml -f bump=patch -f pre_release=true
```

### 3. **查看 Workflow 运行**

```bash
# 列出最近的运行
gh run list --workflow=test.yml

# 查看运行详情
gh run view <run-id>

# 查看日志
gh run view <run-id> --log
```

### 4. **本地测试 Actions**

使用 [act](https://github.com/nektos/act)：
```bash
# 安装 act
brew install act

# 运行 workflow
act -j unit

# 使用特定 runner
act -j unit -P ubuntu-latest=catthehacker/ubuntu:act-latest
```

---

## 常见问题

### Q1: 为什么 Windows 测试比 Linux 慢？
**A**: Windows runner 性能较低，且禁用了文件监听器。考虑使用更高配置的 runner。

### Q2: 如何跳过 CI？
**A**: 在 commit message 中添加 `[skip ci]` 或 `[ci skip]`。

### Q3: 如何重新运行失败的 job？
**A**: 在 GitHub Actions UI 中点击 "Re-run failed jobs"，或使用 CLI：
```bash
gh run rerun <run-id> --failed
```

### Q4: 缓存没有生效？
**A**: 检查：
1. 缓存 key 是否正确
2. 缓存大小是否超过 10GB 限制
3. 是否在不同的 runner 之间共享缓存

### Q5: 如何添加新的 Secret？
**A**: 
```bash
# 使用 GitHub CLI
gh secret set SECRET_NAME

# 或在 GitHub UI 中：
# Settings → Secrets and variables → Actions → New repository secret
```

---

## 相关文档

- [GitHub Actions 官方文档](https://docs.github.com/en/actions)
- [Bun 文档](https://bun.sh/docs)
- [Turbo 文档](https://turbo.build/repo/docs)
- [VS Code 扩展发布](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [npm Provenance](https://docs.npmjs.com/generating-provenance-statements)

---

## 总结

testagent-kilo 的 GitHub Actions 配置特点：

✅ **全面的 CI/CD**：测试、类型检查、发布一体化
✅ **跨平台支持**：Linux、Windows、macOS
✅ **智能缓存**：Bun、Turbo、Playwright 多层缓存
✅ **并发控制**：避免资源浪费
✅ **产物管理**：测试报告、构建产物自动上传
✅ **PR 质量控制**：自动检查标题、模板、Issue 关联
✅ **多渠道发布**：npm、VS Code Marketplace、Docker、AUR

这套配置确保了代码质量和发布流程的自动化，大大提高了开发效率。
