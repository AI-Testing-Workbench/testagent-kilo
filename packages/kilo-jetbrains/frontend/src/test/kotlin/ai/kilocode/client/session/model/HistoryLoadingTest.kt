package ai.kilocode.client.session.model

import ai.kilocode.client.session.model.content.Text
import ai.kilocode.rpc.dto.MessageWithPartsDto

class HistoryLoadingTest : SessionManagerTestBase() {

    fun `test existing session loads history on init`() {
        val m = msg("msg1", "ses_test", "user")
        val part = part("prt1", "ses_test", "msg1", "text", text = "hello")
        rpc.history.add(MessageWithPartsDto(m, listOf(part)))

        val model = model("ses_test")
        val events = collectModel(model)
        flush()

        assertTrue(events.any { it is SessionModelEvent.HistoryLoaded })
        assertNotNull(model.chat.message("msg1"))
        val content = model.chat.content("msg1", "prt1")
        assertTrue(content is Text)
        assertEquals("hello", (content as Text).content.toString())
    }

    fun `test non-empty history shows messages view`() {
        rpc.history.add(MessageWithPartsDto(msg("msg1", "ses_test", "user"), emptyList()))

        val model = model("ses_test")
        val events = collect(model)
        flush()

        assertTrue(events.any { it is SessionManagerEvent.ViewChanged && it.show })
        assertTrue(model.chat.showMessages)
    }
}
