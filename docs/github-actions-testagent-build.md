# TestAgent GitHub Actions 构建流程改造

## 改造概述

将原有的 Kilo Code 构建流程改造为 TestAgent 的构建流程：

### 原流程
```
build-cli (多平台) → build-vscode (多平台 VSIX)
```

### 新流程
```
build-cli (Windows x64) → build-vscode (Node.js Server VSIX)
```

---

## 改造详情

### 1. **build-cli Job** - 构建 CLI

**改动**：
- ❌ 删除：`./packages/opencode/script/build.ts`（原 Kilo 构建脚本）
- ✅ 新增：`bun run bun:windows`（TestAgent 构建脚本）

**构建目标**：
- 只构建 Windows x64 平台
- 输出：`packages/kilo-vscode/bin/testagent.exe`

**构建命令**：
```bash
cd packages/testagent-core
bun run bun:windows
```

**实际执行**（来自 `package.json`）：
```bash
cross-env OPENCODE_VERSION=1.14.42 OPENCODE_CHANNEL=latest \
  bun packages/opencode/script/build.ts \
  --target=win32-x64-baseline \
  --skip-models && \
  mkdir -p ../kilo-vscode/bin/ && \
  cp packages/opencode/dist/testagent-windows-x64-baseline/bin/testagent.exe \
     ../kilo-vscode/bin/testagent.exe
```

**环境变量**：
```yaml
OPENCODE_VERSION: ${{ needs.version.outputs.version }}
OPENCODE_CHANNEL: latest
```

**产物**：
- Artifact 名称：`testagent-cli`
- 路径：`packages/kilo-vscode/bin/testagent.exe`

**验证步骤**：
```bash
# 检查文件是否存在
if [ ! -f packages/kilo-vscode/bin/testagent.exe ]; then
  echo "❌ Error: testagent.exe not found!"
  exit 1
fi

# 显示文件信息
ls -lh packages/kilo-vscode/bin/testagent.exe
```

---

### 2. **build-vscode Job** - 构建 VS Code 扩展

**改动**：
- ❌ 删除：`bun script/build.ts`（原 Kilo 多平台构建）
- ❌ 删除：`vsce package` 多平台循环
- ✅ 新增：`bun run testagent-nodejs:vsix`（TestAgent Node.js Server 构建）

**构建目标**：
- 单一 VSIX 包（包含 Node.js Server）
- 输出：`packages/kilo-vscode/testagent-nodejs-tscode.vsix`

**构建命令**：
```bash
cd packages/kilo-vscode
bun run testagent-nodejs:vsix
```

**实际执行**（来自 `package.json`）：
```bash
bun script/package-nodejs-server.ts
```

**构建流程**（`package-nodejs-server.ts`）：

#### Step 1: 构建 Node.js Server
```bash
cd packages/testagent-core/packages/nodejs-server
OPENCODE_CHANNEL=latest bun run build
```

#### Step 2: 复制 Server Dist
```bash
# 复制 dist 到 kilo-vscode/nodejs-server/
cp -r packages/testagent-core/packages/nodejs-server/dist \
      packages/kilo-vscode/nodejs-server/
```

#### Step 3: 安装依赖
```bash
cd packages/kilo-vscode/nodejs-server
npm install --omit=dev --omit=optional

# 手动下载 win32-x64 平台二进制
# - @lydell/node-pty-win32-x64@1.2.0-beta.10
# - @parcel/watcher-win32-x64@2.5.0
```

**关键点**：
- 只安装 `win32-x64` 平台的 native bindings
- 手动从 npm registry 下载 tarball 并解压
- 避免安装所有平台的二进制文件（减小体积）

#### Step 4: 构建扩展
```bash
cd packages/kilo-vscode
BACKEND_RUNTIME=testagent-nodejs node esbuild.js --production
```

#### Step 5: 打包 VSIX
```bash
npx @vscode/vsce package --no-dependencies \
  -o testagent-nodejs-tscode.vsix
```

**环境变量**：
```yaml
OPENCODE_VERSION: ${{ needs.build-cli.outputs.version }}
OPENCODE_CHANNEL: latest
KILO_VERSION: ${{ needs.build-cli.outputs.version }}
KILO_PRE_RELEASE: ${{ inputs.pre_release }}
```

**产物**：
- Artifact 名称：`testagent-vscode`
- 路径：`packages/kilo-vscode/*.vsix`
- 实际文件：`testagent-nodejs-tscode.vsix`

