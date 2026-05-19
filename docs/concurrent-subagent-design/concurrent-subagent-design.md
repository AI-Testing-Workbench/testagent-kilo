# testagent-core 子 Agent 并发调度技术方案

## 1. 方案概述

在保持现有架构稳定性的前提下，增加可选的并发子 agent 调度能力。

### 设计原则

- **向后兼容**：默认保持串行行为，通过配置启用并发
- **资源隔离**：每个子 agent 独立的资源上下文
- **错误隔离**：单个子 agent 失败不影响其他
- **可观测性**：清晰的并发状态追踪和日志

---

## 2. 核心架构设计

### 2.1 并发模型选择

```typescript
// 三种并发模式
type ConcurrencyMode = 
  | "serial"      // 串行（默认，现有行为）
  | "parallel"    // 完全并行（所有子 agent 同时执行）
  | "bounded"     // 有界并行（限制最大并发数）

interface ConcurrencyConfig {
  mode: ConcurrencyMode
  maxConcurrent?: number  // bounded 模式下的最大并发数
  timeout?: number        // 单个子 agent 超时时间（ms）
  failFast?: boolean      // 是否在首个失败时立即终止所有
}
```

### 2.2 配置层

```typescript
// packages/testagent-core/packages/opencode/src/config/config.ts

export const Config = {
  // ... 现有配置
  
  // testagent_change start
  experimental: {
    subagent_concurrency: {
      enabled: boolean          // 是否启用并发
      mode: ConcurrencyMode     // 并发模式
      max_concurrent: number    // 最大并发数（默认 3）
      timeout: number           // 超时时间（默认 300000ms = 5分钟）
      fail_fast: boolean        // 快速失败（默认 false）
    }
  }
  // testagent_change end
}
```

---

## 3. 实现方案

### 3.1 新增并发调度器

创建 `packages/testagent-core/packages/opencode/src/session/concurrent-scheduler.ts`

