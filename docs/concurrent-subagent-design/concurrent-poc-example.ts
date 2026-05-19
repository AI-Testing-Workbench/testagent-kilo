/**
 * testagent-core 并发子 Agent 调度 - POC 实现示例
 * 
 * 这是一个简化的概念验证实现，展示核心并发调度逻辑
 */

import { Effect, Queue, Fiber, Ref, Duration, Exit, Option } from "effect"

// ============================================================================
// 1. 类型定义
// ============================================================================

type TaskId = string
type SessionId = string

interface Task {
  id: TaskId
  sessionId: SessionId
  description: string
  execute: () => Effect.Effect<string, Error>
}

interface TaskResult {
  id: TaskId
  status: "success" | "error" | "timeout"
  result: string | Error
  duration: number
  startTime: number
  endTime: number
}

interface SchedulerConfig {
  mode: "serial" | "parallel" | "bounded"
  maxConcurrent: number
  timeout: number
  failFast: boolean
}

interface SchedulerMetrics {
  totalTasks: number
  completedTasks: number
  failedTasks: number
  activeCount: number
  queuedCount: number
}

// ============================================================================
// 2. 核心调度器实现
// ============================================================================

class ConcurrentScheduler {
  private activeCount: Ref.Ref<number>
  private results: Ref.Ref<TaskResult[]>
  private metrics: Ref.Ref<SchedulerMetrics>

  private constructor(
    activeCount: Ref.Ref<number>,
    results: Ref.Ref<TaskResult[]>,
    metrics: Ref.Ref<SchedulerMetrics>,
  ) {
    this.activeCount = activeCount
    this.results = results
    this.metrics = metrics
  }

  static create() {
    return Effect.gen(function* () {
      const activeCount = yield* Ref.make(0)
      const results = yield* Ref.make<TaskResult[]>([])
      const metrics = yield* Ref.make<SchedulerMetrics>({
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        activeCount: 0,
        queuedCount: 0,
      })

      return new ConcurrentScheduler(activeCount, results, metrics)
    })
  }

  schedule(tasks: Task[], config: SchedulerConfig) {
    return Effect.gen(function* () {
      // 更新指标
      yield* Ref.update(this.metrics, (m) => ({
        ...m,
        totalTasks: tasks.length,
        queuedCount: tasks.length,
      }))

      console.log(`[Scheduler] Starting ${config.mode} execution of ${tasks.length} tasks`)

      // 根据模式选择执行策略
      switch (config.mode) {
        case "serial":
          return yield* this.executeSerial(tasks, config)
        case "parallel":
          return yield* this.executeParallel(tasks, config)
        case "bounded":
          return yield* this.executeBounded(tasks, config)
      }
    }).pipe(Effect.withSpan("ConcurrentScheduler.schedule"))
  }

  // 串行执行
  private executeSerial(tasks: Task[], config: SchedulerConfig) {
    return Effect.gen(function* () {
      const results: TaskResult[] = []

      for (const task of tasks) {
        console.log(`[Serial] Executing task: ${task.id}`)
        const result = yield* this.executeTask(task, config)
        results.push(result)

        // fail-fast 检查
        if (config.failFast && result.status !== "success") {
          console.log(`[Serial] Fail-fast triggered by task: ${task.id}`)
          break
        }
      }

      return results
    })
  }

  // 完全并行执行
  private executeParallel(tasks: Task[], config: SchedulerConfig) {
    return Effect.gen(function* () {
      console.log(`[Parallel] Launching ${tasks.length} tasks concurrently`)

      // 启动所有任务
      const fibers = yield* Effect.forEach(
        tasks,
        (task) =>
          this.executeTask(task, config).pipe(
            Effect.fork,
          ),
        { concurrency: "unbounded" },
      )

      // 等待所有任务完成
      const exits = yield* Effect.forEach(
        fibers,
        (fiber) => Fiber.await(fiber),
        { concurrency: "unbounded" },
      )

      // 收集结果
      const results: TaskResult[] = []
      for (let i = 0; i < exits.length; i++) {
        const exit = exits[i]
        if (Exit.isSuccess(exit)) {
          results.push(exit.value)
        } else {
          results.push({
            id: tasks[i].id,
            status: "error",
            result: new Error("Task execution failed"),
            duration: 0,
            startTime: Date.now(),
            endTime: Date.now(),
          })
        }
      }

      return results
    })
  }

