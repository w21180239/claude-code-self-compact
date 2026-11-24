# Changelog

## 0.7.1 - 2026-11-24

- Fixed: with `autoCompactWindow` set below the model window, every percent (queue, denial, nudges, tool description, log) was of the auto-compact limit, so it read about twice the status line (49.7% vs 26% at 500k on 1M). Percent is now of the model window; the limit only caps the urgent tier.

## 0.7.0 - 2026-11-18

- Added: the skill working set. The engine re-injects every invoked skill's body after a compaction and mods cannot reach that step, so the plugin leaves it alone and keeps what a compaction loses: the reference files a skill read under its dir and the step its procedure had reached. Main-session `Skill` loads and Read, Grep, Glob, Edit, Write or Bash paths under `/skills/<name>/` are tracked per skill (refs: at most 8, newest first; `SKILL.md` is use, not a ref); subagent calls are ignored.
- Added: optional `compact_now` fields `keep_skills` and `drop_skills` (string arrays; malformed values are ignored). At compaction a skill is hot when kept, used within `hotWindow` main requests, or its learned miss rate is at least 0.3 over 3 or more compactions; done when dropped and not kept.
- Added: for hot skills a never-trimmed line in the compact instructions (record the step reached and what remains) and a "Skill working set" section in the resume message after the language line and next step: refs of at most `refInlineK` thousand tokens inlined within `skillBudgetK`, the rest listed by path; done skills get a finished line.
- Added: learning. A main Read of a listed ref within 30 main requests after a compaction is a miss (`skill-ref-miss`), a Read of an inlined ref logs `skill-ref-reread`; `profile.json` gains `skills: { <name>: { compactions, refMisses } }`. `done` and `preempted` rows carry `skills: { hot, done, inlinedK, listed }`.
- Added: options `hotWindow` (20), `refInlineK` (2), `skillBudgetK` (6).

## 0.6.0 - 2026-11-18

- Added: `compact_now` takes a required `language` field, `{ chat, outputs[] }`: the conversation language and one verbatim rule per output channel. A missing or malformed value never blocks a compaction. Per field the given value wins, then the rules inherited from the previous compaction, then (for `chat`) the language detected from the last 5 real user messages (CJK >= 30% of non-space characters is Chinese).
- Added: the rules ride four carriers: a first "Language rules" section in the handoff file, a never-trimmed line in the compact instructions telling the summarizer to write in the chat language and copy each rule verbatim, the first line of the continuation prompt, and a short rule line appended to the first 3 real user prompts after a compaction.
- Added: `log.jsonl` rows `queued` and `done` carry `langSource` (`tool`, `inherited`, `detected`, `none`); `lang-drift` (with `expected` and `got`) is logged once when the first assistant reply after a compaction is in the other language.
- Fixed: the self-check prompts and nudges the plugin submits no longer count as user messages in the handoff's recent messages.

## 0.5.0 - 2026-11-18

- Changed: every threshold derives from P, the learned post-compact size. The floor is `max(C(floorCalls), floorPct x window)`; the node, work and urgent tiers follow, with `C(N) = (10 x F + N x P) / (N - 1)` and `F` = `compactCostK`. Each tier is capped at `urgent = min(urgentK x 1k, 0.8 x window)`.
- Added: P learning. The first main step after each compaction is a measured sample, folded into an exponentially weighted average per project and globally in `~/.claude/self-compact/profile.json`, with outlier handling; fallback is the session sample, project, global, then baseline + 25k. `log.jsonl` gains `pSample`.
- Added: one-time per-session heavy-harness hint when compaction pays little (`C(workCalls)` at or above `urgentK`).
- Added: options `floorCalls`, `nodeCalls`, `workCalls`, `urgentK`, `compactCostK`. `floorPct` now defaults to 0.
- Deprecated: `minSavingK`, `nudgeStartPct` and `urgentPct` are accepted, ignored and logged once at session start.
- Added: every tier is at least `P + 25k`, applied after the urgent cap, so a compaction always frees 25k or more and the context cannot re-trip a tier right after it.
- Changed: the `compact_now` description is rendered by a `tool.describe` hook and refreshed at the next compaction (one compaction behind P, prompt cache kept); the tool is registered once.

## 0.4.0 - 2026-11-14

- Added: the compact-instruction preamble names what the summarizer must copy exactly (file paths with line numbers, signatures and load-bearing code lines, error strings, numbers and IDs, the original request and how the goal changed) and what it may drop (logs whose result is stated, repeated reads, the step-by-step path to a conclusion, dead ends reduced to their lesson).
- Added: an optional `lessons` handoff field for what failed and why, rendered as its own section and trimmed after `drop`.
- Added: the session's original request rides every handoff. It is saved to `<session-id>/intent.md` on the first `compact_now` (first real user message, capped at 1,500 characters) and reused afterwards, since after a compaction the transcript starts with the summary. Trimmed after `lessons`, before `decisions`.
- Added: the continuation prompt ends with a pointer to the session transcript (`~/.claude/projects/*/<session-id>.jsonl`) and tells Claude to grep it for exact details instead of guessing or redoing work. The plugin does not read the transcript.
- Why: billion-context's paper reports models only restore compressed content when told to, and LangWatch measured agents re-reading context and drawing more user corrections in the steps after a compaction.

## 0.3.3 - 2026-11-13

- Changed: finished work saved to disk and handed over for review now counts as a closed block, so the agent compacts there and lists the review in `pending`. Anti-nodes narrow to a question whose answer decides the next step and an outgoing draft waiting for send.

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
- Changed: thresholds are a necessary condition only. Nudges, self-checks and the topic-switch hint now ask the model to compact only when the block is closed, the next work does not need large raw text in context, and enough work remains; a self-check reply is `skip: <reason>` and `self-check:declined` logs the `reason` (200 characters).
