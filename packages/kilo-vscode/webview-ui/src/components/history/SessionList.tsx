/**
 * SessionList component
 * Displays all sessions grouped by date, with context menu for rename/delete.
 * Uses kilo-ui List component for keyboard navigation and accessibility.
 * Header/back button are owned by the parent HistoryView.
 */

import { Component, Show, createSignal, onMount, type JSX } from "solid-js"
import { List } from "@kilocode/kilo-ui/list"
import { ContextMenu } from "@kilocode/kilo-ui/context-menu"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Button } from "@kilocode/kilo-ui/button"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { InlineInput } from "@kilocode/kilo-ui/inline-input"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"
import { formatRelativeDate } from "../../utils/date"
// testagent_change start - history row actions use typed progress messages
import type { CloudActionProgressMessage } from "../../types/cloud-history"
// testagent_change end
import type { SessionInfo } from "../../types/messages"
// testagent_change start - adapt archive summaries to the shared history list
import type { CloudArchiveSummary } from "../../../../src/testagent/cloud/archive-data"

type SessionListItem = SessionInfo & {
  archiveKey?: string
  archiveSessionID?: string
}
// testagent_change end

const DATE_GROUP_KEYS = ["time.today", "time.yesterday", "time.thisWeek", "time.thisMonth", "time.older"] as const

function dateGroupKey(iso: string): (typeof DATE_GROUP_KEYS)[number] {
  const now = new Date()
  const then = new Date(iso)

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const weekAgo = new Date(today.getTime() - 7 * 86400000)
  const monthAgo = new Date(today.getTime() - 30 * 86400000)

  if (then >= today) return DATE_GROUP_KEYS[0]
  if (then >= yesterday) return DATE_GROUP_KEYS[1]
  if (then >= weekAgo) return DATE_GROUP_KEYS[2]
  if (then >= monthAgo) return DATE_GROUP_KEYS[3]
  return DATE_GROUP_KEYS[4]
}

interface SessionListProps {
  onSelectSession: (id: string) => void
  // testagent_change start - keep local upload and cloud export actions mode-specific
  source?: "local" | "cloud" | "archive"
  actions?: Record<string, CloudActionProgressMessage>
  onUpload?: (id: string) => void
  appendAvailable?: boolean // testagent_change
  onAppendUpload?: (id: string) => void // testagent_change
  onExport?: (id: string) => void
  // Render local archives with the same grouped list.
  archives?: CloudArchiveSummary[]
  selectedArchiveKey?: string
  archiveLoading?: boolean
  onSelectArchive?: (key: string) => void
  onImportArchive?: (key: string) => void
  // testagent_change end
}