  // 有界并行执行（推荐）
  private executeBounded(tasks: Task[], config: SchedulerConfig) {
    return Effect.gen(function* () {
      console.log(`[Bounded] Executing with max concurrency: ${config.maxConcurrent}`)

      // 创建任务队列
      const queue = yield* Queue.bounded<Task>(tasks.length)

      // 填充队列
      yield* Effect.forEach(tasks, (task) => Queue.offer(queue, task), {
        discard: true,
      })

      // 创建 worker pool
      const workers = Array.from({ length: config.maxConcurrent }, (_, i) =>
        this.worker(i, queue, config),
      )

      // 启动所有 workers
      const fibers = yield* Effect.forEach(
        workers,
        (worker) => Effect.fork(worker),
        { concurrency: "unbounded" },
      )

      // 等待所有 workers 完成
      yield* Effect.forEach(fibers, Fiber.join, { concurrency: "unbounded" })

      // 返回结果
      return yield* Ref.get(this.results)
    })
  }

  // Worker 函数
  private worker(workerId: number, queue: Queue.Queue<Task>, config: SchedulerConfig) {
    return Effect.gen(function* () {
      console.log(`[Worker ${workerId}] Started`)

      while (true) {
        // 从队列取任务（带超时）
        const taskOption = yield* Queue.take(queue).pipe(
          Effect.timeout(Duration.millis(100)),
          Effect.option,
        )

        // 队列为空，退出
        if (Option.isNone(taskOption)) {
          console.log(`[Worker ${workerId}] No more tasks, exiting`)
          break
        }

        const task = taskOption.value

        // 更新活跃计数
        yield* Ref.update(this.activeCount, (n) => n + 1)
        yield* Ref.update(this.metrics, (m) => ({
          ...m,
          activeCount: m.activeCount + 1,
          queuedCount: m.queuedCount - 1,
        }))

        console.log(`[Worker ${workerId}] Executing task: ${task.id}`)

        try {
          // 执行任务
          const result = yield* this.executeTask(task, config)

          console.log(
            `[Worker ${workerId}] Task ${task.id} completed: ${result.status} (${result.duration}ms)`,
          )

          // fail-fast 检查
          if (config.failFast && result.status !== "success") {
            console.log(`[Worker ${workerId}] Fail-fast triggered, stopping`)
            break
          }
        } finally {
          // 更新活跃计数
          yield* Ref.update(this.activeCount, (n) => n - 1)
          yield* Ref.update(this.metrics, (m) => ({
            ...m,
            activeCount: m.activeCount - 1,
          }))
        }
      }

      console.log(`[Worker ${workerId}] Stopped`)
    })
  }

  // 执行单个任务（带超时和错误处理）
  private executeTask(task: Task, config: SchedulerConfig) {
    return Effect.gen(function* () {
      const startTime = Date.now()

      // 执行任务（带超时）
      const resultOption = yield* task.execute().pipe(
        Effect.timeout(Duration.millis(config.timeout)),
        Effect.match({
          onFailure: (error) => ({
            type: "error" as const,
            error: error instanceof Error ? error : new Error(String(error)),
          }),
          onSuccess: (value) => {
            if (Option.isNone(value)) {
              return { type: "timeout" as const }
            }
            return { type: "success" as const, value: value.value }
          },
        }),
      )

      const endTime = Date.now()
      const duration = endTime - startTime

      // 构造结果
      let result: TaskResult
      if (resultOption.type === "success") {
        result = {
          id: task.id,
          status: "success",
          result: resultOption.value,
          duration,
          startTime,
          endTime,
        }
        yield* Ref.update(this.metrics, (m) => ({
          ...m,
          completedTasks: m.completedTasks + 1,
        }))
      } else if (resultOption.type === "timeout") {
        result = {
          id: task.id,
          status: "timeout",
          result: new Error(`Task timeout after ${config.timeout}ms`),
          duration,
          startTime,
          endTime,
        }
        yield* Ref.update(this.metrics, (m) => ({
          ...m,
          failedTasks: m.failedTasks + 1,
        }))
      } else {
        result = {
          id: task.id,
          status: "error",
          result: resultOption.error,
          duration,
          startTime,
          endTime,
        }
        yield* Ref.update(this.metrics, (m) => ({
          ...m,
          failedTasks: m.failedTasks + 1,
        }))
      }

      // 保存结果
      yield* Ref.update(this.results, (prev) => [...prev, result])

      return result
    })
  }

  getMetrics() {
    return Ref.get(this.metrics)
  }

  getResults() {
    return Ref.get(this.results)
  }
}

// ============================================================================
// 3. 使用示例
// ============================================================================

// 模拟子 agent 任务
function createMockTask(id: string, duration: number, shouldFail = false): Task {
  return {
    id,
    sessionId: `session-${id}`,
    description: `Task ${id}`,
    execute: () =>
      Effect.gen(function* () {
        console.log(`  [Task ${id}] Started (will take ${duration}ms)`)
        yield* Effect.sleep(Duration.millis(duration))

        if (shouldFail) {
          console.log(`  [Task ${id}] Failed!`)
          return yield* Effect.fail(new Error(`Task ${id} failed`))
        }

        console.log(`  [Task ${id}] Completed successfully`)
        return `Result from task ${id}`
      }),
  }
}

