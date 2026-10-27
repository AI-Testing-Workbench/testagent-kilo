/**
 * HistoryView component
 * Unified panel for local archive files and cloud session history.
 * Local mode shows archive files; cloud mode shows core database sessions.
 */

import { Component, createEffect, createSignal, onCleanup, Show } from "solid-js" // testagent_change
import { Button } from "@kilocode/kilo-ui/button"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useLanguage } from "../../context/language"
import { useSession } from "../../context/session"
// testagent_change start - add archive/session data dependencies
import { useServer } from "../../context/server"
import { useVSCode } from "../../context/vscode"
import type {
  CloudActionProgressMessage,
  CloudArchiveForkedMessage,
  CloudArchiveListLoadedMessage,
  CloudArchiveLoadedMessage,
  CloudArchiveOperationFailedMessage,
} from "../../types/cloud-history"
import type { CloudArchiveData, CloudArchiveSummary } from "../../../../src/testagent/cloud/archive-data"
import SessionList from "./SessionList"
// testagent_change end

/*
testagent_change start - retain imports replaced by archive/core history
import { CloudImportDialog } from "../chat/CloudImportDialog"
import SessionList from "./SessionList"
import CloudSessionList from "./CloudSessionList"
testagent_change end
*/

interface HistoryViewProps {
  onSelectSession: (id: string) => void
  onSelectArchive?: (key: string, archive: CloudArchiveData) => void // testagent_change
  onBack?: () => void
}

