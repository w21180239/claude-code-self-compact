# Design

## Problem

Long Claude Code sessions compact whether you plan for it or not. Auto-compact fires at an arbitrary moment, often in the middle of a unit of work, and the summarizer has to guess which parts of the conversation matter. A manual `/compact` is better because a person picks the moment and writes the instructions, but it needs the person.

The design question is whether Claude can do the person's part: notice a good moment, write the instructions, and carry on afterwards. self-compact answers with a tool, a gate and a continuation prompt. It is a response to the feature requests [anthropics/claude-code#19877](https://github.com/anthropics/claude-code/issues/19877) and [#96713](https://github.com/anthropics/claude-code/issues/96713).

The node and anti-node lists below come from 214 manual compactions in one maintainer's own history (1M window, median 318k tokens before compaction). About a third of them happened at 32-72% of the window in the middle of a task, forced by context that had grown too big to ignore, with the task nowhere near a boundary. Claude is meant to catch that case earlier and at a cleaner point.

## Goals and non-goals

Goals:

1. Claude requests a compaction through a tool and writes the instructions itself.
2. The plugin reports real context usage, enforces a floor and nudges Claude to look for a node.
3. The compaction runs after the current turn, and Claude gets its next step back without the user pushing.
4. Standing orders, decisions with reasons, pending delegations and the user's recent wording survive.
5. Every request is logged so the thresholds can be tuned.

Non-goals:

- Replacing the summarizer or rewriting history. The plugin uses native compaction with instructions Claude wrote.
- Subagents. They stay short and are split when they grow; only the main session may compact.
- Other agent CLIs, external triggers, or cross-session compaction.

Failure modes that count as the plugin being wrong: more total tokens spent (compacting too early or too often), lower task quality (compacting at an anti-node, or a handoff that drops a rule), interrupting the user, and a session that stalls after compaction.

## Flow

```text
Claude judges it is at a node
  -> mcp__self-compact__compact_now(handoff)
       gate fails: return a denial with the current percentage and the floor
       gate passes: write handoff-<n>.md, queue the request, return "scheduled"
main turn completes (not aborted)
  -> 1.5 s debounce, re-read usage, still above the floor
  -> $.session.compact({ instructions })
       skipped or error: retry every 2 s, 5 times, once more at the next main turn end, then give up
       done: log, toast, $.prompt.submit(continuation)
```

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Queued: compact_now passes the gate
    Idle --> Idle: compact_now denied (logged)
    Queued --> Idle: Esc, stale handoff, or auto-compact ran first
    Queued --> Waiting: main turn completes
    Waiting --> Compacting: 1.5 s debounce, usage still above floor
    Compacting --> Waiting: skip or error, retry (max 5, then next turn end)
    Compacting --> Idle: done, continuation prompt submitted
    Waiting --> Idle: gave up, toast and note to Claude
