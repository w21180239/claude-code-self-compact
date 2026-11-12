# Changelog

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