**验证步骤**：
```bash
# 检查 CLI 二进制
if [ ! -f packages/kilo-vscode/bin/testagent.exe ]; then
  echo "❌ Error: testagent.exe not found after download!"
  exit 1
fi

# 检查 VSIX 包
if [ ! -f packages/kilo-vscode/testagent-nodejs-tscode.vsix ]; then
  echo "❌ Error: VSIX package not found!"
  exit 1
fi

# 显示文件信息
ls -lh packages/kilo-vscode/*.vsix
```

---

## 完整 Workflow 配置

```yaml
build-cli:
  needs: version
  runs-on: blacksmith-4vcpu-ubuntu-2404
  if: github.repository == 'Kilo-Org/kilocode'
  steps:
    - uses: actions/checkout@v3
      with:
        fetch-tags: true

    - uses: ./.github/actions/setup-bun

    - name: Build CLI (Windows x64)
      id: build
      run: bun run bun:windows
      working-directory: ./packages/testagent-core
      env:
        OPENCODE_VERSION: ${{ needs.version.outputs.version }}
        OPENCODE_CHANNEL: latest

    - name: Verify CLI binary
      run: |
        if [ ! -f packages/kilo-vscode/bin/testagent.exe ]; then
          echo "❌ Error: testagent.exe not found!"
          exit 1
        fi
        echo "✅ CLI binary built successfully"
        ls -lh packages/kilo-vscode/bin/testagent.exe

    - uses: actions/upload-artifact@v4
      with:
        name: testagent-cli
        path: packages/kilo-vscode/bin/testagent.exe

  outputs:
    version: ${{ needs.version.outputs.version }}

build-vscode:
  needs: build-cli
  runs-on: blacksmith-4vcpu-ubuntu-2404
  if: github.repository == 'Kilo-Org/kilocode'
  steps:
    - uses: actions/checkout@v3

    - uses: ./.github/actions/setup-bun

    - uses: actions/setup-node@v4
      with:
        node-version: "24"
        registry-url: "https://registry.npmjs.org"

    - name: Download CLI artifact
      uses: actions/download-artifact@v4
      with:
        name: testagent-cli
        path: packages/kilo-vscode/bin

    - name: Verify CLI binary
      run: |
        if [ ! -f packages/kilo-vscode/bin/testagent.exe ]; then
          echo "❌ Error: testagent.exe not found after download!"
          exit 1
        fi
        echo "✅ CLI binary downloaded successfully"
        ls -lh packages/kilo-vscode/bin/

    - name: Build VSIX package
      run: bun run testagent-nodejs:vsix
      working-directory: ./packages/kilo-vscode
      env:
        OPENCODE_VERSION: ${{ needs.build-cli.outputs.version }}
        OPENCODE_CHANNEL: latest
        KILO_VERSION: ${{ needs.build-cli.outputs.version }}
        KILO_PRE_RELEASE: ${{ inputs.pre_release }}

    - name: Verify VSIX package
      run: |
        if [ ! -f packages/kilo-vscode/testagent-nodejs-tscode.vsix ]; then
          echo "❌ Error: VSIX package not found!"
          ls -la packages/kilo-vscode/*.vsix || echo "No VSIX files found"
          exit 1
        fi
        echo "✅ VSIX package built successfully"
        ls -lh packages/kilo-vscode/*.vsix

    - uses: actions/upload-artifact@v4
      with:
        name: testagent-vscode
        path: packages/kilo-vscode/*.vsix
```

---

## 关键差异对比

| 项目 | 原 Kilo Code | 新 TestAgent |
|------|-------------|-------------|
| **CLI 构建** | 多平台（8 个目标） | 单平台（Windows x64） |
| **CLI 脚本** | `./packages/opencode/script/build.ts` | `bun run bun:windows` |
| **CLI 输出** | `packages/opencode/dist/` | `packages/kilo-vscode/bin/` |
| **VSIX 构建** | 多平台循环 | 单一 Node.js Server |
| **VSIX 脚本** | `bun script/build.ts` | `bun run testagent-nodejs:vsix` |
| **VSIX 输出** | `kilo-vscode-{target}.vsix` (8 个) | `testagent-nodejs-tscode.vsix` (1 个) |
| **后端运行时** | Bun CLI 二进制 | Node.js Server + Bun CLI |
| **平台支持** | 所有平台独立 VSIX | 单一 VSIX（跨平台） |