```typescript
import { Effect, Queue, Fiber, Ref, Scope } from "effect"
import { SessionID, MessageID } from "./schema"
import { MessageV2 } from "./message-v2"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "concurrent-scheduler" })

export interface TaskInput {
  id: string
  sessionID: SessionID
  description: string
  execute: () => Effect.Effect<MessageV2.WithParts>
}

export interface TaskResult {
  id: string
  result: MessageV2.WithParts | Error
  duration: number
  status: "success" | "error" | "timeout"
}

export interface SchedulerConfig {
  mode: "serial" | "parallel" | "bounded"
  maxConcurrent: number
  timeout: number
  failFast: boolean
}

export class ConcurrentScheduler {
  static create(config: SchedulerConfig) {
    return Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const activeCount = yield* Ref.make(0)
      const results = yield* Ref.make<TaskResult[]>([])
      
      return {
        schedule: (tasks: TaskInput[]) => 
          scheduleImpl(tasks, config, activeCount, results, scope),
        
        getActiveCount: () => Ref.get(activeCount),
        getResults: () => Ref.get(results),
      }
    })
  }
}

function* scheduleImpl(
  tasks: TaskInput[],
  config: SchedulerConfig,
  activeCount: Ref.Ref<number>,
  results: Ref.Ref<TaskResult[]>,
  scope: Scope.Scope,
) {
  log.info("scheduling tasks", { 
    count: tasks.length, 
    mode: config.mode,
    maxConcurrent: config.maxConcurrent 
  })

  switch (config.mode) {
    case "serial":
      return yield* executeSerial(tasks, results)
    
    case "parallel":
      return yield* executeParallel(tasks, config, results, scope)
    
    case "bounded":
      return yield* executeBounded(tasks, config, activeCount, results, scope)
  }
}

// 串行执行（现有行为）
function* executeSerial(
  tasks: TaskInput[],
  results: Ref.Ref<TaskResult[]>,
) {
  const output: TaskResult[] = []
  
  for (const task of tasks) {
    const start = Date.now()
    try {
      const result = yield* task.execute()
      const taskResult: TaskResult = {
        id: task.id,
        result,
        duration: Date.now() - start,
        status: "success",
      }
      output.push(taskResult)
      yield* Ref.update(results, (prev) => [...prev, taskResult])
    } catch (error) {
      const taskResult: TaskResult = {
        id: task.id,
        result: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - start,
        status: "error",
      }
      output.push(taskResult)
      yield* Ref.update(results, (prev) => [...prev, taskResult])
    }
  }
  
  return output
}

// 完全并行执行
function* executeParallel(
  tasks: TaskInput[],
  config: SchedulerConfig,
  results: Ref.Ref<TaskResult[]>,
  scope: Scope.Scope,
) {
  const fibers = yield* Effect.forEach(
    tasks,
    (task) => executeTask(task, config.timeout, results).pipe(
      Effect.fork,
      Scope.extend(scope),
    ),
    { concurrency: "unbounded" },
  )
  
  const exits = yield* Effect.forEach(
    fibers,
    (fiber) => Fiber.await(fiber),
    { concurrency: "unbounded" },
  )
  
  return exits.map((exit, i) => {
    if (Exit.isSuccess(exit)) return exit.value
    return {
      id: tasks[i].id,
      result: new Error("Task failed"),
      duration: 0,
      status: "error" as const,
    }
  })
}

// 有界并行执行（推荐）
function* executeBounded(
  tasks: TaskInput[],
  config: SchedulerConfig,
  activeCount: Ref.Ref<number>,
  results: Ref.Ref<TaskResult[]>,
  scope: Scope.Scope,
) {
  const queue = yield* Queue.bounded<TaskInput>(tasks.length)
  
  // 填充队列
  yield* Effect.forEach(tasks, (task) => Queue.offer(queue, task), {
    discard: true,
  })
  
  // 创建 worker pool
  const workers = Array.from({ length: config.maxConcurrent }, (_, i) =>
    worker(i, queue, config.timeout, activeCount, results),
  )
  
  const fibers = yield* Effect.forEach(
    workers,
    (w) => w.pipe(Effect.fork, Scope.extend(scope)),
    { concurrency: "unbounded" },
  )
  
  // 等待所有任务完成
  yield* Effect.forEach(fibers, Fiber.join, { concurrency: "unbounded" })
  
  return yield* Ref.get(results)
}

// Worker 函数
function* worker(
  id: number,
  queue: Queue.Queue<TaskInput>,
  timeout: number,
  activeCount: Ref.Ref<number>,
  results: Ref.Ref<TaskResult[]>,
) {
  while (true) {
    const task = yield* Queue.take(queue).pipe(
      Effect.timeout(Duration.millis(100)),
      Effect.option,
    )
    
    if (Option.isNone(task)) break
    
    yield* Ref.update(activeCount, (n) => n + 1)
    
    try {
      const result = yield* executeTask(task.value, timeout, results)
      log.debug("worker completed task", { 
        worker: id, 
        task: task.value.id,
        status: result.status,
      })
    } finally {
      yield* Ref.update(activeCount, (n) => n - 1)
    }
  }
}

// 执行单个任务（带超时）
function* executeTask(
  task: TaskInput,
  timeout: number,
  results: Ref.Ref<TaskResult[]>,
) {
  const start = Date.now()
  
  const result = yield* task.execute().pipe(
    Effect.timeout(Duration.millis(timeout)),
    Effect.match({
      onFailure: (error) => ({
        id: task.id,
        result: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - start,
        status: "error" as const,
      }),
      onSuccess: (value) => {
        if (Option.isNone(value)) {
          return {
            id: task.id,
            result: new Error("Task timeout"),
            duration: Date.now() - start,
            status: "timeout" as const,
          }
        }
        return {
          id: task.id,
          result: value.value,
          duration: Date.now() - start,
          status: "success" as const,
        }
      },
    }),
  )
  
  yield* Ref.update(results, (prev) => [...prev, result])
  return result
}
```

