# self-compact

**A Claude Code plugin that lets Claude compact its own context at task milestones: agent-initiated `/compact` with self-written handoff instructions, gated by context size, then auto-continue.** Smarter auto-compact for long sessions, with English and Chinese UI.

Claude gets a `compact_now` tool. At a clean node (spec written, unit finished, work delegated) it passes a structured handoff: your standing orders in your own words, decisions with reasons, artifacts, pending work and the first step after compaction. The plugin enforces a context-size floor, compacts after the turn ends with that handoff as the instructions, then sends a continuation prompt so work resumes without you typing anything.

## Install

```
/plugin marketplace add w21180239/claude-code-self-compact
/plugin install self-compact@claude-code-self-compact
```

Needs Claude Code 2.1.287 or later. Tuned on 1M-token windows; every threshold derives from the learned post-compact size P and is capped at 80% of the window, so on a small window auto-compact still owns the late stage.

## Configuration

Set through the plugin settings (`userConfig`), for example `claude plugin configure self-compact`.

| Option | Default | Meaning |
| --- | --- | --- |
| `language` | en | `en` or `zh`: language of the tool description, denials, toasts, nudges and continuation prompt; any other value falls back to `en` |
| `floorPct` | 0 | extra floor as a percent of the window; the floor is the larger of this and the `floorCalls` size |
| `floorCalls` | 20 | floor = the context where compacting pays back within this many later calls (see the cost model in the repository README); at least 2 |
| `nodeCalls` | 10 | node tier: any clean node is allowed from the size that pays back within this many calls |
| `workCalls` | 8 | work tier: the turn-end self-check treats a work block as a node from this payback size |
| `urgentK` | 350 | urgent tier in thousand tokens, capped at 80% of the window; every other tier is clamped to it (minimum 50), then raised to at least P + 25k |
| `compactCostK` | 105 | fixed cost of one compaction in thousand tokens (summary plus re-caching); minimum 1 |
| `nudgeStepPct` | 5 | gap between nudges |
| `hotWindow` | 20 | a skill used within this many main requests is hot at compaction (minimum 1) |
| `refInlineK` | 2 | a skill reference of at most this many thousand tokens is inlined into the resume message; 0 lists every ref by path |
| `skillBudgetK` | 6 | total thousand tokens of inlined skill references per compaction; 0 inlines nothing |
| `releaseStopHooks` | false | true: a queued compaction ends a turn that another Stop hook (such as /goal) holds open. Only works on personal (non-managed) setups; the built-in guard skips user mods' Stop hooks elsewhere (see FAQ) |
| `autoNodes` | true | Autonomous triggers: a one-line flag after node-like tool calls (push, merge, PR, tests green, message sent, spec/plan written, todos done), a turn-end self-check, and a hint on every human prompt once the gate is open. false turns all three off |
| `turnEndCheck` | true | The turn-end self-check only (needs `autoNodes`): after a node, a turn that did real work, or a long uncompacted stretch, one extra turn asks Claude whether to compact |
| `enabled` | true | false: the tool stays registered, every call is denied, no nudges |

`DISABLE_COMPACT=1` in the environment also denies every call.

## Data

Everything lives under `~/.claude/self-compact/`: `<session-id>/handoff-<n>.md`, `<session-id>/intent.md` and `profile.json` (the learned post-compact size P, per project and globally) and `log.jsonl` (rotated to `log.1.jsonl` at about 2 MB). The plugin makes no network calls and has no dependencies.

## More

- Full README with tiers, cost model and troubleshooting: [README.md](../../README.md)
- Design, races and gate math: [docs/en/DESIGN.md](../../docs/en/DESIGN.md)
- Tests: `claude plugin test plugins/self-compact`
