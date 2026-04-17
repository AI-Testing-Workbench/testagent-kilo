package ai.kilocode.client.session.model

import ai.kilocode.client.session.model.content.Content
import ai.kilocode.client.session.model.content.Message

/**
 * Change events fired by [SessionModel].
 *
 * Events carry the data needed for rendering so UI can update without
 * reading back from the model except for [HistoryLoaded].
 */
sealed class SessionModelEvent {
    data class MessageAdded(val info: Message) : SessionModelEvent()
    data class MessageRemoved(val id: String) : SessionModelEvent()
    data class ContentAdded(val messageId: String, val content: Content) : SessionModelEvent()
    data class ContentUpdated(val messageId: String, val content: Content) : SessionModelEvent()
    data class ContentDelta(val messageId: String, val contentId: String, val delta: String) : SessionModelEvent()
    data class PhaseChanged(val phase: SessionPhase) : SessionModelEvent()
    data object HistoryLoaded : SessionModelEvent()
    data object Cleared : SessionModelEvent()

    fun interface Listener {
        fun onEvent(event: SessionModelEvent)
    }
}