### 3.2 修改 Task 工具

修改 `packages/testagent-core/packages/opencode/src/tool/task.ts`

```typescript
// testagent_change start - 支持批量并发调度

import { ConcurrentScheduler } from "@/session/concurrent-scheduler"

// 新增批量任务参数
export const BatchParameters = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      prompt: Schema.String,
      subagent_type: Schema.String,
      task_id: Schema.optional(Schema.String),
    })
  ),
  concurrency: Schema.optional(
    Schema.Struct({
      mode: Schema.Literal("serial", "parallel", "bounded"),
      max_concurrent: Schema.optional(Schema.Number),
      timeout: Schema.optional(Schema.Number),
      fail_fast: Schema.optional(Schema.Boolean),
    })
  ),
})

// 新增批量任务工具
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
      
      // 获取并发配置
      const concurrencyConfig = {
        mode: params.concurrency?.mode ?? cfg.experimental?.subagent_concurrency?.mode ?? "serial",
        maxConcurrent: params.concurrency?.max_concurrent ?? cfg.experimental?.subagent_concurrency?.max_concurrent ?? 3,
        timeout: params.concurrency?.timeout ?? cfg.experimental?.subagent_concurrency?.timeout ?? 300000,
        failFast: params.concurrency?.fail_fast ?? cfg.experimental?.subagent_concurrency?.fail_fast ?? false,
      }

      // 创建调度器
      const scheduler = yield* ConcurrentScheduler.create(concurrencyConfig)

      // 准备任务
      const taskInputs = yield* Effect.forEach(
        params.tasks,
        (task) => prepareTask(task, ctx, agent, sessions, config),
        { concurrency: "unbounded" },
      )

      // 执行调度
      const results = yield* scheduler.schedule(taskInputs)

      // 格式化输出
      return formatBatchResults(results)
    })

    return {
      description: "Execute multiple sub-agent tasks with optional concurrency control",
      parameters: BatchParameters,
      execute: (params, ctx) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

function* prepareTask(
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

  return {
    id: nextSession.id,
    sessionID: nextSession.id,
    description: task.description,
    execute: () =>
      Effect.gen(function* () {
        const parts = yield* ops.resolvePromptParts(task.prompt)
        return yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: next.model ?? { modelID: "...", providerID: "..." },
          agent: next.name,
          parts,
        })
      }),
  }
}

function formatBatchResults(results: TaskResult[]) {
  const successful = results.filter((r) => r.status === "success")
  const failed = results.filter((r) => r.status !== "success")

  return {
    output: [
      `Batch execution completed:`,
      `- Total: ${results.length}`,
      `- Successful: ${successful.length}`,
      `- Failed: ${failed.length}`,
      ``,
      ...results.map((r) => {
        const status = r.status === "success" ? "✓" : "✗"
        const duration = `${r.duration}ms`
        return `${status} ${r.id} (${duration})`
      }),
    ].join("\n"),
    metadata: {
      results: results.map((r) => ({
        id: r.id,
        status: r.status,
        duration: r.duration,
      })),
    },
  }
}

// testagent_change end
```

### 3.3 修改 Tool Registry

修改 `packages/testagent-core/packages/opencode/src/tool/registry.ts`

```typescript
// testagent_change start - 注册批量任务工具

import { BatchTaskTool } from "./task"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // ... 现有代码
    
    // 注册批量任务工具
    const cfg = yield* Config.Service.pipe(Effect.map((s) => s.get()))
    const config = yield* cfg
    
    if (config.experimental?.subagent_concurrency?.enabled) {
      yield* register(BatchTaskTool)
    }
    
    // ... 现有代码
  }),
)

// testagent_change end
```

---

## 4. 使用示例

### 4.1 配置文件

```json
// .kiro/config.json
{
  "experimental": {
    "subagent_concurrency": {
      "enabled": true,
      "mode": "bounded",
      "max_concurrent": 3,
      "timeout": 300000,
      "fail_fast": false
    }
  }
}
```