const HistoryView: Component<HistoryViewProps> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const session = useSession()
  // testagent_change start - replace SaaS dialog state with archive selection state
  /*
  const dialog = useDialog()
  const [tab, setTab] = createSignal<"local" | "cloud">("local")

  function openImport() {
    dialog.show(() => (
      <CloudImportDialog
        onImport={(id) => {
          selectCloudSession(id)
        }}
      />
    ))
  }
  */
  const server = useServer()
  const vscode = useVSCode()
  const [tab, setTab] = createSignal<"local" | "cloud">(
    session.archivePreview() ? "cloud" : "local", // Return to Cloud history after viewing an archive.
  )
  const [available, setAvailable] = createSignal(false) // testagent_change
  const [appendAvailable, setAppendAvailable] = createSignal(false) // testagent_change
  const [archives, setArchives] = createSignal<CloudArchiveSummary[]>([])
  const [key, setKey] = createSignal<string | undefined>(
    session.archivePreview()?.key, // Retain selected archive when returning from ChatView.
  )
  const [reading, setReading] = createSignal(false)
  const [opening, setOpening] = createSignal<string>()
  /* Previous viewer state retained with its old component call below.
  const [archive, setArchive] = createSignal<CloudArchiveData>()
  const [read, setRead] = createSignal(false)
  */
  const [actions, setActions] = createSignal<Record<string, CloudActionProgressMessage>>({})
  const [forking, setForking] = createSignal<string>()
  const [loaded, setLoaded] = createSignal(false)
  const timers = new Set<ReturnType<typeof setTimeout>>()
  // testagent_change end

  // testagent_change start - process archive list and operation responses
  function list(message: CloudArchiveListLoadedMessage) {
    setArchives(message.archives)
    setLoaded(true)
    const current = key()
    if (current && !message.archives.some((item) => item.key === current)) {
      setKey(undefined)
      setReading(false)
      setOpening(undefined)
    }
    if (!current || !message.archives.some((item) => item.key === current)) return
    setReading(true)
    vscode.postMessage({ type: "requestCloudArchive", key: current })
  }

  function readArchive(message: CloudArchiveLoadedMessage) {
    if (message.key !== key()) return
    setReading(false)
    if (tab() !== "cloud" || opening() !== message.key) {
      setOpening(undefined)
      return
    }
    setOpening(undefined)
    props.onSelectArchive?.(message.key, message.archive)
  }

  function fail(message: CloudArchiveOperationFailedMessage) {
    if (message.operation === "list") setLoaded(true)
    if (message.operation === "read" && message.key === key()) {
      setReading(false)
      setOpening(undefined)
    }
    if (message.operation === "fork") setForking(undefined)
  }

  /* Replaced by archive reads and the shared core session list.
  function selectCloudSession(id: string) {
    session.selectCloudSession(id)
    props.onBack?.()
  }
  */

  function forked(message: CloudArchiveForkedMessage) {
    setForking(undefined)
    props.onSelectSession(message.sessionID)
    props.onBack?.()
  }

  // Row actions only track pending state; all feedback stays outside the list.
  function action(message: CloudActionProgressMessage) {
    setActions((prev) => {
      const next = { ...prev }
      if (message.pending) next[message.sessionID] = message
      else delete next[message.sessionID]
      return next
    })
  }
  // testagent_change end

  // testagent_change start - subscribe to extension archive messages
  const stop = vscode.onMessage((message) => {
    switch (message.type) {
      // testagent_change start - show append only while the current workspace has bound services
      case "cloudAppendAvailability":
        setAppendAvailable(message.available)
        return
      // testagent_change end
      // testagent_change start - hide unavailable local Cloud history and discard stale preview state
      case "cloudArchiveAvailability":
        setAvailable(message.available)
        if (message.available) return
        session.clearArchivePreview()
        setReading(false)
        setOpening(undefined)
        setTab("local")
        return
      // testagent_change end
      case "cloudArchiveListLoaded":
        list(message)
        return
      case "cloudArchiveLoaded":
        readArchive(message)
        return
      case "cloudArchiveOperationFailed":
        fail(message)
        return
      case "cloudArchiveForked":
        forked(message)
        return
      case "cloudActionProgress":
        action(message)
        return
    }
  })
  onCleanup(() => {
    stop()
    for (const timer of timers) clearTimeout(timer)
  })
  // testagent_change end

  // testagent_change start - reload archive files when workspace or tab state changes
  function reload(attempt = 0) {
    if (!server.isConnected()) return
    if (server.cloudMode()) return
    setLoaded(false)
    vscode.postMessage({ type: "requestCloudArchiveList" })
    if (attempt >= 3) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!loaded()) reload(attempt + 1)
    }, 500)
    timers.add(timer)
  }

  createEffect(() => {
    const cloud = server.cloudMode()
    if (cloud) {
      if (server.isConnected()) session.loadSessions()
      return
    }
    const dir = server.workspaceDirectory()
    if (!server.isConnected()) {
      return
    }
    // testagent_change start - probe eligibility without creating local cloud archive directories
    if (!dir) {
      setAvailable(false)
      setLoaded(true)
      if (tab() === "cloud") {
        session.clearArchivePreview()
        setTab("local")
      }
      return
    }
    vscode.postMessage({ type: "requestCloudArchiveList", availabilityOnly: true })
    // testagent_change end
    if (tab() === "cloud") {
      reload()
      return
    }
    // Previous session-only refresh is retained; it missed workspaceDirectory changes.
    // if (session.sessions().length > 0) refresh()
    if (!dir) {
      setLoaded(true)
      return
    }
    if (session.sessions().length > 0) {
      setLoaded(true)
      return
    }
    setLoaded(true)
  })
  // testagent_change end

  // testagent_change start - add cloud archive navigation and transfer actions
  function select(id: string) {
    setKey(id)
    setOpening(id)
    setReading(true)
    vscode.postMessage({ type: "requestCloudArchive", key: id })
  }

  function fork(id: string) {
    if (forking()) return
    setForking(id)
    vscode.postMessage({ type: "requestCloudArchiveFork", key: id })
  }

  function upload(id: string) {
    vscode.postMessage({ type: "requestCloudUpload", sessionID: id })
  }

  // testagent_change start - route append uploads through the Extension Host service picker
  function append(id: string) {
    vscode.postMessage({ type: "requestCloudUpload", sessionID: id, append: true })
  }
  // testagent_change end

  function exportFile(id: string) {
    vscode.postMessage({ type: "requestCloudExport", sessionID: id })
  }
  // testagent_change end

  return (
    <div class="history-view">
      <div class="history-view-header">
        <Button variant="ghost" size="small" icon="arrow-left" onClick={() => props.onBack?.()}>
          {language.t("common.goBack")}
        </Button>
        {/* testagent_change start - select history tabs based on connection mode */}
        {/*
        <div class="history-view-tabs">
          <button
            class="history-tab-btn"
            classList={{ "history-tab-btn--active": tab() === "local" }}
            onClick={() => setTab("local")}
          >
            {language.t("session.tab.local")}
          </button>
          <button
            class="history-tab-btn"
            classList={{ "history-tab-btn--active": tab() === "cloud" }}
            onClick={() => setTab("cloud")}
          >
            {language.t("session.tab.cloud")}
          </button>
        </div>
        <Button variant="secondary" size="small" onClick={openImport} class="history-import-btn">
          {language.t("session.cloud.import")}
        </Button>
        */}
        <Show
          when={server.cloudMode()}
          fallback={
            <div class="history-view-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab() === "local"}
                class="history-tab-btn"
                classList={{ "history-tab-btn--active": tab() === "local" }}
                onClick={() => {
                  // Restore same-ID local session data before rendering the full local list.
                  session.clearArchivePreview()
                  setReading(false)
                  setOpening(undefined)
                  setTab("local")
                }}
              >
                {language.t("session.tab.local")}
              </button>
              {/* testagent_change start - show Cloud history only for a supported local repository */}
              <Show when={available()}>
                <button
                  role="tab"
                  aria-selected={tab() === "cloud"}
                  class="history-tab-btn"
                  classList={{ "history-tab-btn--active": tab() === "cloud" }}
                  onClick={() => {
                    setTab("cloud")
                  }}
                >
                  {language.t("session.tab.cloud")}
                </button>
              </Show>
              {/* testagent_change end */}
            </div>
          }
        >
          <div class="history-view-tabs" role="tablist">
            <button type="button" role="tab" aria-selected="true" class="history-tab-btn history-tab-btn--active">
              {language.t("session.tab.cloud")}
            </button>
          </div>
        </Show>
        {/* testagent_change end */}
      </div>

      <div class="history-view-content">
        {/* testagent_change start - render archive and session lists by mode */}
        {/*
        {tab() === "local" ? (
          <SessionList onSelectSession={props.onSelectSession} />
        ) : (
          <CloudSessionList onSelectSession={selectCloudSession} />
        )}
        */}
        <Show
          when={server.cloudMode()}
          fallback={
            <Show
              when={tab() === "local"}
              fallback={
                <>
                  {/*
                  <CloudArchiveList
                    directory={server.workspaceDirectory()}
                    archives={archives()}
                    selected={key()}
                    loading={reading()}
                    forking={forking()}
                    onSelect={select}
                    onFork={fork}
                    archive={archive()}
                    loading={reading() && !read()}
                  />
                  */}
                  <SessionList
                    onSelectSession={props.onSelectSession}
                    source="archive"
                    archives={archives()}
                    selectedArchiveKey={key()}
                    archiveLoading={!loaded()}
                    onSelectArchive={select}
                    onImportArchive={fork}
                  />
                </>
              }
            >
              <SessionList
                onSelectSession={props.onSelectSession}
                source="local"
                actions={actions()}
                onUpload={upload}
                appendAvailable={appendAvailable()}
                onAppendUpload={append}
              />
            </Show>
          }
        >
          <SessionList
            onSelectSession={props.onSelectSession}
            source="cloud"
            actions={actions()}
            onExport={exportFile}
          />
        </Show>
        {/* testagent_change end */}
      </div>
    </div>
  )
}

export default HistoryView
