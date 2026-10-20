// testagent_change - map validated archive records into the webview session model
import type { CloudArchiveData } from "../../../src/testagent/cloud/archive-data"
import type { Message, SessionInfo } from "../types/messages"

export function preview(key: string, archive: CloudArchiveData) {
  const id = archive.info.id
  const info = {
    ...archive.info,
    id,
    createdAt: new Date(archive.info.time.created).toISOString(),
    updatedAt: new Date(archive.info.time.updated).toISOString(),
  } as unknown as SessionInfo
  const messages = archive.messages
    .map(
      (item) =>
        ({
          ...item.info,
          createdAt: new Date(item.info.time.created).toISOString(),
          parts: item.parts,
        }) as unknown as Message,
    )
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  return { id, info, key, messages, sessionID: archive.info.id }
}
