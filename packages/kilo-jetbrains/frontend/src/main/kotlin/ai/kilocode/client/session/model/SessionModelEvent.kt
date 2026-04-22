package ai.kilocode.client.session.model

import ai.kilocode.rpc.dto.DiffFileDto
import ai.kilocode.rpc.dto.TodoDto

/**
 * Change events fired by [SessionModel].
 *
 * Events carry the data needed for rendering so UI can update without
 * reading back from the model except for [HistoryLoaded].
 */
sealed class SessionModelEvent {
    data class MessageAdded(val info: Message) : SessionModelEvent() {
        override fun toString() = "MessageAdded ${info.info.id}"
    }
    data class MessageUpdated(val info: Message) : SessionModelEvent() {
        override fun toString() = "MessageUpdated ${info.info.id}"
    }
    data class MessageRemoved(val id: String) : SessionModelEvent() {
        override fun toString() = "MessageRemoved $id"
    }
    data class ContentAdded(val messageId: String, val content: Content) : SessionModelEvent() {
        override fun toString() = "ContentAdded $messageId/${content.id}"
    }
    data class ContentUpdated(val messageId: String, val content: Content) : SessionModelEvent() {
        override fun toString() = "ContentUpdated $messageId/${content.id}"
    }
    data class ContentRemoved(val messageId: String, val contentId: String) : SessionModelEvent() {
        override fun toString() = "ContentRemoved $messageId/$contentId"
    }
    data class ContentDelta(val messageId: String, val contentId: String, val delta: String) : SessionModelEvent() {
        override fun toString() = "ContentDelta $messageId/$contentId"
    }
    data class StateChanged(val state: SessionState) : SessionModelEvent() {
        override fun toString() = "StateChanged ${state::class.simpleName}"
    }
    data class DiffUpdated(val diff: List<DiffFileDto>) : SessionModelEvent() {
        override fun toString() = "DiffUpdated files=${diff.size}"
    }
    data class TodosUpdated(val todos: List<TodoDto>) : SessionModelEvent() {
        override fun toString() = "TodosUpdated count=${todos.size}"
    }
    data class Compacted(val count: Int) : SessionModelEvent() {
        override fun toString() = "Compacted count=$count"
    }
    data object HistoryLoaded : SessionModelEvent()
    data object Cleared : SessionModelEvent()

    fun interface Listener {
        fun onEvent(event: SessionModelEvent)
    }
}
