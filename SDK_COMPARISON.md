# SDK 对比报告

## 概述

对比 `packages/sdk` (Kilo Code SDK) 和 `packages/testagent-opencode/packages/sdk` (OpenCode SDK)

---

## 核心差异总结

| 特性             | Kilo SDK (`packages/sdk`) | OpenCode SDK (`testagent-opencode`) |
| ---------------- | ------------------------- | ----------------------------------- |
| **包名**         | `@kilocode/sdk`           | `@opencode-ai/sdk`                  |
| **版本**         | 7.1.21                    | 1.3.17                              |
| **CLI 命令**     | `kilo`                    | `opencode`                          |
| **客户端类名**   | `KiloClient`              | `OpencodeClient`                    |
| **源代码路径**   | `../../opencode`          | `../../opencode` (相对路径相同)     |
| **进程管理**     | Node.js `child_process`   | `cross-spawn` + 自定义进程管理      |
| **配置环境变量** | `KILO_CONFIG_CONTENT`     | `OPENCODE_CONFIG_CONTENT`           |
| **配置合并**     | ✅ 支持嵌套配置合并       | ❌ 简单 JSON 序列化                 |

---

## 详细对比

### 1. Package.json

#### Kilo SDK

```json
{
  "name": "@kilocode/sdk",
  "version": "7.1.21",
  "repository": {
    "type": "git",
    "url": "https://github.com/Kilo-Org/kilocode",
    "directory": "packages/sdk/js"
  }
}
```

#### OpenCode SDK

```json
{
  "name": "@opencode-ai/sdk",
  "version": "1.3.17",
  "dependencies": {
    "cross-spawn": "catalog:"
  },
  "devDependencies": {
    "@types/cross-spawn": "catalog:"
  }
}
```

**差异**:

- ✅ OpenCode SDK 使用 `cross-spawn` 提供更好的跨平台支持
- ✅ Kilo SDK 使用 Node.js 原生 `child_process`

---

### 2. 构建脚本 (script/build.ts)

#### Kilo SDK

```typescript
// 指向 packages/opencode
await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../opencode"))

// SDK 实例名称
instance: "KiloClient"

// 清理时包含 tsconfig.tsbuildinfo
await $`rm -rf dist tsconfig.tsbuildinfo`
```

#### OpenCode SDK

```typescript
// 指向 packages/testagent-opencode/packages/opencode
await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../opencode"))

// SDK 实例名称
instance: "OpencodeClient"

// 清理时不包含 tsconfig.tsbuildinfo
await $`rm -rf dist`
```

**差异**:

- ⚠️ **路径相同但实际指向不同**: 两者都写 `../../opencode`，但由于 SDK 位置不同，实际指向不同的 CLI 后端
- ✅ Kilo SDK 清理更彻底（包含 tsconfig.tsbuildinfo）

---

### 3. 客户端 (client.ts)

#### Kilo SDK

```typescript
export function createKiloClient(config?: Config & { directory?: string }) {
  // 使用自定义 fetch，支持 duplex 和 timeout
  const customFetch: any = (req: any) => {
    return fetch(req, { duplex: "half", timeout: false } as any)
  }

  // 设置 directory 头
  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-kilo-directory": encodeURIComponent(config.directory),
    }
  }

  // 设置 duplex 选项（Node.js/Electron 需要）
  ;(config as any).duplex = "half"

  const client = createClient(config)
  return new KiloClient({ client })
}
```

#### OpenCode SDK

```typescript
export function createOpencodeClient(config?: Config & { directory?: string }) {
  // 使用自定义 fetch，禁用超时
  const customFetch: any = (req: any) => {
    // @ts-ignore
    req.timeout = false
    return fetch(req)
  }

  // 设置 directory 头
  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodeURIComponent(config.directory),
    }
  }

  const client = createClient(config)

  // 使用拦截器重写 GET/HEAD 请求，将 header 转为 query 参数
  client.interceptors.request.use((request) => rewrite(request, config?.directory))

  return new OpencodeClient({ client })
}
```

**差异**:

- ✅ **Kilo SDK**: 使用 `duplex: "half"` 支持流式请求（更现代）
- ✅ **OpenCode SDK**: 使用请求拦截器将 directory header 转为 query 参数（更兼容）
- ⚠️ **Header 名称不同**: `x-kilo-directory` vs `x-opencode-directory`

---

### 4. 服务器 (server.ts)

