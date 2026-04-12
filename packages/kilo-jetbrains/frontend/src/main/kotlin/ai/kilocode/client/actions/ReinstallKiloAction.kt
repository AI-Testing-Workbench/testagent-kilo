package ai.kilocode.client.actions

import ai.kilocode.client.KiloAppService
import ai.kilocode.rpc.dto.ConnectionStatusDto
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service

class ReinstallKiloAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        service<KiloAppService>().reinstallAsync()
    }

    override fun update(e: AnActionEvent) {
        val state = service<KiloAppService>().state.value
        e.presentation.isEnabled = state.status != ConnectionStatusDto.CONNECTING
    }
}
