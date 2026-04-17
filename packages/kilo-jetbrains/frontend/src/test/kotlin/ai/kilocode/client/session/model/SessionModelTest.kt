package ai.kilocode.client.session.model

import ai.kilocode.client.session.model.content.Compaction
import ai.kilocode.client.session.model.content.Reasoning
import ai.kilocode.client.session.model.content.Text
import ai.kilocode.client.session.model.content.Tool
import ai.kilocode.client.session.model.content.ToolExecState
import ai.kilocode.client.session.model.content.Permission
import ai.kilocode.client.session.model.content.PermissionFileDiff
import ai.kilocode.client.session.model.content.PermissionMeta
import ai.kilocode.client.session.model.content.PermissionRequestState
import ai.kilocode.client.session.model.content.Question
import ai.kilocode.client.session.model.content.QuestionItem
import ai.kilocode.client.session.model.content.QuestionOption
import ai.kilocode.client.session.model.content.ToolCallRef
import ai.kilocode.rpc.dto.KiloAppStateDto
import ai.kilocode.rpc.dto.KiloAppStatusDto
import ai.kilocode.rpc.dto.KiloWorkspaceStateDto
import ai.kilocode.rpc.dto.KiloWorkspaceStatusDto
import ai.kilocode.rpc.dto.MessageDto
import ai.kilocode.rpc.dto.MessageTimeDto
import ai.kilocode.rpc.dto.MessageWithPartsDto
import ai.kilocode.rpc.dto.PartDto
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.UsefulTestCase

class SessionModelTest : UsefulTestCase() {

    private lateinit var model: SessionModel
    private lateinit var parent: Disposable
    private lateinit var events: MutableList<SessionModelEvent>

    override fun setUp() {
        super.setUp()
        parent = Disposer.newDisposable("test")
        model = SessionModel()
        events = mutableListOf()
        model.addListener(parent) { events.add(it) }
    }

    override fun tearDown() {
        try {
            Disposer.dispose(parent)
        } finally {
            super.tearDown()
        }
    }

    fun `test initial app and workspace state`() {
        assertEquals(KiloAppStatusDto.DISCONNECTED, model.app.status)
        assertEquals(KiloWorkspaceStatusDto.PENDING, model.workspace.status)
        assertEquals(SessionPhase.Idle, model.phase)
    }

    fun `test addMessage stores entry and fires MessageAdded`() {
        model.addMessage(msg("m1", "user"))

        val item = model.message("m1")
        assertNotNull(item)
        assertEquals(1, events.size)
        val event = events[0] as SessionModelEvent.MessageAdded
        assertEquals("m1", event.info.info.id)
    }

    fun `test addMessage duplicate is ignored`() {
        model.addMessage(msg("m1", "user"))
        events.clear()

        model.addMessage(msg("m1", "user"))

        assertEquals(1, model.messages().size)
        assertTrue(events.isEmpty())
    }

    fun `test removeMessage removes entry and fires MessageRemoved`() {
        model.addMessage(msg("m1", "assistant"))
        events.clear()

        model.removeMessage("m1")

        assertNull(model.message("m1"))
        assertEquals(1, events.size)
        assertEquals("m1", (events[0] as SessionModelEvent.MessageRemoved).id)
    }

    fun `test removeMessage unknown id is noop`() {
        model.removeMessage("unknown")
        assertTrue(events.isEmpty())
    }

    fun `test updateContent text creates Text content and fires ContentAdded`() {
        model.addMessage(msg("m1", "assistant"))
        events.clear()

        model.updateContent("m1", part("p1", "m1", "text", text = "hello"))

        val p = model.message("m1")!!.parts["p1"]
        assertTrue(p is Text)
        assertEquals("hello", (p as Text).content.toString())
        val event = events.single() as SessionModelEvent.ContentAdded
        assertEquals("m1", event.messageId)
    }

    fun `test updateContent text replaces content and fires ContentUpdated`() {
        model.addMessage(msg("m1", "assistant"))
        model.updateContent("m1", part("p1", "m1", "text", text = "old"))
        events.clear()

        model.updateContent("m1", part("p1", "m1", "text", text = "new"))

        assertEquals("new", (model.message("m1")!!.parts["p1"] as Text).content.toString())
        assertTrue(events.single() is SessionModelEvent.ContentUpdated)
    }

    fun `test updateContent reasoning creates Reasoning content`() {
        model.addMessage(msg("m1", "assistant"))

        model.updateContent("m1", part("p1", "m1", "reasoning", text = "thinking"))

        val p = model.message("m1")!!.parts["p1"]
        assertTrue(p is Reasoning)
        assertEquals("thinking", (p as Reasoning).content.toString())
    }

