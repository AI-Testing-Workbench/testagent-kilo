# testagent-core 并发子 Agent - 最小集成方案

## 快速开始（最小改动）

如果你想快速验证并发调度的可行性，这里是一个最小化的集成方案，只需修改 3 个文件。

---

## 方案 A: 最小侵入式改造（推荐快速验证）

### 改动文件清单

1. `packages/testagent-core/packages/opencode/src/tool/task.ts` - 修改 task 工具支持批量
2. `packages/testagent-core/packages/opencode/src/config/config.ts` - 添加配置
3. `packages/testagent-core/packages/opencode/test/tool/task-concurrent.test.ts` - 添加测试

### 步骤 1: 修改 Config

```typescript
// packages/testagent-core/packages/opencode/src/config/config.ts

// testagent_change start - 添加并发配置
export interface Config {
  // ... 现有配置
  
  experimental?: {
    // ... 现有实验性配置
    
    concurrent_subagents?: {
      enabled: boolean
      max_concurrent: number  // 默认 3
      timeout: number         // 默认 300000 (5分钟)
    }
  }
}
// testagent_change end
```

### 步骤 2: 修改 Task 工具（核心改动）

```typescript
// packages/testagent-core/packages/opencode/src/tool/task.ts

// testagent_change start - 支持并发执行

import { Effect, Fiber } from "effect"

// 在现有 Parameters 后添加批量参数
export const BatchParameters = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      prompt: Schema.String,
      subagent_type: Schema.String,
      task_id: Schema.optional(Schema.String),
    })
  ),
  mode: Schema.optional(Schema.Literal("serial", "parallel", "bounded")),
  max_concurrent: Schema.optional(Schema.Number),
})

// 添加批量任务工具
export const BatchTaskTool = Tool.define(
  "batch_task",
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("BatchTaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof BatchParameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const mode = params.mode ?? "serial"
      const maxConcurrent = params.max_concurrent ?? cfg.experimental?.concurrent_subagents?.max_concurrent ?? 3

      log.info("batch task execution", { 
        mode, 
        taskCount: params.tasks.length,
        maxConcurrent,
      })

      // 准备所有任务
      const taskEffects = yield* Effect.forEach(
        params.tasks,
        (task) => prepareTaskEffect(task, ctx, agent, sessions, config),
        { concurrency: "unbounded" },
      )

      // 根据模式执行
      let results: Array<{ id: string; result: any; error?: Error }>
      
      if (mode === "serial") {
        // 串行执行（现有行为）
        results = []
        for (const taskEffect of taskEffects) {
          try {
            const result = yield* taskEffect.effect
            results.push({ id: taskEffect.id, result })
          } catch (error) {
            results.push({ 
              id: taskEffect.id, 
              result: null, 
              error: error instanceof Error ? error : new Error(String(error)),
            })
          }
        }
      } else if (mode === "parallel") {
        // 完全并行
        const fibers = yield* Effect.forEach(
          taskEffects,
          (te) => Effect.fork(te.effect),
          { concurrency: "unbounded" },
        )
        
        const exits = yield* Effect.forEach(
          fibers,
          (fiber) => Fiber.await(fiber),
          { concurrency: "unbounded" },
        )
        
        results = exits.map((exit, i) => {
          if (Exit.isSuccess(exit)) {
            return { id: taskEffects[i].id, result: exit.value }
          }
          return { 
            id: taskEffects[i].id, 
            result: null, 
            error: new Error("Task failed"),
          }
        })
      } else {
        // 有界并行（bounded）
        results = yield* executeBounded(taskEffects, maxConcurrent)
      }

      // 格式化输出
      return formatBatchResults(results)
    })

    return {
      description: "Execute multiple sub-agent tasks concurrently or serially",
      parameters: BatchParameters,
      execute: (params, ctx) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

// 准备单个任务的 Effect
function* prepareTaskEffect(
  task: any,
  ctx: Tool.Context,
  agent: Agent.Service,
  sessions: Session.Service,
  config: Config.Service,
) {
  const next = yield* agent.get(task.subagent_type)
  if (!next) {
    return yield* Effect.fail(new Error(`Unknown agent: ${task.subagent_type}`))
  }

  const parent = yield* sessions.get(ctx.sessionID)
  const nextSession = yield* sessions.create({
    parentID: ctx.sessionID,
    title: task.description + ` (@${next.name} subagent)`,
    permission: parent.permission,
  })

  const ops = ctx.extra?.promptOps as TaskPromptOps
  if (!ops) {
    return yield* Effect.fail(new Error("Missing promptOps"))
  }

  const effect = Effect.gen(function* () {
    const parts = yield* ops.resolvePromptParts(task.prompt)
    const result = yield* ops.prompt({
      messageID: MessageID.ascending(),
      sessionID: nextSession.id,
      model: next.model ?? { modelID: "gpt-4", providerID: "openai" },
      agent: next.name,
      parts,
    })
    return result
  })

  return {
    id: nextSession.id,
    description: task.description,
    effect,
  }
}

// 有界并行执行
function* executeBounded(
  taskEffects: Array<{ id: string; effect: Effect.Effect<any> }>,
  maxConcurrent: number,
) {
  const results: Array<{ id: string; result: any; error?: Error }> = []
  const queue = [...taskEffects]
  const active: Array<Promise<void>> = []

  while (queue.length > 0 || active.length > 0) {
    // 启动新任务直到达到并发限制
    while (queue.length > 0 && active.length < maxConcurrent) {
      const taskEffect = queue.shift()!
      
      const promise = Effect.runPromise(taskEffect.effect)
        .then((result) => {
          results.push({ id: taskEffect.id, result })
        })
        .catch((error) => {
          results.push({ 
            id: taskEffect.id, 
            result: null, 
            error: error instanceof Error ? error : new Error(String(error)),
          })
        })
        .finally(() => {
          const idx = active.indexOf(promise)
          if (idx !== -1) active.splice(idx, 1)
        })
      
      active.push(promise)
    }

    // 等待至少一个任务完成
    if (active.length > 0) {
      yield* Effect.promise(() => Promise.race(active))
    }
  }

  return results
}

// 格式化批量结果
function formatBatchResults(
  results: Array<{ id: string; result: any; error?: Error }>,
) {
  const successful = results.filter((r) => !r.error)
  const failed = results.filter((r) => r.error)

  return {
    output: [
      `Batch execution completed:`,
      `- Total: ${results.length}`,
      `- Successful: ${successful.length}`,
      `- Failed: ${failed.length}`,
      ``,
      ...results.map((r) => {
        const status = r.error ? "✗" : "✓"
        const msg = r.error ? r.error.message : "completed"
        return `${status} ${r.id}: ${msg}`
      }),
    ].join("\n"),
    metadata: {
      results: results.map((r) => ({
        id: r.id,
        status: r.error ? "error" : "success",
        error: r.error?.message,
      })),
    },
  }
}

// testagent_change end
```

