# Changelog

## 0.3.2 - 2026-11-13

- Fixed: a main-loop step reporting all-zero usage overwrote the context fallback with 0, so `compact_now` was denied as "0% (0k)" and the nudge state reset. Such a step now leaves the last reading in place.
- Fixed: auto-compact and `/compact` left the pre-compaction step total in the fallback until the next request, so on a provider without an engine reading the gate could pass on a context that had just shrunk. The plugin now hooks `session.compact` and replaces the fallback with the compaction's reported size, or clears it.
- Docs: the gate section names the cause. The engine reads context from the newest assistant message; OpenCode Go serving DeepSeek sends zeros in `message_start` and the real usage only in `message_delta`, so a tool call made mid-stream sees no tokens.

## 0.3.1 - 2026-11-13

- Fixed: `compact_now` was denied with "Context usage is not available yet" for the whole session on providers that answer with zero usage. The engine then reports no context tokens, so the gate had nothing to read. It now falls back to the total of the last main-loop request's usage, which the plugin already reads on every step; the fallback is cleared at session boundaries and after a compaction. Seen with DeepSeek through an Anthropic-compatible endpoint.
- Fixed: on a resumed session, where the first request carries more than 3 messages, the baseline stays unknown and `floorTokens` produced `NaN`, which silenced or misplaced the nudges. It now falls back to 65k there, as the gate already did.
- Fixed: the tests' file mocks keyed raw engine paths, so every assertion on a written file or log line failed on Windows.

## 0.3.0 - 2026-11-13

- Changed: the gate's second rule is now an absolute saving. `minSavingK` (default 40k) replaces `maxPostRatio`: `need = max(floorPct x window, baseline + 20k + minSavingK x 1k)`. With a 65k baseline the floor is 125k, or 12.5% of a 1M window and 62.5% of a 200k one; 0.2.0 demanded 77% there, which shut the tool on small windows.
- Changed: defaults `floorPct` 10 (was 15), `nudgeStartPct` 20 (was 30), `urgentPct` 35 (was 40). The 83 compactions in the author's history have a median of 262k tokens (26% of a 1M window) and a 10th percentile of 149k, so the old nudge line and floor fired later than the user's own habit.
- Added: node signals `git merge`, `gh pr review`/`comment`/`close`, `gh issue comment`/`close`, outbound sends through `gog`, `agent-slack`, `slack` or `outlook` (strong), passing test commands, and a foreground subagent returning (weak).
- Added: a work-block self-check. A main turn with two or more tool calls is treated as a block of work even without a git or PR signal, so the turn-end check no longer depends on the node detector. It fires from `nudgeStartPct - 5` and says "the last turn finished a block of work".
- Changed: a turn ending with a question no longer suppresses the self-check. Completion summaries often end that way, and the history shows compactions at exactly those points; `AskUserQuestion` still suppresses it.
- Changed: the block-start hint replaces the topic-switch hint and fires on every human prompt once the gate is open, wording the new block as either a new topic or picking work up after a pause. The context had to be 5 points above the floor before.
- Why: the user's own compaction history is dominated by manual `/compact` typed right after a block ended, at 15-40% of a 1M window. The 0.2.0 triggers waited for a git/PR node or 30% fill, so most of those moments passed without a call.

## 0.2.0 - 2026-11-12

- Added: node detection (`detectNode`): `git push`, PR/MR create or merge, `git tag`, spec/plan/handoff writes and all-completed todo lists are strong signals; `git commit`, a new `.md` file and a background agent launch are weak ones. A one-line flag rides the tool result when the gate is open.
- Added: turn-end self-check. After a flagged node without a `compact_now` call, or a long uncompacted stretch, the plugin submits one short prompt asking Claude to compact or answer "skip". It skips turns that end with a question, limits itself to one check per node kind per 5 points of growth, and logs `self-check`, `self-check:compacted` and `self-check:declined`.
- Added: topic-switch hint. A human prompt at least 5 points above the floor carries a model-only line suggesting compaction first when the request is unrelated.
- Added: `autoNodes` (all three triggers) and `turnEndCheck` (self-check only) options, both default on.
- Changed: the tool description builds its tiers from `floorPct`, `nudgeStartPct` and `urgentPct`; node nudge, self-check and topic-switch texts state that the size gate already passed and that compaction does not stop the task.
- Why: a live test showed that the tool description alone never triggers compaction; Claude finished a phase and moved on. The plugin now supplies the trigger so the user never has to mention compaction.

## 0.1.2 - 2026-11-12

- Changed: `releaseStopHooks` defaults to off. Where Claude Code's built-in guard (`cc-plugin-sec-default`) loads (Team/Enterprise logins, machines with managed settings), user mods' `classic.Stop` hooks never run and Claude Code warned at every turn end. The option still works on personal setups.

## 0.1.1 - 2026-11-12

- Added: `releaseStopHooks` option (default true). Set false to skip the `classic.Stop` release when another plugin's Stop hook runs first and Claude Code warns that this hook was skipped.
- Verified: first interactive end-to-end run, queue -> compact 9.5% -> 1.7% in 17 s -> continuation -> next phase.

## 0.1.0 - 2026-11-12

First public release.

- `compact_now` tool: Claude requests a compaction at a task milestone with a structured handoff (objective, standing orders, decisions, artifacts, pending work, `next`).
- Size gate enforced by the plugin: a percent floor plus an estimated post-compact size limit, with the 15/20/30/40 tiers described to Claude.
- Compaction runs after the turn ends, with the handoff as the compact instructions, then a continuation prompt resumes work.
- Race handling: new user prompt, auto-compact running first, Esc, stale handoff, blocking Stop hooks, retries.
- Context-size nudges at 30% and every 5% after, escalating at 40%.
- Handoff files and `log.jsonl` under `~/.claude/self-compact/`.
- Settings through `userConfig`; `DISABLE_COMPACT=1` denies every call.
- English and Chinese UI: the `language` option (`en` default, `zh`) selects every string the user or Claude reads: tool description, denials, toasts, nudges, continuation prompt and handoff headings. Any other value falls back to English.
- Review hardening: all conversation state resets at `session.end` (/clear, /resume and /branch fire no `session.start`); the post-compact baseline is read only from a request with at most 3 messages; `log.jsonl` rotates to `log.1.jsonl` at about 2 MB and an unreadable log is never overwritten; Esc during the compaction itself is recognised and drops the request.