// ============================================================================
// 4. 测试场景
// ============================================================================

// 场景 1: 串行执行
const testSerial = Effect.gen(function* () {
  console.log("\n=== Test 1: Serial Execution ===\n")

  const scheduler = yield* ConcurrentScheduler.create()
  const tasks = [
    createMockTask("A", 1000),
    createMockTask("B", 1000),
    createMockTask("C", 1000),
  ]

  const start = Date.now()
  const results = yield* scheduler.schedule(tasks, {
    mode: "serial",
    maxConcurrent: 1,
    timeout: 5000,
    failFast: false,
  })
  const duration = Date.now() - start

  console.log(`\nTotal duration: ${duration}ms (expected ~3000ms)`)
  console.log(`Results: ${results.length} tasks completed`)
  results.forEach((r) => console.log(`  - ${r.id}: ${r.status} (${r.duration}ms)`))
})

// 场景 2: 完全并行执行
const testParallel = Effect.gen(function* () {
  console.log("\n=== Test 2: Parallel Execution ===\n")

  const scheduler = yield* ConcurrentScheduler.create()
  const tasks = [
    createMockTask("A", 1000),
    createMockTask("B", 1000),
    createMockTask("C", 1000),
  ]

  const start = Date.now()
  const results = yield* scheduler.schedule(tasks, {
    mode: "parallel",
    maxConcurrent: 10,
    timeout: 5000,
    failFast: false,
  })
  const duration = Date.now() - start

  console.log(`\nTotal duration: ${duration}ms (expected ~1000ms)`)
  console.log(`Results: ${results.length} tasks completed`)
  results.forEach((r) => console.log(`  - ${r.id}: ${r.status} (${r.duration}ms)`))
})

// 场景 3: 有界并行执行
const testBounded = Effect.gen(function* () {
  console.log("\n=== Test 3: Bounded Parallel Execution (max=2) ===\n")

  const scheduler = yield* ConcurrentScheduler.create()
  const tasks = [
    createMockTask("A", 1000),
    createMockTask("B", 1000),
    createMockTask("C", 1000),
    createMockTask("D", 1000),
  ]

  const start = Date.now()
  const results = yield* scheduler.schedule(tasks, {
    mode: "bounded",
    maxConcurrent: 2,
    timeout: 5000,
    failFast: false,
  })
  const duration = Date.now() - start

  console.log(`\nTotal duration: ${duration}ms (expected ~2000ms)`)
  console.log(`Results: ${results.length} tasks completed`)
  results.forEach((r) => console.log(`  - ${r.id}: ${r.status} (${r.duration}ms)`))
})

// 场景 4: 错误处理和 fail-fast
const testFailFast = Effect.gen(function* () {
  console.log("\n=== Test 4: Fail-Fast Behavior ===\n")

  const scheduler = yield* ConcurrentScheduler.create()
  const tasks = [
    createMockTask("A", 500),
    createMockTask("B", 500, true), // 这个会失败
    createMockTask("C", 500),
    createMockTask("D", 500),
  ]

  const results = yield* scheduler.schedule(tasks, {
    mode: "serial",
    maxConcurrent: 1,
    timeout: 5000,
    failFast: true,
  })

  console.log(`\nResults: ${results.length} tasks completed (expected 2, stopped at failure)`)
  results.forEach((r) => console.log(`  - ${r.id}: ${r.status}`))
})

// 场景 5: 超时处理
const testTimeout = Effect.gen(function* () {
  console.log("\n=== Test 5: Timeout Handling ===\n")

  const scheduler = yield* ConcurrentScheduler.create()
  const tasks = [
    createMockTask("A", 500),
    createMockTask("B", 3000), // 这个会超时
    createMockTask("C", 500),
  ]

  const results = yield* scheduler.schedule(tasks, {
    mode: "parallel",
    maxConcurrent: 10,
    timeout: 1000, // 1秒超时
    failFast: false,
  })

  console.log(`\nResults: ${results.length} tasks completed`)
  results.forEach((r) => {
    const status = r.status === "timeout" ? "⏱️  TIMEOUT" : r.status
    console.log(`  - ${r.id}: ${status} (${r.duration}ms)`)
  })
})

// ============================================================================
// 5. 运行所有测试
// ============================================================================

const runAllTests = Effect.gen(function* () {
  yield* testSerial
  yield* testParallel
  yield* testBounded
  yield* testFailFast
  yield* testTimeout

  console.log("\n=== All Tests Completed ===\n")
})

// 导出供外部使用
export { ConcurrentScheduler, type Task, type TaskResult, type SchedulerConfig }

// 如果直接运行此文件
if (import.meta.main) {
  Effect.runPromise(runAllTests).catch(console.error)
}