### 步骤 3: 注册工具

```typescript
// packages/testagent-core/packages/opencode/src/tool/registry.ts

// testagent_change start
import { BatchTaskTool } from "./task"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // ... 现有代码
    
    // 注册批量任务工具
    const cfg = yield* Config.Service
    const config = yield* cfg.get()
    
    if (config.experimental?.concurrent_subagents?.enabled) {
      yield* register(BatchTaskTool)
      log.info("batch_task tool registered")
    }
    
    // ... 现有代码
  }),
)
// testagent_change end
```

### 步骤 4: 添加测试

```typescript
// packages/testagent-core/packages/opencode/test/tool/task-concurrent.test.ts

import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { BatchTaskTool } from "@/tool/task"

describe("BatchTaskTool", () => {
  test("executes tasks serially by default", async () => {
    const start = Date.now()
    
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tool = yield* BatchTaskTool
        const def = yield* tool.init()
        
        return yield* def.execute({
          tasks: [
            { description: "Task 1", prompt: "test 1", subagent_type: "general" },
            { description: "Task 2", prompt: "test 2", subagent_type: "general" },
          ],
          mode: "serial",
        }, mockContext())
      })
    )
    
    const duration = Date.now() - start
    expect(result.metadata.results).toHaveLength(2)
    // 串行应该花费更长时间
  })
  
  test("executes tasks in parallel", async () => {
    const start = Date.now()
    
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tool = yield* BatchTaskTool
        const def = yield* tool.init()
        
        return yield* def.execute({
          tasks: [
            { description: "Task 1", prompt: "test 1", subagent_type: "general" },
            { description: "Task 2", prompt: "test 2", subagent_type: "general" },
            { description: "Task 3", prompt: "test 3", subagent_type: "general" },
          ],
          mode: "parallel",
        }, mockContext())
      })
    )
    
    const duration = Date.now() - start
    expect(result.metadata.results).toHaveLength(3)
    // 并行应该更快
  })
  
  test("respects max_concurrent limit", async () => {
    let maxActive = 0
    let currentActive = 0
    
    // 监控并发数的测试逻辑
    // ...
  })
})
```

---

## 方案 B: 更简单的 Hack（仅用于快速验证）

如果你只是想快速验证并发是否可行，可以直接修改 `runtime.queue.ts`：

