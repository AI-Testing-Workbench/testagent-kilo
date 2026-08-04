// testagent_change - Goal abort confirmation dialog
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Button } from "@kilocode/kilo-ui/button"
import { useSession } from "../../context/session"

type GoalAbortDialogProps = {
  sessionID: string
  onClose: () => void
  onConfirm: () => void  // Called to execute the actual abort
}

export const GoalAbortDialog = (props: GoalAbortDialogProps) => {
  const session = useSession()
  const sel = () => session.selected()

  const handlePause = () => {
    // First pause the goal
    session.sendCommand("goal", "pause", sel()?.providerID, sel()?.modelID, undefined, props.sessionID)
    // Then execute abort
    props.onConfirm()
    props.onClose()
  }

  const handleClear = () => {
    // First clear the goal
    session.sendCommand("goal", "clear", sel()?.providerID, sel()?.modelID, undefined, props.sessionID)
    // Then execute abort
    props.onConfirm()
    props.onClose()
  }

  const handleContinue = () => {
    // Just execute abort without changing goal
    props.onConfirm()
    props.onClose()
  }

  return (
    <Dialog title="Goal 目标正在运行" fit>
      <div class="goal-abort-dialog" style={{ padding: "16px" }}>
        <p style={{ "margin-bottom": "20px", "line-height": "1.5" }}>
          当前会话有正在运行的 Goal 目标。停止会话后，你可以：
        </p>

        <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "margin-bottom": "20px" }}>
          <Button variant="secondary" size="large" onClick={handlePause} style={{ width: "100%" }}>
            <div style={{ display: "flex", "flex-direction": "column", "align-items": "flex-start", gap: "4px" }}>
              <span style={{ "font-weight": "600" }}>暂停 Goal</span>
              <span style={{ "font-size": "12px", opacity: "0.8" }}>保留目标，稍后可以继续</span>
            </div>
          </Button>

          <Button variant="danger" size="large" onClick={handleClear} style={{ width: "100%" }}>
            <div style={{ display: "flex", "flex-direction": "column", "align-items": "flex-start", gap: "4px" }}>
              <span style={{ "font-weight": "600" }}>清除 Goal</span>
              <span style={{ "font-size": "12px", opacity: "0.8" }}>删除目标，需要重新设置</span>
            </div>
          </Button>

          <Button variant="primary" size="large" onClick={handleContinue} style={{ width: "100%" }}>
            <div style={{ display: "flex", "flex-direction": "column", "align-items": "flex-start", gap: "4px" }}>
              <span style={{ "font-weight": "600" }}>仅停止会话</span>
              <span style={{ "font-size": "12px", opacity: "0.8" }}>保持 Goal 激活状态</span>
            </div>
          </Button>
        </div>

        <div style={{ display: "flex", "justify-content": "center" }}>
          <Button variant="ghost" onClick={props.onClose}>
            取消
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