    fun `test updateContent tool creates Tool content and tracks state`() {
        model.addMessage(msg("m1", "assistant"))

        model.updateContent("m1", part("p1", "m1", "tool", tool = "bash", state = "running", title = "ls"))

        val p = model.message("m1")!!.parts["p1"] as Tool
        assertEquals("bash", p.name)
        assertEquals(ToolExecState.RUNNING, p.state)
        assertEquals("ls", p.title)
    }

    fun `test updateContent tool updates lifecycle`() {
        model.addMessage(msg("m1", "assistant"))
        model.updateContent("m1", part("p1", "m1", "tool", tool = "bash", state = "pending"))
        events.clear()

        model.updateContent("m1", part("p1", "m1", "tool", tool = "bash", state = "completed"))

        val p = model.message("m1")!!.parts["p1"] as Tool
        assertEquals(ToolExecState.COMPLETED, p.state)
        assertTrue(events.single() is SessionModelEvent.ContentUpdated)
    }

    fun `test updateContent compaction creates Compaction content`() {
        model.addMessage(msg("m1", "assistant"))

        model.updateContent("m1", part("p1", "m1", "compaction"))

        assertTrue(model.message("m1")!!.parts["p1"] is Compaction)
    }

    fun `test updateContent unknown type ignored`() {
        model.addMessage(msg("m1", "assistant"))
        events.clear()

        model.updateContent("m1", part("p1", "m1", "step-start"))

        assertNull(model.message("m1")!!.parts["p1"])
        assertTrue(events.isEmpty())
    }

    fun `test appendDelta appends to existing text content`() {
        model.addMessage(msg("m1", "assistant"))
        model.updateContent("m1", part("p1", "m1", "text", text = "hello "))
        events.clear()

        model.appendDelta("m1", "p1", "world")

        assertEquals("hello world", (model.message("m1")!!.parts["p1"] as Text).content.toString())
        val event = events.single() as SessionModelEvent.ContentDelta
        assertEquals("p1", event.contentId)
        assertEquals("world", event.delta)
    }

    fun `test appendDelta appends to reasoning content`() {
        model.addMessage(msg("m1", "assistant"))
        model.updateContent("m1", part("p1", "m1", "reasoning", text = "hmm "))
        events.clear()

        model.appendDelta("m1", "p1", "interesting")

        assertEquals("hmm interesting", (model.message("m1")!!.parts["p1"] as Reasoning).content.toString())
    }

    fun `test appendDelta creates text content if missing`() {
        model.addMessage(msg("m1", "assistant"))
        events.clear()

        model.appendDelta("m1", "p1", "first")

        val p = model.message("m1")!!.parts["p1"]
        assertTrue(p is Text)
        assertEquals("first", (p as Text).content.toString())
        assertEquals(2, events.size)
        assertTrue(events[0] is SessionModelEvent.ContentAdded)
        assertTrue(events[1] is SessionModelEvent.ContentDelta)
    }

    fun `test appendDelta on tool content is noop`() {
        model.addMessage(msg("m1", "assistant"))
        model.updateContent("m1", part("p1", "m1", "tool", tool = "bash", state = "running"))
        events.clear()

        model.appendDelta("m1", "p1", "text")

        assertTrue(events.isEmpty())
    }

    fun `test setPhase stores phase and fires PhaseChanged`() {
        val phase = SessionPhase.Working(StatusState.Thinking("thinking"))
        model.setPhase(phase)

        assertEquals(phase, model.phase)
        assertEquals(phase, (events.single() as SessionModelEvent.PhaseChanged).phase)
    }

    fun `test setPhase to Error stores error data`() {
        model.setPhase(SessionPhase.Error("something broke", "timeout"))

        val phase = model.phase as SessionPhase.Error
        assertEquals("something broke", phase.message)
        assertEquals("timeout", phase.kind)
    }

    fun `test setPhase to Prompting with question`() {
        val q = question("q1")
        model.setPhase(SessionPhase.Prompting(PromptState.Asking("q1", q)))

        val phase = model.phase as SessionPhase.Prompting
        assertTrue(phase.prompt is PromptState.Asking)
    }

    fun `test setPhase to Prompting with permission`() {
        val p = permission("p1")
        model.setPhase(SessionPhase.Prompting(PromptState.Permitting("p1", p)))

        val phase = model.phase as SessionPhase.Prompting
        assertTrue(phase.prompt is PromptState.Permitting)
    }

    fun `test question tool ref is stored in Prompting phase`() {
        val q = Question(
            id = "q1",
            items = listOf(QuestionItem("Pick one", "Choice", listOf(QuestionOption("A", "Option A")), false, true)),
            tool = ToolCallRef("msg1", "call1"),
        )

        model.setPhase(SessionPhase.Prompting(PromptState.Asking("q1", q)))

        val prompt = (model.phase as SessionPhase.Prompting).prompt as PromptState.Asking
        val ref = prompt.question.tool
        assertNotNull(ref)
        assertEquals("msg1", ref!!.messageId)
        assertEquals("call1", ref.callId)
    }

