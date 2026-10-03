import { randomUUID } from "node:crypto"
import type { SkillEvaluationRequest, SkillEvaluationVersion } from "./skill-evaluation"
import type { CreateWorktreeResult } from "./WorktreeManager"

export interface EvaluationWorktree {
  id: string
  versionId: string
  result: CreateWorktreeResult
  path: string
  branch: string
  parentBranch: string
  remote?: string
}

export interface EvaluationHost {
  create: (item: SkillEvaluationVersion, group: string) => Promise<EvaluationWorktree | undefined>
  setup: (tree: EvaluationWorktree) => Promise<void>
  install: (item: SkillEvaluationVersion, tree: EvaluationWorktree, run: string, variant: string) => Promise<string>
  finish: (tree: EvaluationWorktree) => Promise<string | undefined>
  run: (item: SkillEvaluationVersion, tree: EvaluationWorktree, session: string, content: string) => Promise<void>
  remove: (tree: EvaluationWorktree) => Promise<void>
  progress: (status: "creating" | "done", total: number, completed: number, group: string) => void
  error: (message: string) => void
  log: (message: string) => void
}

export interface EvaluationResult {
  group: string
  total: number
  completed: number
}

export async function prepareEvaluation(
  input: SkillEvaluationRequest,
  host: EvaluationHost,
): Promise<EvaluationResult> {
  const group = "skill-eval-" + randomUUID()
  const total = input.versions.length
  const done: Array<{ item: SkillEvaluationVersion; tree: EvaluationWorktree; session: string; content: string }> = []
  host.progress("creating", total, 0, group)

  for (const [index, item] of input.versions.entries()) {
    const variant = "version-" + (index + 1)
    host.log(`Preparing Skill version ${index + 1}/${total}: ${item.versionId}`)
    const tree = await host.create(item, group)
    if (!tree) {
      host.progress("creating", total, done.length, group)
      continue
    }

    try {
      await host.setup(tree)
      const content = await host.install(item, tree, group, variant)
      const session = await host.finish(tree)
      if (!session) throw new Error("Failed to create the Agent Manager session")
      done.push({ item, tree, session, content })
      host.log(`Skill version ready: ${item.versionId} in ${tree.path}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      host.log(`Failed to prepare Skill version ${item.versionId}: ${message}`)
      await host.remove(tree).catch((cause) => {
        host.log(`Failed to clean up worktree ${tree.path}: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
      host.error(`Skill 版本 ${item.version} 准备失败：${message}`)
    }
    host.progress("creating", total, done.length, group)
  }

  await Promise.all(
    done.map(async (entry) => {
      try {
        await host.run(entry.item, entry.tree, entry.session, entry.content)
        host.log(`Skill version started: ${entry.item.versionId} in session ${entry.session}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        host.log(`Failed to start Skill version ${entry.item.versionId}: ${message}`)
        host.error(`Skill 版本 ${entry.item.version} 启动失败：${message}`)
      }
    }),
  )

  host.progress("done", total, done.length, group)
  if (done.length === 0) host.error("未能创建任何 Skill 版本评测 worktree。")
  return { group, total, completed: done.length }
}