```typescript
// packages/testagent-core/packages/opencode/src/cli/cmd/run/runtime.queue.ts

// testagent_change start - 临时并发 hack

export async function runPromptQueue(input: QueueInput): Promise<void> {
  // ... 现有代码
  
  const drain = () => {
    if (draining || state.closed || state.queue.length === 0) {
      return
    }

    draining = (async () => {
      try {
        // 🔥 HACK: 检测是否有多个任务，如果有则并行执行
        if (state.queue.length > 1 && process.env.TESTAGENT_CONCURRENT === "true") {
          console.log(`[CONCURRENT] Executing ${state.queue.length} prompts in parallel`)
          
          const tasks = state.queue.splice(0, 3) // 最多 3 个并发
          const promises = tasks.map((prompt) => 
            input.run(prompt, new AbortController().signal)
          )
          
          await Promise.all(promises)
          
          emit({ type: "turn.idle", queue: state.queue.length }, {})
          return
        }
        
        // 原有串行逻辑
        while (!state.closed && state.queue.length > 0) {
          const prompt = state.queue.shift()
          // ... 现有代码
        }
      } catch (error) {
        // ...
      }
    })()
  }
  
  // ... 现有代码
}

// testagent_change end
```

使用方式：

```bash
# 启用并发
export TESTAGENT_CONCURRENT=true
bun run dev
```

---

## 使用示例

### 配置文件

```json
// .kiro/config.json
{
  "experimental": {
    "concurrent_subagents": {
      "enabled": true,
      "max_concurrent": 3,
      "timeout": 300000
    }
  }
}
```

### Agent Prompt

```
Please analyze these files concurrently:

Use batch_task with:
- Task 1: Check security in auth.ts
- Task 2: Review performance in db.ts
- Task 3: Find bugs in api.ts

Execute in parallel mode.
```

### 工具调用

```json
{
  "tool": "batch_task",
  "parameters": {
    "tasks": [
      {
        "description": "Security check",
        "prompt": "Analyze auth.ts for security issues",
        "subagent_type": "security-analyst"
      },
      {
        "description": "Performance review",
        "prompt": "Review db.ts for performance problems",
        "subagent_type": "performance-expert"
      },
      {
        "description": "Bug detection",
        "prompt": "Find bugs in api.ts",
        "subagent_type": "bug-hunter"
      }
    ],
    "mode": "bounded",
    "max_concurrent": 2
  }
}
```

---

## 验证步骤

### 1. 单元测试

```bash
cd packages/testagent-core
bun test test/tool/task-concurrent.test.ts
```

### 2. 集成测试

```bash
# 启动 testagent
bun run dev

# 在 chat 中测试
> Use batch_task to analyze 3 files concurrently
```

### 3. 性能对比

```typescript
// 测试脚本
const testSerial = async () => {
  const start = Date.now()
  // 执行 3 个串行任务
  console.log(`Serial: ${Date.now() - start}ms`)
}

const testParallel = async () => {
  const start = Date.now()
  // 执行 3 个并行任务
  console.log(`Parallel: ${Date.now() - start}ms`)
}
```

预期结果：
- 串行：~90秒（3 × 30秒）
- 并行：~35秒（max(30秒) + 开销）
- 加速比：~2.5x

---

## 注意事项

### 1. 资源冲突

并发执行可能导致文件系统冲突：

```typescript
// 临时解决方案：在 task 工具中添加只读限制
const nextSession = yield* sessions.create({
  parentID: ctx.sessionID,
  title: task.description,
  permission: [
    // 只允许读操作
    { permission: "read_file", pattern: "*", action: "allow" },
    { permission: "grep_search", pattern: "*", action: "allow" },
    // 禁止写操作
    { permission: "fs_write", pattern: "*", action: "deny" },
    { permission: "execute_bash", pattern: "*", action: "deny" },
  ],
})
```

### 2. 内存占用

并发会增加内存使用：

```typescript
// 监控内存
const before = process.memoryUsage()
await executeBatch(tasks)
const after = process.memoryUsage()
console.log(`Memory delta: ${(after.heapUsed - before.heapUsed) / 1024 / 1024}MB`)
```

### 3. 错误处理

确保单个任务失败不影响其他：

```typescript
try {
  const result = yield* taskEffect.effect
  results.push({ id, result })
} catch (error) {
  log.error("task failed", { id, error })
  results.push({ id, result: null, error })
  // 继续执行其他任务
}
```

---

## 下一步

1. ✅ 实现基础并发调度器
2. ✅ 添加配置支持
3. ✅ 实现 batch_task 工具
4. ⏳ 添加资源锁机制
5. ⏳ 实现并发监控
6. ⏳ 性能优化和压测

---

## 总结

**最小集成方案**只需修改 3 个文件：
1. `config.ts` - 添加配置
2. `task.ts` - 添加 BatchTaskTool
3. `registry.ts` - 注册工具

**工作量估算**：
- 核心实现：2-3 天
- 测试验证：1-2 天
- 文档和优化：1 天
- **总计：4-6 天**

**风险**：低（向后兼容，默认串行）

**收益**：
- 2-3x 性能提升（IO 密集型任务）
- 更好的用户体验
- 为未来分布式调度打基础
