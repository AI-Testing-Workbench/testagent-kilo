// testagent_change - new file
import { describe, expect, it } from "bun:test"
import { cloudArchiveData, cloudArchiveTurnData } from "../../src/testagent/cloud/archive-data"
import type { SessionArchive } from "../../src/testagent/cloud/archive-api"

function archive(): SessionArchive {
  return {
    info: {
      id: "ses_archive",
      slug: "archive",
      projectID: "project_1",
      workspaceID: "workspace_1",
      directory: "C:\\repo",
      path: "src/app",
      title: "Read-only archive",
      version: "1.0.0",
      time: { created: 1, updated: 3 },
    },
    messages: [
      {
        info: {
          id: "msg_assistant",
          sessionID: "ses_archive",
          role: "assistant",
          time: { created: 2, completed: 3 },
          parentID: "msg_user",
          modelID: "model_1",
          providerID: "provider_1",
          mode: "build",
          agent: "code",
          path: { cwd: "C:\\repo", root: "C:\\repo" },
          cost: 0,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: "prt_tool",
            sessionID: "ses_archive",
            messageID: "msg_assistant",
            type: "tool",
            callID: "call_1",
            tool: "read",
            state: {
              status: "completed",
              input: { path: "README.md" },
              output: "archive content",
              title: "Read README",
              metadata: {},
              time: { start: 2, end: 3 },
            },
          },
        ],
      },
      {
        info: {
          id: "msg_user",
          sessionID: "ses_archive",
          role: "user",
          time: { created: 1 },
          agent: "code",
          model: { providerID: "provider_1", modelID: "model_1" },
        },
        parts: [
          {
            id: "prt_text",
            sessionID: "ses_archive",
            messageID: "msg_user",
            type: "text",
            text: "Review this archive",
          },
        ],
      },
    ],
  }
}

describe("Git 归档只读渲染数据", () => {
  it("映射原生 user/assistant/tool parts 并按消息时间排序", () => {
    const data = cloudArchiveData(archive())
    const view = cloudArchiveTurnData(data)

    expect(view.messages.map((message) => message.id)).toEqual(["msg_user", "msg_assistant"])
    expect(view.turns.map((message) => message.id)).toEqual(["msg_user"])
    expect(view.data.session.map((session) => session.id)).toEqual(["ses_archive"])
    expect(view.data.session_status.ses_archive).toEqual({ type: "idle" })
    expect(view.data.part.msg_assistant[0]).toMatchObject({ id: "prt_tool", type: "tool" })
    expect(view.data.part.msg_user[0]).toMatchObject({ id: "prt_text", type: "text" })
  })

  it("拒绝跨会话消息和缺少消息片段的损坏归档", () => {
    const value = archive()
    const msg = value.messages[0] as { info: Record<string, unknown>; parts: unknown[] }
    msg.info.sessionID = "ses_other"

    expect(() => cloudArchiveData(value)).toThrow("本地码云仓库归档包含无效消息")
    expect(() => cloudArchiveData({ info: { id: "ses_empty" }, messages: "invalid" })).toThrow(
      "本地码云仓库归档缺少有效的会话信息",
    )
  })
})
