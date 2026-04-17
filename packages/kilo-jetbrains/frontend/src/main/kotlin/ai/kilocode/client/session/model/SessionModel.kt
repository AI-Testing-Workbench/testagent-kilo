package ai.kilocode.client.session.model

import ai.kilocode.client.session.model.content.Compaction
import ai.kilocode.client.session.model.content.Content
import ai.kilocode.client.session.model.content.Message
import ai.kilocode.client.session.model.content.Reasoning
import ai.kilocode.client.session.model.content.Text
import ai.kilocode.client.session.model.content.Tool
import ai.kilocode.client.session.model.content.ToolExecState
import ai.kilocode.rpc.dto.KiloAppStateDto
import ai.kilocode.rpc.dto.KiloAppStatusDto
import ai.kilocode.rpc.dto.KiloWorkspaceStateDto
import ai.kilocode.rpc.dto.KiloWorkspaceStatusDto
import ai.kilocode.rpc.dto.MessageDto
import ai.kilocode.rpc.dto.MessageWithPartsDto
import ai.kilocode.rpc.dto.PartDto
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer

/**
 * Pure session model — single source of truth for chat content and runtime state.
 *
 * **EDT-only access** — no synchronization. [SessionManager] guarantees all
 * reads and writes happen on the EDT.
 */
class SessionModel {

    private val entries = LinkedHashMap<String, Message>()

    var app: KiloAppStateDto = KiloAppStateDto(KiloAppStatusDto.DISCONNECTED)
    var version: String? = null

    var workspace: KiloWorkspaceStateDto = KiloWorkspaceStateDto(KiloWorkspaceStatusDto.PENDING)
    var agents: List<AgentItem> = emptyList()
    var models: List<ModelItem> = emptyList()
    var agent: String? = null
    var model: String? = null
    var ready: Boolean = false
    var showMessages: Boolean = false

    var phase: SessionPhase = SessionPhase.Idle
        private set

    private val listeners = mutableListOf<SessionModelEvent.Listener>()

    fun addListener(parent: Disposable, listener: SessionModelEvent.Listener) {
        listeners.add(listener)
        Disposer.register(parent) { listeners.remove(listener) }
    }

    fun messages(): Collection<Message> = entries.values

    fun message(id: String): Message? = entries[id]

    fun content(messageId: String, contentId: String): Content? = entries[messageId]?.parts?.get(contentId)

    fun isEmpty(): Boolean = entries.isEmpty()

    fun addMessage(dto: MessageDto): Message? {
        if (entries.containsKey(dto.id)) return null
        val msg = Message(dto)
        entries[dto.id] = msg
        fire(SessionModelEvent.MessageAdded(msg))
        return msg
    }

    fun removeMessage(id: String) {
        if (entries.remove(id) == null) return
        fire(SessionModelEvent.MessageRemoved(id))
    }

    fun updateContent(messageId: String, dto: PartDto) {
        val msg = entries[messageId] ?: return
        val existing = msg.parts[dto.id]
        if (existing != null) {
            updateExisting(messageId, existing, dto)
            return
        }
        val content = fromDto(dto) ?: return
        msg.parts[dto.id] = content
        fire(SessionModelEvent.ContentAdded(messageId, content))
    }

    fun appendDelta(messageId: String, contentId: String, delta: String) {
        val msg = entries[messageId] ?: return
        val existing = msg.parts[contentId]
        if (existing != null) {
            val buf = when (existing) {
                is Text -> existing.content
                is Reasoning -> existing.content
                else -> return
            }
            buf.append(delta)
        } else {
            val content = Text(contentId)
            content.content.append(delta)
            msg.parts[contentId] = content
            fire(SessionModelEvent.ContentAdded(messageId, content))
        }
        fire(SessionModelEvent.ContentDelta(messageId, contentId, delta))
    }

    fun setPhase(phase: SessionPhase) {
        this.phase = phase
        fire(SessionModelEvent.PhaseChanged(phase))
    }

    fun loadHistory(history: List<MessageWithPartsDto>) {
        entries.clear()
        phase = SessionPhase.Idle
        for (msg in history) {
            val item = Message(msg.info)
            for (part in msg.parts) {
                val content = fromDto(part, part.text)
                if (content != null) item.parts[content.id] = content
            }
            entries[msg.info.id] = item
        }
        fire(SessionModelEvent.HistoryLoaded)
    }

    fun clear() {
        entries.clear()
        phase = SessionPhase.Idle
        fire(SessionModelEvent.Cleared)
    }

    private fun updateExisting(messageId: String, existing: Content, dto: PartDto) {
        when (existing) {
            is Text -> {
                val text = dto.text ?: return
                existing.content.clear()
                existing.content.append(text)
            }
            is Reasoning -> {
                val text = dto.text ?: return
                existing.content.clear()
                existing.content.append(text)
            }
            is Tool -> {
                existing.state = parseToolState(dto.state)
                existing.title = dto.title
            }
            is Compaction -> return
        }
        fire(SessionModelEvent.ContentUpdated(messageId, existing))
    }

    private fun fromDto(dto: PartDto, text: CharSequence? = null): Content? {
        val content = text ?: dto.text
        return when (dto.type) {
            "text" -> Text(dto.id).apply {
                if (content != null && content.isNotEmpty()) this.content.append(content)
            }
            "reasoning" -> Reasoning(dto.id).apply {
                if (content != null && content.isNotEmpty()) this.content.append(content)
            }
            "tool" -> Tool(dto.id, dto.tool ?: "unknown").apply {
                state = parseToolState(dto.state)
                title = dto.title
            }
            "compaction" -> Compaction(dto.id)
            else -> null
        }
    }

    private fun fire(event: SessionModelEvent) {
        for (l in listeners) l.onEvent(event)
    }
}

private fun parseToolState(raw: String?): ToolExecState = when (raw) {
    "pending" -> ToolExecState.PENDING
    "running" -> ToolExecState.RUNNING
    "completed" -> ToolExecState.COMPLETED
    "error" -> ToolExecState.ERROR
    else -> ToolExecState.PENDING
}

data class AgentItem(val name: String, val display: String)

data class ModelItem(val id: String, val display: String, val provider: String)