```

One request is kept per session. A new `compact_now` replaces the queued one.

## Gate

The plugin refuses the call unless both conditions hold:

1. `tokens >= floorPct% x window`
2. `(baseline + 20k) / tokens <= maxPostRatio`, where `baseline` is the context size of the session's first main request (65k when unknown) and 20k is the allowance for the summary and re-injected files.

Both reduce to one threshold: `need = max(floorPct x window, (baseline + 20k) / maxPostRatio)`.

With the defaults and a 65k baseline, `(65k + 20k) / 0.55 = 154.5k`. On a 1M window that is 15.5%, so the 15% floor and the ratio rule agree. On a 200k window it is 77%, which is why the tool is effectively closed on small windows and auto-compact stays in charge. The plugin does not scale thresholds with the window.

Why the ratio rule exists: a compaction leaves roughly 80k behind (measured median). Compacting a 100k context saves almost nothing and still pays for the summary.

### Cost model

Relative to the input price: cache read 0.1x, 1-hour cache write 2x, output 5x. One compaction costs about `0.1 x C + 105k` input-equivalent tokens, where `C` is the context size and 105k is the estimated cost of generating the summary and re-caching the roughly 80k that remains. After it, each call saves `0.1 x (C - 80k)`.

| Context before | Cost of compacting | Saved per call | Break-even |
| --- | --- | --- | --- |
| 150k | 120k | 7k | about 17 calls |
| 200k | 125k | 12k | about 10 calls |
| 300k | 135k | 22k | about 6 calls |

A compaction takes 30-55 seconds on the measured setup. The model is an estimate; `log.jsonl` records before and after percentages so you can check it against your own sessions.

## Tiers

| Context | Behavior |
| --- | --- |
| below the floor | denied by the plugin |
| 15-20% | big phase handoffs only, with a clearly long next phase |
| 20% and up | any clean node |
| 30% and up | nudges start, then every 5% |
| 40% and up | nudge wording escalates: compact at the next safe step |

The tiers are in the tool description, so Claude sees them on every turn. Only the floor is enforced mechanically. The nudge start is `max(nudgeStartPct, floorPct)` so a nudge never appears below the floor.

## Nodes and anti-nodes

Good nodes, by frequency in the 214-compaction history:

1. A unit of work ends and a new request starts: last tool was a commit-and-push check, merge confirmation, sent message or ticket update; there is a completion summary; no agents are running.
2. State was just written to disk (handoff file, memory, skill) and pushed.
3. Topic change: the user asks for something unrelated.
4. Phase handoff: spec or plan written, next step named, merge request created.
5. Work delegated and now waiting, provided the handoff's `pending` lists each running task and how it reports back.
6. The user says to compact, continue or move on.

Anti-nodes, where compacting loses the most:

- A question is waiting for the user's answer.
- A draft is waiting for the user to say send.
- The user just corrected something or granted a permission that is not yet in the handoff.
- Mid polling, retrying, editing, or a debug loop.
- The API just returned an error.
- Waiting on a manual login or a dialog.
- A background agent's result arrived but has not been read.

The plugin checks one anti-node mechanically: the last tool call was `AskUserQuestion`. The rest is Claude's judgment, guided by the tool description.

## Handoff

`compact_now` takes `node`, `objective`, `standing_orders` (the user's rules in their own words), `decisions` (with reasons), `artifacts`, `pending` (each running task and how it reports), `done`, `next`, and optional `drop`. A call missing a required field is denied and the missing field is named.

The plugin renders the handoff as markdown, appends the user's last five real messages (commands, system reminders and task notifications are filtered out), writes `handoff-<n>.md`, and sends it as the compact instructions after a fixed preamble that tells the summarizer to keep standing orders verbatim, list every pending item and end with `next`.

Instructions are capped at 8,000 characters. Trimming order: `done`, then the oldest user messages, then `drop`, `decisions` and `artifacts` (from the end). `standing_orders`, `pending` and `next` are never trimmed.

## Races

| Situation | Behavior |
| --- | --- |
| The user types a new prompt while a request is queued | Compaction still runs after that turn. `next` is dropped and the continuation says only that the context was compacted. |
| Auto-compact ran first | The request is dropped, the continuation is still sent. |
| Esc on the turn | The request is dropped, no continuation. |
| More than 3 other tool calls after queueing | The handoff is stale: dropped, and Claude is told to call again with current state. |
| A blocking Stop hook such as `/goal` keeps the turn open | The plugin ends the turn so the queued compaction can run. After one failed forced end it stops forcing until a natural turn end. |
| The compact call is skipped or throws | Retry every 2 s up to 5 times, once more at the next main turn end, then give up with a toast and a note delivered to Claude on its next tool result or prompt. |
| Subagent, `-p`, SDK or cron session | Denied, no nudges. |

`compact_now` does not await the compaction. Calling compact from inside a running turn is refused by the engine, so the handler only checks the gate, writes the file, queues, and returns.

## Why the native summarizer

Two ways to shrink context exist: ask the built-in summarizer to do it with better instructions, or replace the history yourself with a summary written elsewhere. self-compact takes the first.

- The native path keeps everything Claude Code already does around compaction: re-injected files, hooks, session bookkeeping.
- Claude's handoff goes in as instructions, so the summary is written by a model that sees the whole conversation.
- No API key, no second model, no network call.

The cost is time: 30-55 seconds per compaction. If that becomes the limiting factor, replacing the history is the next step to evaluate; it is out of scope for 0.1.

Post-compact context is carried by the continuation prompt (standing orders and pending items verbatim). A `SessionStart` injection with `source: compact` was considered and left out: the continuation already carries both, and a second copy only adds tokens.

## Nudges

Each main-session step reads usage. Once usage passes the nudge start, and then after every further `nudgeStepPct`, one line with the current percentage is attached to the next text tool result, or to the next prompt's context if no text result comes first. Crossing `urgentPct` escalates immediately. Nudges stay silent while a request is queued or compacting, inside subagents, in non-interactive sessions and when the plugin is disabled. A missed nudge is acceptable: auto-compact is still the backstop above 40%.

## Data

`~/.claude/self-compact/<session-id>/handoff-<n>.md` and `~/.claude/self-compact/log.jsonl`. Mods cannot import `node:fs`, so files go through the engine's `$.fs`. Nothing leaves the machine and the plugin makes no network calls.

`log.jsonl` has one JSON line per request: `ts`, `session`, `node`, `pct` (usage at request), `result` (`queued`, `denied:<why>`, `done`, `preempted`, `aborted`, `stale`, `failed`, `error`), an optional `reason`, `beforePct`, `afterPct` and `durationMs`.

## Acknowledgements

The design takes ideas from earlier community work and copies no code: the gate-plus-judgment split, post-turn execution, re-check before compacting and Stop-hook release (self-compact by StevenLi-phoenix); fixed handoff sections, verbatim user wording and nudges on tool results (forward-compaction by rezzminator); asking once per threshold (polite-compaction by dtinth). The implementation is a clean-room rewrite.