#### Kilo SDK - 配置合并功能

```typescript
// 🌟 高级功能：合并现有配置
function mergeConfig(existing: Config | undefined, incoming: Config | undefined): Config {
  const base = existing ?? {}
  const override = incoming ?? {}
  return {
    ...base,
    ...override,
    agent: { ...base.agent, ...override.agent },
    command: { ...base.command, ...override.command },
    mcp: { ...base.mcp, ...override.mcp },
    mode: { ...base.mode, ...override.mode },
    plugin: [...(base.plugin ?? []), ...(override.plugin ?? [])],
    instructions: [...(base.instructions ?? []), ...(override.instructions ?? [])],
  }
}

function parseExistingConfig(): Config | undefined {
  const content = process.env.KILO_CONFIG_CONTENT
  if (!content) return undefined
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

export function buildConfigEnv(config?: Config): string {
  const merged = mergeConfig(parseExistingConfig(), config)
  return JSON.stringify(merged)
}
```

#### Kilo SDK - 服务器启动

```typescript
export async function createKiloServer(options?: ServerOptions) {
  const args = [`serve`, `--hostname=${options.hostname}`, `--port=${options.port}`]

  const proc = spawn(`kilo`, args, {
    // 使用 Node.js spawn
    signal: options.signal,
    windowsHide: true,
    env: {
      ...process.env,
      KILO_CONFIG_CONTENT: buildConfigEnv(options.config), // 合并配置
    },
  })

  // 等待服务器启动，解析 "kilo server listening" 消息
  const url = await new Promise<string>((resolve, reject) => {
    // ... 解析逻辑
    if (line.startsWith("kilo server listening")) {
      // 提取 URL
    }
  })

  return {
    url,
    close() {
      proc.kill() // 简单 kill
    },
  }
}
```

#### OpenCode SDK - 服务器启动

```typescript
export async function createOpencodeServer(options?: ServerOptions) {
  const args = [`serve`, `--hostname=${options.hostname}`, `--port=${options.port}`]

  const proc = launch(`opencode`, args, {
    // 使用 cross-spawn
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {}), // 简单序列化
    },
  })

  let clear = () => {}

  // 等待服务器启动，解析 "opencode server listening" 消息
  const url = await new Promise<string>((resolve, reject) => {
    // ... 解析逻辑
    if (line.startsWith("opencode server listening")) {
      // 提取 URL
    }

    // 绑定 abort 信号
    clear = bindAbort(proc, options.signal, () => {
      clearTimeout(id)
      reject(options.signal?.reason)
    })
  })

  return {
    url,
    close() {
      clear() // 清理 abort 监听器
      stop(proc) // 使用自定义 stop 函数
    },
  }
}
```

**差异**:

- 🌟 **Kilo SDK 独有**: 配置合并功能，支持嵌套 CLI 实例时保留父配置
- ✅ **OpenCode SDK**: 使用 `cross-spawn` 更好的跨平台支持
- ✅ **OpenCode SDK**: 自定义进程管理（`process.ts`），更优雅的清理
- ⚠️ **环境变量不同**: `KILO_CONFIG_CONTENT` vs `OPENCODE_CONFIG_CONTENT`
- ⚠️ **CLI 命令不同**: `kilo` vs `opencode`

---

### 5. 进程管理 (process.ts)

#### Kilo SDK

❌ **不存在** - 使用 Node.js 原生 `proc.kill()`

#### OpenCode SDK

✅ **存在** - `packages/testagent-opencode/packages/sdk/js/src/process.ts`

提供高级进程管理功能：

- `stop(proc)` - 优雅停止进程
- `bindAbort(proc, signal, callback)` - 绑定 AbortSignal 到进程

---

### 6. 主入口 (index.ts)

#### Kilo SDK

```typescript
export async function createKilo(options?: ServerOptions) {
  const server = await createKiloServer({ ...options })
  const client = createKiloClient({ baseUrl: server.url })
  return { client, server }
}
```

#### OpenCode SDK

```typescript
export async function createOpencode(options?: ServerOptions) {
  const server = await createOpencodeServer({ ...options })
  const client = createOpencodeClient({ baseUrl: server.url })
  return { client, server }
}
```

**差异**: 仅函数名不同

---

## 功能对比表