### 4.2 Agent 调用示例

```typescript
// 用户 prompt
"Please analyze these three files concurrently:
1. Check security issues in auth.ts
2. Review performance in database.ts  
3. Find bugs in api.ts"

// Agent 会调用 batch_task 工具
{
  "tasks": [
    {
      "description": "Security check",
      "prompt": "Analyze auth.ts for security vulnerabilities",
      "subagent_type": "security-analyst"
    },
    {
      "description": "Performance review",
      "prompt": "Review database.ts for performance issues",
      "subagent_type": "performance-expert"
    },
    {
      "description": "Bug detection",
      "prompt": "Find bugs in api.ts",
      "subagent_type": "bug-hunter"
    }
  ],
  "concurrency": {
    "mode": "bounded",
    "max_concurrent": 3
  }
}
```

---

## 5. 资源隔离策略

### 5.1 文件系统隔离

```typescript
// packages/testagent-core/packages/opencode/src/session/resource-lock.ts

export class ResourceLock {
  private locks = new Map<string, Set<SessionID>>()
  
  async acquireRead(path: string, sessionID: SessionID): Promise<void> {
    // 多个 session 可以同时读
    const readers = this.locks.get(path) ?? new Set()
    readers.add(sessionID)
    this.locks.set(path, readers)
  }
  
  async acquireWrite(path: string, sessionID: SessionID): Promise<void> {
    // 写操作需要独占
    const existing = this.locks.get(path)
    if (existing && existing.size > 0) {
      throw new Error(`Resource ${path} is locked`)
    }
    this.locks.set(path, new Set([sessionID]))
  }
  
  release(path: string, sessionID: SessionID): void {
    const locks = this.locks.get(path)
    if (locks) {
      locks.delete(sessionID)
      if (locks.size === 0) {
        this.locks.delete(path)
      }
    }
  }
}
```

### 5.2 工具权限隔离

```typescript
// 每个子 agent 有独立的工具权限
const nextSession = yield* sessions.create({
  parentID: ctx.sessionID,
  title: task.description,
  permission: [
    // 继承父 session 的只读权限
    ...parent.permission.filter((r) => r.action === "deny" || isReadOnly(r)),
    
    // 限制写操作工具
    { permission: "fs_write", pattern: "*", action: "deny" },
    { permission: "execute_bash", pattern: "*", action: "deny" },
    
    // 允许读操作工具
    { permission: "read_file", pattern: "*", action: "allow" },
    { permission: "grep_search", pattern: "*", action: "allow" },
  ],
})
```

---

## 6. 监控和可观测性

### 6.1 并发状态追踪

```typescript
// packages/testagent-core/packages/opencode/src/session/concurrent-monitor.ts

export interface ConcurrentMetrics {
  activeSubagents: number
  queuedTasks: number
  completedTasks: number
  failedTasks: number
  averageDuration: number
}

export class ConcurrentMonitor {
  private metrics: Ref.Ref<ConcurrentMetrics>
  
  async getMetrics(): Promise<ConcurrentMetrics> {
    return Ref.get(this.metrics)
  }
  
  async recordTaskStart(taskId: string): Promise<void> {
    // 记录任务开始
  }
  
  async recordTaskComplete(taskId: string, duration: number): Promise<void> {
    // 记录任务完成
  }
}
```

### 6.2 日志增强

```typescript
log.info("concurrent execution started", {
  mode: config.mode,
  taskCount: tasks.length,
  maxConcurrent: config.maxConcurrent,
})

log.debug("task completed", {
  taskId: task.id,
  duration: result.duration,
  status: result.status,
  activeCount: await activeCount.get(),
})
```

---

## 7. 测试策略

### 7.1 单元测试

