package ai.kilocode.client.session.model

import ai.kilocode.client.session.model.content.Permission
import ai.kilocode.client.session.model.content.Question

sealed class PromptState {
    abstract val id: String

    data class Asking(
        override val id: String,
        val question: Question,
    ) : PromptState()

    data class Permitting(
        override val id: String,
        val permission: Permission,
    ) : PromptState()
}
