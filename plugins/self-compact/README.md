# self-compact

Claude Code plugin that lets Claude compact its own context at task milestones — agent-initiated /compact with self-written instructions, then auto-continue. It addresses the anthropics/claude-code feature requests #19877 and #96713 (let the model trigger compaction itself, at a good moment, instead of auto-compact firing at an arbitrary point).

Claude calls the `compact_now` tool at a clean node (spec written, unit finished, work delegated). It passes a structured handoff: the user's standing orders in their own words, decisions with reasons, artifacts, pending work and the first step after compaction. The plugin enforces a context-size floor, queues the request, compacts after the turn ends with Claude's handoff as the compact instructions, then sends a continuation prompt so work resumes without the user pushing it.

## How it works

1. Claude judges it is at a node and calls `mcp__self-compact__compact_now(handoff)`.
2. The gate checks size. Too small: the call is denied with the current percentage and the floor. Otherwise the plugin writes `handoff-<n>.md`, queues the request and returns "scheduled". Claude ends the turn with one line.
3. After the main turn completes (not aborted), a 1.5 s debounce, then a re-check of usage and `$.session.compact({ instructions })`. A skip or error retries every 2 s up to 5 times, then once more at the next main turn end, then gives up with a toast and a note to Claude.
4. On success the plugin toasts `压缩 A% → B%`, logs the run and submits a continuation prompt: node, before/after, handoff path, `next`, standing orders and pending items verbatim.

Races handled:

- The user types a new prompt while a request is queued: compaction still runs after that turn, `next` is dropped and the continuation only says the context was compacted.
- Auto-compact ran first: the request is dropped, the continuation is still sent.
- Esc on the turn: the request is dropped, no continuation.
- More than 3 other tool calls after queueing: the handoff is stale; the request is dropped and Claude is told to call again with current state.
- A blocking Stop hook (for example `/goal`): the plugin ends the turn so the queued compaction can run; after one failed forced end it stops forcing until a natural turn end.

## Gate and tiers

The plugin refuses unless both hold: tokens >= `floorPct` of the window, and the estimated post-compact size (session baseline + 20k) <= `maxPostRatio` of the current size. The baseline is the first main-session request's context size (65k when unknown).

| Context | Behaviour |
| --- | --- |
| < 15% | denied by the plugin |
| 15-20% | big phase handoffs only (spec to plan, plan to implementation, MR up to review) |
| >= 20% | any clean node |
| >= 30% | nudge, then again every 5% |
| >= 40% | nudge wording escalates: compact at the next safe step |

Nudges ride on the next text tool result, or the next prompt's context. They are silent while a request is queued or compacting, in subagents, in non-interactive sessions and when disabled.

Only the main session of interactive sessions can use the tool. Subagents, `-p`, SDK and cron sessions are denied.

## Window size

Built for 1M-token windows. The post-ratio rule makes the floor about 77% of a 200k window, so on small windows the tool is effectively closed and auto-compact does the work.

## Config

Plugin options (`userConfig` in `plugin.json`, set through the plugin settings):

| Option | Default | Meaning |
| --- | --- | --- |
| `floorPct` | 15 | hard floor, percent of the window |
| `maxPostRatio` | 0.55 | estimated post-compact size over current size |
| `nudgeStartPct` | 30 | first nudge (raised to the floor when higher) |
| `nudgeStepPct` | 5 | gap between nudges |
| `urgentPct` | 40 | escalated nudge wording |
| `enabled` | true | false: tool still registered, every call denied, no nudges |

`DISABLE_COMPACT=1` in the environment also denies every call.

## Data

Under `~/.claude/self-compact/`, never inside a repo:

- `<session-id>/handoff-<n>.md`: the rendered handoff plus the last 5 real user messages.
- `log.jsonl`: one line per request (`queued`, `denied:<why>`, `done`, `preempted`, `aborted`, `stale`, `failed`) with time, session, node, request percent, before/after percent and duration. Use it to tune the floor.

Mods cannot import `node:fs`; files go through the engine's `$.fs`.

## Post-compact injection

Standing orders and pending items reach Claude through the continuation prompt (verbatim, always sent after a compaction). A separate `SessionStart` (`source: compact`) `additionalContext` injection is not used: the continuation already carries both, and a second copy would only add tokens.

## Install

Via `bin/harness-sync`, which adds this repo as the `wei-harness` marketplace. By hand:

```
claude plugin marketplace add <path to wei-harness>
claude plugin install self-compact@wei-harness
```

Needs a Claude Code build with mods (written on 2.1.322).

## Tests

```
claude plugin validate plugins/self-compact
claude plugin test plugins/self-compact
```