const SessionList: Component<SessionListProps> = (props) => {
  const session = useSession()
  const language = useLanguage()
  const dialog = useDialog()

  const [renamingId, setRenamingId] = createSignal<string | null>(null)
  const [renameValue, setRenameValue] = createSignal("")

  onMount(() => {
    if (props.source === "archive" || props.source === "cloud") return
    session.loadSessions()
  })

  // testagent_change start - archive rows retain the same sort/group rendering as local sessions
  const items = (): SessionListItem[] => {
    if (props.source !== "archive") return session.sessions()
    return (props.archives ?? []).map((item) => ({
      id: item.sessionID,
      title: item.title,
      createdAt: new Date(item.createdAt).toISOString(),
      updatedAt: new Date(item.updatedAt).toISOString(),
      archiveKey: item.key,
      archiveSessionID: item.sessionID,
    }))
  }
  // testagent_change end

  const currentSession = (): SessionInfo | undefined => {
    // testagent_change start - archive selection is keyed by file, not session ID
    if (props.source === "archive") return items().find((item) => item.archiveKey === props.selectedArchiveKey)
    // testagent_change end
    const id = session.currentSessionID()
    return session.sessions().find((s) => s.id === id)
  }

  function startRename(s: SessionInfo) {
    setRenamingId(s.id)
    setRenameValue(s.title || "")
  }

  function saveRename() {
    const id = renamingId()
    const title = renameValue().trim()
    if (!id || !title) {
      cancelRename()
      return
    }
    const existing = session.sessions().find((s) => s.id === id)
    if (!existing || title !== (existing.title || "")) {
      session.renameSession(id, title)
    }
    setRenamingId(null)
    setRenameValue("")
  }

  function remove(item: SessionInfo) {
    session.deleteSession(item.id)
  }

  function cancelRename() {
    setRenamingId(null)
    setRenameValue("")
  }

  function confirmDelete(s: SessionInfo) {
    dialog.show(() => (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="dialog-confirm-body">
          <span>{language.t("session.delete.confirm", { name: s.title || language.t("session.untitled") })}</span>
          <div class="dialog-confirm-actions">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                remove(s)
                dialog.close()
              }}
            >
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  // testagent_change start - import archives directly without a confirmation dialog
  function importArchive(item: SessionListItem) {
    const key = item.archiveKey
    if (!key) return
    props.onImportArchive?.(key)
  }
  // testagent_change end

  /* testagent_change start - preserve the retired archive-import confirmation dialog
  function confirmImport(item: SessionListItem) {
    const key = item.archiveKey
    if (!key) return
    dialog.show(() => (
      <Dialog title={language.t("cloud.archive.fork.title")} fit>
        <div class="dialog-confirm-body">
          <span>
            {language.t("cloud.archive.fork.confirm", { name: item.title || language.t("session.untitled") })}
          </span>
          <p>{language.t("cloud.archive.fork.note")}</p>
          <div class="dialog-confirm-actions">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="large"
              onClick={() => {
                dialog.close()
                props.onImportArchive?.(key)
              }}
            >
              {language.t("cloud.archive.fork.confirmButton")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }
  testagent_change end */

  function wrapItem(item: SessionInfo, node: JSX.Element): JSX.Element {
    return (
      <ContextMenu>
        <ContextMenu.Trigger as="div" style={{ display: "contents" }}>
          {node}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content>
            <ContextMenu.Item onSelect={() => startRename(item)}>
              <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            {/* testagent_change start - local sessions upload or append; cloud database sessions only download */}
            <Show when={props.source !== "cloud" && props.onUpload}>
              <ContextMenu.Item onSelect={() => props.onUpload?.(item.id)}>
                <ContextMenu.ItemLabel>{language.t("session.cloud.upload.button")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </Show>
            <Show when={props.source === "local" && props.appendAvailable && props.onAppendUpload}>
              <ContextMenu.Item onSelect={() => props.onAppendUpload?.(item.id)}>
                <ContextMenu.ItemLabel>{language.t("session.cloud.upload.append")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </Show>
            <Show when={props.source === "cloud" && props.onExport}>
              <ContextMenu.Item onSelect={() => props.onExport?.(item.id)}>
                <ContextMenu.ItemLabel>{language.t("session.cloud.export.button")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </Show>
            {/* testagent_change end */}
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => confirmDelete(item)}>
              <ContextMenu.ItemLabel>{language.t("common.delete")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
    )
  }

  // testagent_change start - archive rows expose import, but never rename or delete the source archive
  function wrapArchiveItem(item: SessionListItem, node: JSX.Element): JSX.Element {
    return (
      <ContextMenu>
        <ContextMenu.Trigger as="div" style={{ display: "contents" }}>
          {node}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content>
            <ContextMenu.Item onSelect={() => importArchive(item)}>
              <ContextMenu.ItemLabel>{language.t("cloud.archive.fork.button")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
    )
  }
  // testagent_change end

  return (
    <div class="session-list">
      <List<SessionListItem>
        items={items()}
        key={(s) => s.archiveKey ?? s.id}
        filterKeys={props.source === "archive" ? ["title", "archiveSessionID", "archiveKey"] : ["title"]}
        current={currentSession()}
        onSelect={(s) => {
          if (s && renamingId() !== s.id) {
            // testagent_change start - archive keys never pass through the database session loader
            if (s.archiveKey) props.onSelectArchive?.(s.archiveKey)
            else props.onSelectSession(s.id)
            // testagent_change end
          }
        }}
        search={{ placeholder: language.t("session.search.placeholder"), autofocus: false }}
        emptyMessage={
          /* testagent_change start - show an archive-specific empty hint in local Cloud history */
          props.source === "archive" ? language.t("cloud.archive.empty") : language.t("session.empty")
          /* testagent_change end */
        }
        groupBy={(s) => language.t(dateGroupKey(s.updatedAt))}
        sortGroupsBy={(a, b) => {
          const rank = Object.fromEntries(DATE_GROUP_KEYS.map((k, i) => [language.t(k), i]))
          return (rank[a.category] ?? 99) - (rank[b.category] ?? 99)
        }}
        itemWrapper={
          /* testagent_change start - Cloud database sessions retain standard rename/delete actions */
          props.source === "archive" ? wrapArchiveItem : wrapItem
          /* testagent_change end */
        }
      >
        {(s) => (
          <Show
            when={renamingId() === s.id}
            fallback={
              <>
                <span data-slot="list-item-title">{s.title || language.t("session.untitled")}</span>
                <span data-slot="list-item-description">{formatRelativeDate(s.updatedAt)}</span>
                {/* testagent_change start - local history uploads; cloud database history exports */}
                <Show
                  when={props.source === "archive"}
                  fallback={
                    <div data-slot="session-row-actions">
                      <Show
                        when={props.source === "cloud"}
                        fallback={
                          <Show when={props.source !== "cloud" && props.onUpload}>
                            {/* Inactive legacy text action retained for reference; the upload icon below stays clickable and has no reason tooltip
                            <Button
                              variant="ghost"
                              size="small"
                              disabled={props.actions?.[s.id]?.pending}
                              aria-label={language.t("session.cloud.upload.button")}
                              onClick={(event: MouseEvent) => {
                                event.stopPropagation()
                                props.onUpload?.(s.id)
                              }}
                            >
                              {props.actions?.[s.id]?.action === "upload"
                                ? language.t("session.cloud.upload.pending")
                                : language.t("session.cloud.upload.button")}
                            </Button>
                            */}
                            <span data-slot="session-upload-button">
                              <IconButton
                                icon="cloud-upload"
                                size="small"
                                variant="ghost"
                                aria-label={language.t("session.cloud.upload.button")}
                                onClick={(event: MouseEvent) => {
                                  event.stopPropagation()
                                  props.onUpload?.(s.id)
                                }}
                              />
                            </span>
                          </Show>
                        }
                      >
                        <Show when={props.onExport}>
                          <span data-slot="session-upload-button">
                            <button
                              type="button"
                              data-component="icon-button"
                              data-icon="cloud-download"
                              data-size="small"
                              data-variant="ghost"
                              disabled={props.actions?.[s.id]?.pending}
                              aria-label={language.t(
                                props.actions?.[s.id]?.action === "export"
                                  ? "session.cloud.export.pending"
                                  : "session.cloud.export.button",
                              )}
                              onClick={(event) => {
                                event.stopPropagation()
                                props.onExport?.(s.id)
                              }}
                            >
                              <svg
                                data-slot="icon-svg"
                                width="16"
                                height="16"
                                viewBox="0 0 20 20"
                                fill="none"
                                aria-hidden="true"
                              >
                                <path
                                  d="M12.0833 16.25H15C17.0711 16.25 18.75 14.5711 18.75 12.5C18.75 10.5649 17.2843 8.97217 15.4025 8.77133C15.2 6.13103 12.8586 4.08333 10 4.08333C7.71532 4.08333 5.76101 5.49781 4.96501 7.49881C2.84892 7.90461 1.25 9.76559 1.25 11.6667C1.25 13.9813 3.30203 16.25 5.83333 16.25H7.91667"
                                  stroke="currentColor"
                                  stroke-linecap="square"
                                />
                                <path
                                  d="M10 9.79167V16.25M7.91667 14.1667L10 16.25L12.0833 14.1667"
                                  stroke="currentColor"
                                  stroke-linecap="square"
                                />
                              </svg>
                            </button>
                          </span>
                        </Show>
                      </Show>
                      <span
                        data-slot="session-delete-button"
                        onClick={(event) => {
                          event.stopPropagation()
                          confirmDelete(s)
                        }}
                      >
                        <IconButton
                          icon="trash"
                          size="small"
                          variant="ghost"
                          aria-label={language.t("session.delete.title")}
                        />
                      </span>
                    </div>
                  }
                >
                  <span data-slot="session-upload-button">
                    <IconButton
                      icon="fork"
                      size="small"
                      variant="ghost"
                      aria-label={language.t("cloud.archive.fork.button")}
                      onClick={(event: MouseEvent) => {
                        event.stopPropagation()
                        importArchive(s)
                      }}
                    />
                  </span>
                </Show>
                {/* testagent_change end */}
              </>
            }
          >
            <InlineInput
              ref={(el) => requestAnimationFrame(() => el?.focus())}
              value={renameValue()}
              onInput={(e) => setRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Enter") {
                  e.preventDefault()
                  saveRename()
                }
                if (e.key === "Escape") {
                  e.preventDefault()
                  cancelRename()
                }
              }}
              onBlur={() => saveRename()}
              style={{ width: "100%" }}
            />
          </Show>
        )}
      </List>
    </div>
  )
}

export default SessionList
