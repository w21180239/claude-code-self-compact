# Changelog

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
