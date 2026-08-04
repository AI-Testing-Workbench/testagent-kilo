import { createSignal } from "solid-js"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Button } from "@kilocode/kilo-ui/button"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { showToast } from "@kilocode/kilo-ui/toast"
import { useSession } from "../../context/session"
import { useLanguage } from "../../context/language"

type GoalDialogProps = {
  onClose: () => void
  pendingSessionID?: string
}

export const GoalDialog = (props: GoalDialogProps) => {
  const session = useSession()
  const language = useLanguage()
  const [text, setText] = createSignal("")

  const draft = () => props.pendingSessionID ?? session.draftSessionID()
  const sel = () => session.selected()

  const run = (args: string) => {
    const sid = session.currentSessionID() ?? props.pendingSessionID
    if (sid) session.abort(sid)
    session.sendCommand("goal", args, sel()?.providerID, sel()?.modelID, undefined, draft())
    props.onClose()
  }

  const submit = () => {
    const value = text().trim()
    if (!value) {
      showToast({ variant: "error", title: "请输入 Goal 目标" })
      return
    }
    run(value)
  }

  return (
    <Dialog title="Goal 控制" fit>
      <div class="goal-dialog">
        <p class="goal-dialog-copy">设置 TestAgent 需要持续推进的目标。</p>

        <TextField
          label="Goal 目标"
          multiline
          placeholder="例如：完成 /sdt-run case-design 并分析失败原因"
          value={text()}
          onChange={setText}
        />

        <div class="goal-dialog-ops">
          <Button variant="secondary" size="small" onClick={() => run("status")}>
            查看状态
          </Button>
          <Button variant="secondary" size="small" onClick={() => run("pause")}>
            暂停
          </Button>
          <Button variant="secondary" size="small" onClick={() => run("resume")}>
            恢复
          </Button>
          <Button variant="secondary" size="small" onClick={() => run("clear")}>
            清除
          </Button>
        </div>

        <div class="goal-dialog-actions">
          <Button variant="ghost" onClick={props.onClose}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} disabled={!text().trim()}>
            设置 Goal
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