    fun `test permission fields are preserved in Prompting phase`() {
        val p = Permission(
            id = "p1",
            sessionId = "ses",
            name = "edit",
            patterns = listOf("*.kt"),
            always = listOf("src/**"),
            meta = PermissionMeta(
                rules = listOf("src/**"),
                diff = "patch",
                filePath = "src/A.kt",
                fileDiff = PermissionFileDiff("src/A.kt", additions = 2, deletions = 1),
                raw = mapOf("kind" to "edit"),
            ),
            message = "Allow edit?",
            tool = ToolCallRef("msg1", "call1"),
            state = PermissionRequestState.RESPONDING,
        )

        model.setPhase(SessionPhase.Prompting(PromptState.Permitting("p1", p)))

        val prompt = (model.phase as SessionPhase.Prompting).prompt as PromptState.Permitting
        assertEquals(listOf("*.kt"), prompt.permission.patterns)
        assertEquals(listOf("src/**"), prompt.permission.always)
        assertEquals("src/A.kt", prompt.permission.meta.filePath)
        assertEquals(PermissionRequestState.RESPONDING, prompt.permission.state)
        assertEquals("msg1", prompt.permission.tool!!.messageId)
    }

    fun `test loadHistory populates typed contents and fires HistoryLoaded`() {
        model.addMessage(msg("old", "user"))
        events.clear()

        val text = PartDto(id = "p1", sessionID = "s1", messageID = "m1", type = "text", text = "hello")
        val tool = PartDto(id = "p2", sessionID = "s1", messageID = "m1", type = "tool", tool = "bash", state = "completed", title = "ls")

        model.loadHistory(listOf(MessageWithPartsDto(msg("m1", "assistant"), listOf(text, tool))))

        assertNull(model.message("old"))
        val entry = model.message("m1")!!
        assertTrue(entry.parts["p1"] is Text)
        assertEquals("hello", (entry.parts["p1"] as Text).content.toString())
        assertTrue(entry.parts["p2"] is Tool)
        assertEquals(ToolExecState.COMPLETED, (entry.parts["p2"] as Tool).state)
        assertTrue(events.single() is SessionModelEvent.HistoryLoaded)
    }

    fun `test loadHistory skips unknown content types`() {
        val text = PartDto(id = "p1", sessionID = "s1", messageID = "m1", type = "text", text = "visible")
        val snapshot = PartDto(id = "p2", sessionID = "s1", messageID = "m1", type = "snapshot")

        model.loadHistory(listOf(MessageWithPartsDto(msg("m1", "assistant"), listOf(text, snapshot))))

        val entry = model.message("m1")!!
        assertTrue(entry.parts.containsKey("p1"))
        assertFalse(entry.parts.containsKey("p2"))
    }

    fun `test clear resets messages and phase`() {
        model.addMessage(msg("m1", "user"))
        model.setPhase(SessionPhase.Working(StatusState.Working("busy")))
        model.app = KiloAppStateDto(KiloAppStatusDto.READY)
        model.workspace = KiloWorkspaceStateDto(KiloWorkspaceStatusDto.READY)
        events.clear()

        model.clear()

        assertTrue(model.isEmpty())
        assertEquals(SessionPhase.Idle, model.phase)
        assertTrue(events.single() is SessionModelEvent.Cleared)
    }

    fun `test listener auto removed on dispose`() {
        val child = Disposer.newDisposable("child")
        Disposer.register(parent, child)

        val extra = mutableListOf<SessionModelEvent>()
        model.addListener(child) { extra.add(it) }

        model.addMessage(msg("m1", "user"))
        assertEquals(1, extra.size)

        Disposer.dispose(child)
        extra.clear()

        model.addMessage(msg("m2", "user"))
        assertTrue(extra.isEmpty())
    }

    private fun msg(id: String, role: String) = MessageDto(
        id = id,
        sessionID = "ses",
        role = role,
        time = MessageTimeDto(created = 0.0),
    )

    private fun part(
        id: String,
        mid: String,
        type: String,
        text: String? = null,
        tool: String? = null,
        state: String? = null,
        title: String? = null,
    ) = PartDto(
        id = id,
        sessionID = "ses",
        messageID = mid,
        type = type,
        text = text,
        tool = tool,
        state = state,
        title = title,
    )

    private fun question(id: String) = Question(
        id = id,
        items = listOf(
            QuestionItem(
                question = "Which option?",
                header = "Pick",
                options = listOf(QuestionOption("A", "Option A"), QuestionOption("B", "Option B")),
                multiple = false,
                custom = true,
            ),
        ),
    )

    private fun permission(id: String) = Permission(
        id = id,
        sessionId = "ses",
        name = "edit",
        patterns = listOf("*.kt"),
        always = emptyList(),
        meta = PermissionMeta(),
    )
}
