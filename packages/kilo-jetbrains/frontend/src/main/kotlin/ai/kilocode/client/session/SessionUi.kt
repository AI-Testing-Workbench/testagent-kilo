package ai.kilocode.client.session

import ai.kilocode.client.app.KiloAppService
import ai.kilocode.client.app.KiloSessionService
import ai.kilocode.client.app.Workspace
import ai.kilocode.client.session.model.SessionModelEvent
import ai.kilocode.client.session.model.SessionState
import ai.kilocode.client.session.ui.LabelPicker
import ai.kilocode.client.session.ui.MessageListUi
import ai.kilocode.client.session.ui.PromptPanel
import ai.kilocode.client.session.ui.StatusPanel
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import kotlinx.coroutines.CoroutineScope
import java.awt.BorderLayout
import java.awt.CardLayout
import javax.swing.JPanel

/** Main session panel — reacts to [SessionController] events. */
class SessionUi(
    project: Project,
    workspace: Workspace,
    sessions: KiloSessionService,
    app: KiloAppService,
    cs: CoroutineScope,
) : JPanel(BorderLayout()), Disposable {

    companion object {
        private const val STATUS = "status"
        private const val MESSAGES = "messages"
    }

    private val controller = SessionController(this, null, sessions, workspace, app, cs)
    private val status = StatusPanel(this, controller)
    private val messages = MessageListUi(this, controller.model)

    private val cards = CardLayout()
    private val center = JPanel(cards)

    private val scroll = JBScrollPane(messages).apply {
        border = JBUI.Borders.empty()
        verticalScrollBarPolicy = JBScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED
        horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
    }

    private val prompt = PromptPanel(
        project = project,
        onSend = { text -> send(text) },
        onAbort = { controller.abort() },
    )

    init {
        center.add(status, STATUS)
        center.add(scroll, MESSAGES)
        cards.show(center, STATUS)

        add(center, BorderLayout.CENTER)
        add(prompt, BorderLayout.SOUTH)

        prompt.mode.onSelect = { item -> controller.selectAgent(item.id) }
        prompt.model.onSelect = picker@{ item ->
            val group = item.group
            if (group == null) return@picker
            controller.selectModel(group, item.id)
        }

        // Lifecycle events from the manager (app/workspace state, view switching)
        controller.addListener(this) { event ->
            when (event) {
                is SessionControllerEvent.WorkspaceReady -> {
                    val c = controller.model
                    prompt.mode.setItems(c.agents.map { LabelPicker.Item(it.name, it.display) }, c.agent)
                    val items = c.models.map { LabelPicker.Item(it.id, it.display, it.provider) }
                    val selected = c.model?.let { full -> items.firstOrNull { "${it.group}/${it.id}" == full }?.id }
                    prompt.model.setItems(items, selected)
                    prompt.setReady(c.isReady())
                }

                is SessionControllerEvent.ViewChanged -> cards.show(center, if (event.show) MESSAGES else STATUS)

                is SessionControllerEvent.AppChanged,
                is SessionControllerEvent.WorkspaceChanged -> prompt.setReady(controller.model.isReady())
            }
        }

        // Model events — state drives the prompt busy state
        controller.model.addListener(this) { event ->
            when (event) {
                is SessionModelEvent.StateChanged -> {
                    val busy = event.state.isBusy()
                    prompt.setBusy(busy)
                    scrollToBottom()
                }
                is SessionModelEvent.MessageAdded,
                is SessionModelEvent.ContentAdded,
                is SessionModelEvent.ContentUpdated,
                is SessionModelEvent.ContentDelta -> scrollToBottom()
                is SessionModelEvent.HistoryLoaded -> scrollToBottom()
                else -> {}
            }
        }
    }

    private fun send(text: String) {
        if (text.isBlank()) return
        controller.prompt(text)
        prompt.clear()
    }

    private fun scrollToBottom() {
        val bar = scroll.verticalScrollBar
        bar.value = bar.maximum
    }

    override fun dispose() {}
}

private fun SessionState.isBusy(): Boolean = when (this) {
    is SessionState.Idle -> false
    is SessionState.Error -> false
    else -> true
}
