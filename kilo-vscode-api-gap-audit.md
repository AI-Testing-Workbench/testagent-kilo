# kilo-vscode API Gap Audit

Date: 2026-06-04

Scope:

- Frontend: `packages/kilo-vscode/src`
- Backend/SDK baseline: current generated `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- Method: scan active `client.*` SDK call chains, excluding commented code, then verify with `bun run check-types:extension`

## Summary

The frontend contains 57 active SDK call chains. 19 of those call chains are not exposed by the current generated SDK, which means `testagent-core` does not currently provide these API surfaces to `kilo-vscode`.

Already present:

- `permission.saveAlwaysRules`
- `provider.oauth.*`
- `global.config.*`

## Missing API Surfaces

### `client.kilo.*`

These Kilo-specific APIs are referenced by the extension but are missing from the SDK:

- `kilo.organization.set`
- `kilo.cloudSessions`
- `kilo.cloud.session.get`
- `kilo.cloud.session.import`
- `kilo.claw.status`
- `kilo.claw.chatCredentials`
- `kilo.fim`

References:

- `packages/kilo-vscode/src/kilo-provider/handlers/auth.ts:112`
- `packages/kilo-vscode/src/kilo-provider/handlers/cloud-session.ts:41`
- `packages/kilo-vscode/src/kilo-provider/handlers/cloud-session.ts:76`
- `packages/kilo-vscode/src/kilo-provider/handlers/cloud-session.ts:138`
- `packages/kilo-vscode/src/kiloclaw/KiloClawProvider.ts:223`
- `packages/kilo-vscode/src/kiloclaw/KiloClawProvider.ts:248`
- `packages/kilo-vscode/src/kiloclaw/KiloClawProvider.ts:393`
- `packages/kilo-vscode/src/services/autocomplete/AutocompleteModel.ts:51`

### `client.kilocode.*`

These Kilo Code migration/agent APIs are referenced by the extension but are missing from the SDK:

- `kilocode.removeAgent`
- `kilocode.sessionImport.project`
- `kilocode.sessionImport.session`
- `kilocode.sessionImport.message`
- `kilocode.sessionImport.part`

References:

- `packages/kilo-vscode/src/KiloProvider.ts:2280`
- `packages/kilo-vscode/src/legacy-migration/sessions/migrate.ts:78`
- `packages/kilo-vscode/src/legacy-migration/sessions/migrate.ts:80`
- `packages/kilo-vscode/src/legacy-migration/sessions/migrate.ts:101`
- `packages/kilo-vscode/src/legacy-migration/sessions/migrate.ts:105`

### `client.suggestion.*`

These suggestion APIs are referenced by the extension but are missing from the SDK:

- `suggestion.accept`
- `suggestion.dismiss`

Related missing type:

- `SuggestionRequest`

References:

- `packages/kilo-vscode/src/kilo-provider/handlers/suggestion.ts:8`
- `packages/kilo-vscode/src/kilo-provider/handlers/suggestion.ts:60`
- `packages/kilo-vscode/src/kilo-provider/handlers/suggestion.ts:81`

### `client.remote.*`

These remote status APIs are referenced by the extension but are missing from the SDK:

- `remote.status`
- `remote.enable`
- `remote.disable`

References:

- `packages/kilo-vscode/src/services/RemoteStatusService.ts:52`
- `packages/kilo-vscode/src/services/RemoteStatusService.ts:63`
- `packages/kilo-vscode/src/services/RemoteStatusService.ts:72`
- `packages/kilo-vscode/src/services/RemoteStatusService.ts:74`

### Other Missing APIs

- `commitMessage.generate`
- `config.warnings`

References:

- `packages/kilo-vscode/src/services/commit-message/index.ts:88`
- `packages/kilo-vscode/src/KiloProvider.ts:2634`

## Missing Types And Event Shapes

The extension typecheck also fails because these SDK schema/event surfaces do not match frontend expectations:

- `Session.create` input is missing `platform`
- `Agent` is missing `displayName`
- `Agent` is missing `deprecated`
- `QuestionRequest` is missing `blocking`
- `Session2` is missing `viewed`
- message delta event data is missing `partType`

Missing event union members:

- `suggestion.shown`
- `suggestion.accepted`
- `suggestion.dismissed`
- `session.info`
- `kilo-sessions.remote-status-changed`
- `global.config.updated`

## Verification Commands

```sh
bun run check-types:extension
```

Result: failed with missing SDK API/type errors listed above.

Static scan result:

- Active SDK call chains found: 57
- Missing active SDK call chains: 19