| 功能                 | Kilo SDK          | OpenCode SDK   | 说明                            |
| -------------------- | ----------------- | -------------- | ------------------------------- |
| **跨平台进程管理**   | ⚠️ 部分支持       | ✅ 完整支持    | OpenCode 使用 cross-spawn       |
| **配置合并**         | ✅ 支持           | ❌ 不支持      | Kilo 支持嵌套配置合并           |
| **流式请求**         | ✅ duplex: "half" | ⚠️ 基础支持    | Kilo 更现代                     |
| **请求拦截器**       | ❌ 不使用         | ✅ 使用        | OpenCode 用于 header→query 转换 |
| **进程清理**         | ⚠️ 简单 kill      | ✅ 优雅清理    | OpenCode 有专门的 process.ts    |
| **AbortSignal 支持** | ✅ 基础支持       | ✅ 完整支持    | OpenCode 更完善                 |
| **Windows 支持**     | ✅ windowsHide    | ✅ cross-spawn | 都支持，OpenCode 更好           |

---

## 架构差异

### Kilo SDK 架构

```
packages/sdk/js/
├── src/
│   ├── client.ts       (KiloClient)
│   ├── server.ts       (createKiloServer, 配置合并)
│   ├── index.ts        (createKilo)
│   ├── gen/            (自动生成)
│   └── v2/             (自动生成)
└── script/
    └── build.ts        (指向 ../../opencode)
```

### OpenCode SDK 架构

```
packages/testagent-opencode/packages/sdk/js/
├── src/
│   ├── client.ts       (OpencodeClient, 请求拦截器)
│   ├── server.ts       (createOpencodeServer)
│   ├── process.ts      (进程管理工具) ⭐ 独有
│   ├── index.ts        (createOpencode)
│   ├── gen/            (自动生成)
│   └── v2/             (自动生成)
└── script/
    └── build.ts        (指向 ../../opencode)
```

---

## 建议

### 如果你想统一两个 SDK

#### 方案 1: 保持独立（推荐）

- ✅ 两个 SDK 服务不同的 CLI 后端
- ✅ 各自独立演进
- ⚠️ 需要维护两份代码

#### 方案 2: 合并优势功能

从 Kilo SDK 迁移到 OpenCode SDK：

1. ✅ 添加配置合并功能（`mergeConfig`, `buildConfigEnv`）
2. ✅ 改进 fetch 配置（添加 `duplex: "half"`）
3. ✅ 保留 OpenCode 的进程管理（`process.ts`）

从 OpenCode SDK 迁移到 Kilo SDK：

1. ✅ 添加 `cross-spawn` 依赖
2. ✅ 添加 `process.ts` 进程管理
3. ✅ 添加请求拦截器功能

#### 方案 3: 创建共享基础库

```
packages/sdk-core/
├── client-base.ts      (共享客户端逻辑)
├── server-base.ts      (共享服务器逻辑)
└── process.ts          (共享进程管理)

packages/sdk/           (Kilo 特定)
packages/testagent-opencode/packages/sdk/  (OpenCode 特定)
```

---

## 关键发现

### 🌟 Kilo SDK 的优势

1. **配置合并系统** - 支持嵌套 CLI 实例
2. **更现代的 fetch 配置** - `duplex: "half"` 支持流式请求
3. **更完整的清理** - 删除 `tsconfig.tsbuildinfo`

### 🌟 OpenCode SDK 的优势

1. **更好的跨平台支持** - `cross-spawn`
2. **专门的进程管理** - `process.ts` 模块
3. **请求拦截器** - 灵活的 header→query 转换
4. **更优雅的资源清理** - `bindAbort` + `stop`

### ⚠️ 需要注意的差异

1. **环境变量名不同** - 不能混用
2. **CLI 命令不同** - `kilo` vs `opencode`
3. **Header 名称不同** - `x-kilo-directory` vs `x-opencode-directory`
4. **服务器日志格式不同** - 解析逻辑依赖不同的字符串

---

## 迁移 EditorContext 的影响

由于你已经在 `packages/testagent-opencode/packages/opencode` 中添加了 `editorContext` 支持：

1. ✅ **OpenCode SDK 会自动获得支持** - 重新生成后包含新类型
2. ❌ **Kilo SDK 不会获得支持** - 它指向不同的 CLI 后端
3. ⚠️ **VS Code 扩展需要使用正确的 SDK** - 确保使用 OpenCode SDK

---

**生成时间**: 2026-04-21  
**对比版本**: Kilo SDK 7.1.21 vs OpenCode SDK 1.3.17