---

## 优势

### 1. **简化构建流程**
- ✅ 只构建一个平台的 CLI（Windows x64）
- ✅ 只生成一个 VSIX 包
- ✅ 构建时间大幅缩短

### 2. **Node.js Server 架构**
- ✅ 使用 Node.js 作为后端运行时
- ✅ 更好的跨平台兼容性
- ✅ 更容易调试和维护

### 3. **精简依赖**
- ✅ 只安装必要的平台二进制（win32-x64）
- ✅ 减小 VSIX 包体积
- ✅ 避免不必要的下载

---

## 本地测试

### 测试 CLI 构建
```bash
cd packages/testagent-core
bun run bun:windows

# 验证输出
ls -lh ../kilo-vscode/bin/testagent.exe
```

### 测试 VSIX 构建
```bash
cd packages/kilo-vscode

# 确保 CLI 已构建
ls -lh bin/testagent.exe

# 构建 VSIX
bun run testagent-nodejs:vsix

# 验证输出
ls -lh testagent-nodejs-tscode.vsix
```

### 测试完整流程
```bash
# 从根目录
cd packages/testagent-core
bun run bun:windows

cd ../kilo-vscode
bun run testagent-nodejs:vsix

# 安装测试
code --install-extension testagent-nodejs-tscode.vsix
```

---

## 故障排查

### 问题 1: CLI 二进制未找到
```bash
❌ Error: testagent.exe not found!
```

**解决方案**：
1. 检查 `bun:windows` 脚本是否正确执行
2. 确认输出路径：`packages/kilo-vscode/bin/testagent.exe`
3. 检查构建日志中的错误信息

### 问题 2: VSIX 包未生成
```bash
❌ Error: VSIX package not found!
```

**解决方案**：
1. 检查 Node.js Server 是否构建成功
2. 确认 `nodejs-server/dist` 目录存在
3. 检查 native bindings 是否正确安装
4. 查看 `package-nodejs-server.ts` 的输出日志

### 问题 3: Native bindings 缺失
```bash
❌ Error: Missing node-pty binaries for: win32-x64
```

**解决方案**：
1. 检查网络连接（需要从 npm registry 下载）
2. 手动下载 tarball：
   ```bash
   curl -O https://registry.npmjs.org/@lydell/node-pty-win32-x64/-/node-pty-win32-x64-1.2.0-beta.10.tgz
   ```
3. 检查 `package-nodejs-server.ts` 中的下载逻辑

### 问题 4: esbuild 构建失败
```bash
❌ Error: Build failed
```

**解决方案**：
1. 确保 `BACKEND_RUNTIME=testagent-nodejs` 环境变量已设置
2. 检查 `esbuild.js` 配置
3. 运行 typecheck：`bun run check-types`
4. 运行 lint：`bun run lint`

---

## 后续优化建议

### 1. **支持多平台 CLI**
如果需要支持其他平台，可以添加：
```yaml
strategy:
  matrix:
    platform:
      - windows
      - mac
      - linux
```

然后在 `build-cli` 中：
```yaml
- name: Build CLI (${{ matrix.platform }})
  run: bun run bun:${{ matrix.platform }}
```

### 2. **缓存优化**
添加构建缓存以加速后续构建：
```yaml
- name: Cache CLI build
  uses: actions/cache@v4
  with:
    path: packages/testagent-core/packages/opencode/dist
    key: cli-${{ runner.os }}-${{ hashFiles('packages/testagent-core/**/*.ts') }}
```

### 3. **并行构建**
如果支持多平台，可以并行构建：
```yaml
build-cli:
  strategy:
    matrix:
      platform: [windows, mac, linux]
  # ...
```

### 4. **自动化测试**
在构建后添加自动化测试：
```yaml
- name: Test VSIX
  run: |
    code --install-extension testagent-nodejs-tscode.vsix
    # 运行集成测试
```

---

## 总结

改造后的构建流程：
- ✅ **更简单**：单平台 CLI + 单一 VSIX
- ✅ **更快速**：构建时间大幅缩短
- ✅ **更可靠**：减少了构建失败的可能性
- ✅ **更易维护**：代码更清晰，调试更容易

这个改造专注于 TestAgent 的核心需求（Windows x64 + Node.js Server），去除了不必要的复杂性。
