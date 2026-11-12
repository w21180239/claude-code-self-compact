# self-compact

**A Claude Code plugin that lets Claude compact its own context at task milestones: agent-initiated `/compact` with self-written handoff instructions, gated by context size, then auto-continue.** Smarter auto-compact for long sessions, with English and Chinese UI.

Claude gets a `compact_now` tool. At a clean node (spec written, unit finished, work delegated) it passes a structured handoff: your standing orders in your own words, decisions with reasons, artifacts, pending work and the first step after compaction. The plugin enforces a context-size floor, compacts after the turn ends with that handoff as the instructions, then sends a continuation prompt so work resumes without you typing anything.

## Install

```
/plugin marketplace add w21180239/claude-code-self-compact
/plugin install self-compact@claude-code-self-compact
```

Needs Claude Code 2.1.287 or later. Built for 1M-token windows; on a 200k window the size gate keeps the tool effectively closed and auto-compact does the work.

## Configuration

Set through the plugin settings (`userConfig`), for example `claude plugin configure self-compact`.

| Option | Default | Meaning |
| --- | --- | --- |
| `language` | en | `en` or `zh`: language of the tool description, denials, toasts, nudges and continuation prompt; any other value falls back to `en` |
| `floorPct` | 15 | hard floor, percent of the window |
| `maxPostRatio` | 0.55 | estimated post-compact size over current size |
| `nudgeStartPct` | 30 | first nudge (raised to the floor when higher) |
| `nudgeStepPct` | 5 | gap between nudges |
| `urgentPct` | 40 | escalated nudge wording |
| `releaseStopHooks` | true | true: a queued compaction ends a turn that another Stop hook (such as /goal) holds open. Set false if Claude Code warns that this hook was skipped |
| `enabled` | true | false: the tool stays registered, every call is denied, no nudges |

`DISABLE_COMPACT=1` in the environment also denies every call.

## Data

Everything lives under `~/.claude/self-compact/`: `<session-id>/handoff-<n>.md` and `log.jsonl` (rotated to `log.1.jsonl` at about 2 MB). The plugin makes no network calls and has no dependencies.

## More

- Full README with tiers, cost model and troubleshooting: [README.md](../../README.md)
- Design, races and gate math: [docs/en/DESIGN.md](../../docs/en/DESIGN.md)
- Tests: `claude plugin test plugins/self-compact`
