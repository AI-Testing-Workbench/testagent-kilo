// testagent_change - new file: validate archive-to-ChatView session mapping
import { describe, expect, it } from "bun:test"
import { cloudArchiveData } from "../../src/testagent/cloud/archive-data"
import { preview } from "../../webview-ui/src/context/archive-preview"

describe("archive preview session mapping", () => {
  it("creates a synthetic session and orders native messages with their parts", () => {
    const archive = cloudArchiveData({
      info: {
        id: "ses_archive",
        slug: "archive",
        projectID: "project_1",
        workspaceID: "workspace_1",
        directory: "/repo",
        path: "src/app.ts",
        title: "Read-only archive",
        version: "1.0.0",
        time: { created: 1000, updated: 3000 },
      },
      messages: [
        {
          info: {
            id: "msg_late",
            sessionID: "ses_archive",
            role: "user",
            agent: "code",
            model: { providerID: "provider_1", modelID: "model_1" },
            time: { created: 2000 },
          },
          parts: [{ id: "part_late", sessionID: "ses_archive", messageID: "msg_late", type: "text", text: "late" }],
        },
        {
          info: {
            id: "msg_early",
            sessionID: "ses_archive",
            role: "user",
            agent: "code",
            model: { providerID: "provider_1", modelID: "model_1" },
            time: { created: 1500 },
          },
          parts: [{ id: "part_early", sessionID: "ses_archive", messageID: "msg_early", type: "text", text: "early" }],
        },
      ],
    })

    const item = preview("service_1/ses_archive.json", archive)

    expect(item.key).toBe("service_1/ses_archive.json")
    expect(item.sessionID).toBe("ses_archive")
    expect(item.id).toBe("ses_archive")
    expect(item.info.createdAt).toBe(new Date(1000).toISOString())
    expect(item.info.updatedAt).toBe(new Date(3000).toISOString())
    expect(item.messages.map((msg) => msg.id)).toEqual(["msg_early", "msg_late"])
    expect(item.messages[0].parts?.map((part) => part.id)).toEqual(["part_early"])
  })
})
