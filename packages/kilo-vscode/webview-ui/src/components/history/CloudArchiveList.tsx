// testagent_change - new file: read-only archive viewer with explicit local fork confirmation
import { For, Show, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { DataProvider } from "@kilocode/kilo-ui/context/data"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { List } from "@kilocode/kilo-ui/list"
import { SessionTurn } from "@kilocode/kilo-ui/session-turn"
import { useLanguage } from "../../context/language"
import { formatRelativeDate } from "../../utils/date"
import {
  cloudArchiveTurnData,
  type CloudArchiveData,
  type CloudArchiveSummary,
} from "../../../../src/testagent/cloud/archive-data"

interface CloudArchiveListProps {
  directory: string
  archives: CloudArchiveSummary[]
  selected?: string
  archive?: CloudArchiveData
  loading: boolean
  forking?: string
  onSelect: (key: string) => void
  onFork: (key: string) => void
}

const CloudArchiveList: Component<CloudArchiveListProps> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const model = () => (props.archive ? cloudArchiveTurnData(props.archive) : undefined)
  const current = () => props.archives.find((item) => item.key === props.selected)

  function confirm() {
    const item = current()
    if (!item || props.forking) return
    dialog.show(() => (
      <Dialog title={language.t("cloud.archive.fork.title")} fit>
        <div class="dialog-confirm-body">
          <span>{language.t("cloud.archive.fork.confirm", { name: item.title })}</span>
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
                props.onFork(item.key)
              }}
            >
              {language.t("cloud.archive.fork.confirmButton")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))
  }

  return (
    <div class="cloud-archive-list">
      <List<CloudArchiveSummary>
        items={props.archives}
        key={(item) => item.key}
        filterKeys={["title", "sessionID", "serviceId"]}
        current={current()}
        onSelect={(item) => {
          if (item) props.onSelect(item.key)
        }}
        search={{ placeholder: language.t("cloud.archive.search"), autofocus: false }}
        emptyMessage={language.t("session.empty")}
      >
        {(item) => (
          <>
            <span data-slot="list-item-title">{item.title}</span>
            <span data-slot="list-item-description">{formatRelativeDate(new Date(item.updatedAt).toISOString())}</span>
          </>
        )}
      </List>
      <Show when={current()}>
        {(item) => (
          <section class="cloud-archive-preview" aria-label={language.t("cloud.archive.preview")}>
            <header class="cloud-archive-preview-header">
              <div>
                <h3>{item().title}</h3>
                <p>{language.t("cloud.archive.sessionId", { id: item().sessionID })}</p>
              </div>
              <Button
                variant="primary"
                size="small"
                disabled={!props.archive || props.loading || !!props.forking}
                onClick={confirm}
              >
                {props.forking === item().key
                  ? language.t("cloud.archive.forking")
                  : language.t("cloud.archive.fork.button")}
              </Button>
            </header>
            <Show
              when={model()}
              fallback={
                <Show when={!props.loading}>
                  <p>{language.t("cloud.archive.select")}</p>
                </Show>
              }
            >
              {(view) => (
                <div class="cloud-archive-turns" aria-readonly="true">
                  <DataProvider data={view().data} directory={props.directory}>
                    <For each={view().turns}>
                      {(turn) => (
                        <SessionTurn
                          sessionID={props.archive!.info.id}
                          messageID={turn.id}
                          actions={{}}
                          active={false}
                          queued={false}
                          status={{ type: "idle" }}
                          classes={{ root: "cloud-archive-turn", container: "cloud-archive-turn-container" }}
                        />
                      )}
                    </For>
                  </DataProvider>
                  <Show when={view().turns.length === 0}>
                    <p>{language.t("cloud.archive.noMessages")}</p>
                  </Show>
                </div>
              )}
            </Show>
          </section>
        )}
      </Show>
    </div>
  )
}

export default CloudArchiveList