```typescript
// packages/testagent-core/packages/opencode/test/session/concurrent-scheduler.test.ts

describe("ConcurrentScheduler", () => {
  test("serial mode executes tasks sequentially", async () => {
    const order: number[] = []
    const tasks = [1, 2, 3].map((i) => ({
      id: `task-${i}`,
      execute: () => Effect.sync(() => order.push(i)),
    }))
    
    await scheduler.schedule(tasks)
    expect(order).toEqual([1, 2, 3])
  })
  
  test("parallel mode executes tasks concurrently", async () => {
    const start = Date.now()
    const tasks = [1, 2, 3].map((i) => ({
      id: `task-${i}`,
      execute: () => Effect.sleep(Duration.millis(100)),
    }))
    
    await scheduler.schedule(tasks)
    const duration = Date.now() - start
    expect(duration).toBeLessThan(200) // 并行应该 < 300ms
  })
  
  test("bounded mode respects max concurrent limit", async () => {
    let maxActive = 0
    let currentActive = 0
    
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `task-${i}`,
      execute: () => Effect.gen(function* () {
        currentActive++
        maxActive = Math.max(maxActive, currentActive)
        yield* Effect.sleep(Duration.millis(50))
        currentActive--
      }),
    }))
    
    await scheduler.schedule(tasks)
    expect(maxActive).toBeLessThanOrEqual(3)
  })
})
```

### 7.2 集成测试

```typescript
test("batch_task tool executes multiple subagents", async () => {
  const result = await runTool("batch_task", {
    tasks: [
      { description: "Task 1", prompt: "...", subagent_type: "agent1" },
      { description: "Task 2", prompt: "...", subagent_type: "agent2" },
    ],
    concurrency: { mode: "parallel" },
  })
  
  expect(result.metadata.results).toHaveLength(2)
  expect(result.metadata.results.every((r) => r.status === "success")).toBe(true)
})
```

---

## 8. 迁移路径

### Phase 1: 基础设施（2-3 天）
- [ ] 实现 `ConcurrentScheduler`
- [ ] 添加配置支持
- [ ] 单元测试

### Phase 2: 工具集成（2-3 天）
- [ ] 实现 `BatchTaskTool`
- [ ] 修改 `TaskTool` 支持并发配置
- [ ] 集成测试

### Phase 3: 资源隔离（3-4 天）
- [ ] 实现 `ResourceLock`
- [ ] 工具权限隔离
- [ ] 冲突检测和处理

### Phase 4: 监控和优化（2-3 天）
- [ ] 实现 `ConcurrentMonitor`
- [ ] 日志增强
- [ ] 性能优化

### Phase 5: 文档和发布（1-2 天）
- [ ] 用户文档
- [ ] API 文档
- [ ] 发布 beta 版本

**总计：10-15 天**

---

## 9. 风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 文件系统竞争 | 高 | 实现 ResourceLock，写操作串行化 |
| 内存占用增加 | 中 | 限制最大并发数，监控内存使用 |
| 错误传播 | 中 | 错误隔离，fail_fast 可选 |
| 调试困难 | 中 | 增强日志，并发状态可视化 |
| 向后兼容性 | 低 | 默认串行模式，显式启用并发 |

---

## 10. 性能预期

### 理想场景（IO 密集型任务）

- **串行**: 3 个任务 × 30秒 = 90秒
- **并行**: max(30秒) ≈ 30秒
- **加速比**: 3x

### 实际场景（混合任务）

- **串行**: 3 个任务 × 25秒 = 75秒
- **有界并行(3)**: max(25秒) + 调度开销 ≈ 28秒
- **加速比**: 2.5x

---

## 11. 后续优化方向

1. **智能调度**：根据任务类型（CPU/IO 密集）动态调整并发度
2. **依赖图**：支持任务间依赖关系，自动拓扑排序
3. **优先级队列**：支持任务优先级
4. **资源预测**：基于历史数据预测任务资源需求
5. **分布式调度**：跨多个 testagent 实例分布任务

---

## 12. 参考实现

- Effect-TS 并发原语：https://effect.website/docs/concurrency
- Temporal workflow 并发模型
- Kubernetes Job 并发控制
- Apache Airflow DAG 调度

