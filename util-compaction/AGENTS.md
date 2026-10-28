# util-compaction context/cache development

Follow `/home/ubuntu/src/sgai-pi/modules/ctx-engine/AGENTS.md` for context/cache invariants and live verification.

- Keep creation-time tool-output caps constant; never re-bound a marked historical result.
- For managed loopback `/r/` chat routes on port 4141, send private session/window/reserve headers through `before_provider_headers`. The router owns aggregate fitting; the client still bounds individual tool outputs.
- For other models, reapply the session-branch/model-specific dropped-call IDs saved in `context-budget-frontier` custom entries. Advance only above the FULL budget, then target 60%. Preserve system/user messages and complete tool pairs. Warn only on new cuts, not stable reapplication.
- Preserve existing proactive `ctx.compact()` behavior and user settings. `/context-reload` uses supported `ctx.reload()` and is callable through RPC prompt; `/reload` remains the interactive command.
- Verification is MANUAL TELEMETRY ONLY: launch an actual Pi RPC instance, pass minimal essential turns, await `agent_settled`, inspect actual provider input/cacheRead/output plus router frontier telemetry. Do not add or run unit tests for this subsystem. No mock providers, synthetic suite assertions, full-stream logs, or prompt/credential logging.
- Build with `bash scripts/build-extension.sh util-compaction` from `extensions/`; deploy its manifest and single bundle to `~/.pi/agent/extensions/util-compaction/`. Do not deploy unrelated working changes. Static build/syntax checks are allowed; report live outcomes separately.
