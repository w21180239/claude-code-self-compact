import type { EngineInterface, Register, Timer } from 'claude-code'

export type Config = {
  floorPct: number
  minSavingK: number
  nudgeStartPct: number
  nudgeStepPct: number
  urgentPct: number
  enabled: boolean
  releaseStopHooks: boolean
  autoNodes: boolean
  turnEndCheck: boolean
  language: Lang
}

export const DEFAULTS: Config = {
  floorPct: 10,
  minSavingK: 40,
  nudgeStartPct: 20,
  nudgeStepPct: 5,
  urgentPct: 35,
  enabled: true,
  releaseStopHooks: false,
  autoNodes: true,
  turnEndCheck: true,
  language: 'en',
}

// Empty session context, measured on the first main request when unavailable.
export const DEFAULT_BASELINE = 65_000
// What a compaction is expected to leave beyond the baseline (summary + reinjected files).
export const POST_COMPACT_EXTRA = 20_000

export type Usage = { tokens?: number; window?: number }

// ---- UI strings ----

export type Lang = 'en' | 'zh'

type Strings = {
  gateNoUsage: string
  gateBelow: (pct: number, used: string, needPct: number, need: string) => string
  denySubagent: string
  denyNonInteractive: string
  denyDisabled: string
  denyInvalid: (missing: string) => string
  denyAskedUser: string
  denyNoHome: string
  denyWriteFailed: (err: string) => string
  statusQueued: (node: string) => string
  statusCompacting: string
  queued: (pct: number) => string
  staleNote: string
  toastFailed: (reason: string) => string
  noteFailed: (reason: string) => string
  toastDone: (before: string, after: string) => string
  nudgeSoft: (pct: number) => string
  nudgeUrgent: (pct: number) => string
  nodeNames: Record<NodeKind, string>
  nodeNudge: (kind: NodeKind, pct: number) => string
  selfCheck: (kind: NodeKind, pct: number) => string
  selfCheckWork: (pct: number) => string
  selfCheckLong: (pct: number) => string
  topicSwitch: (pct: number) => string
  stopReason: string
  preamble: string
  tail: (path: string) => string
  none: string
  hTitle: (node: string) => string
  hObjective: string
  hStanding: string
  hDecisions: string
  hArtifacts: string
  hPending: string
  hDone: string
  hNext: string
  hDropped: string
  hLessons: string
  hIntent: string
  hRecent: string
  contMarker: string
  contHead: (node: string, before: number, after: string, path: string) => string
  contUnknown: string
  contNext: (next: string) => string
  contNextFallback: string
  contStanding: string
  contPending: string
  contClosing: string
  contRecall: (sessionId: string) => string
  description: (cfg: Config) => string
  node: string
  objective: string
  standing_orders: string
  decisions: string
  artifacts: string
  pending: string
  done: string
  next: string
  drop: string
  lessons: string
}

// The strings the user or the model reads. Add a language here and to `Lang`; configFrom accepts only the keys of this table.
export const STRINGS: Record<Lang, Strings> = {
  en: {
    gateNoUsage: 'Context usage is not available yet (before the first request); try again shortly.',
    gateBelow: (pct, used, needPct, need) =>
      `Context is ${pct}% (${used}), below the compaction threshold ${needPct}% (${need}): compacting now does not pay off, keep working.`,
    denySubagent: 'compact_now is only available to the main session, not to subagents.',
    denyNonInteractive: 'Non-interactive sessions (-p / SDK / scheduled tasks) do not support compact_now.',
    denyDisabled: 'compact_now is disabled (enabled=false or DISABLE_COMPACT=1).',
    denyInvalid: missing => `The handoff has missing or invalid fields: ${missing}. Complete it and call again.`,
    denyAskedUser: 'The previous step asked the user a question; wait for the answer before considering compaction.',
    denyNoHome: 'Cannot find the home directory, so the handoff cannot be written.',
    denyWriteFailed: err => `Writing the handoff failed: ${err}`,
    statusQueued: node => `compact queued · ${node}`,
    statusCompacting: 'compacting…',
    queued: pct =>
      `Queued (context ${pct}%): the plugin compacts after this turn ends and then continues. End the turn now with one line and call no more tools.`,
    staleNote:
      '[self-compact] The queued compact_now expired (several tool calls followed, so the handoff no longer reflects the current state) and was dropped. ' +
      'To still compact, call compact_now again with the latest state.',
    toastFailed: reason => `Compaction not run: ${reason}`,
    noteFailed: reason =>
      `[self-compact] The queued compact_now could not run (${reason}) and was given up. To still compact, call it again at a suitable node with the latest state.`,
    toastDone: (before, after) => `compacted ${before}% → ${after}%`,
    nudgeSoft: pct => `[self-compact] Context ${pct}%, watch for the next node and call compact_now.`,
    nudgeUrgent: pct => `[self-compact] Context ${pct}%, call compact_now at the next safe step, no need to wait for a perfect node.`,
    nodeNames: {
      push: 'git push',
      pr: 'PR/MR create, review or merge',
      tag: 'git tag',
      merge: 'git merge',
      sent: 'outbound message sent',
      'spec-plan': 'spec/plan write',
      handoff: 'handoff note',
      'todos-done': 'todo list (all done)',
      commit: 'git commit',
      tests: 'tests passed',
      'doc-written': 'new document',
      delegated: 'background delegation',
      'agent-done': 'subagent returned',
    },
    nodeNudge: (kind, pct) =>
      `[self-compact] The ${STRINGS.en.nodeNames[kind]} just now looks like a node (context ${pct}%; the plugin has already checked that compacting now is worth it, so do not judge the size again). ` +
      `Compacting does not stop or interrupt the task: work resumes automatically right after, so "don't stop" instructions are no reason to skip. ` +
      `Unless this step is unfinished or a question to the user is open (finished work saved to disk and handed over for review counts as closed: list it in pending), call compact_now before this turn ends.`,
    selfCheck: (kind, pct) =>
      `[self-compact self-check] The last turn showed a node signal (${kind}), context ${pct}%; the plugin has already checked that compacting now is worth it. ` +
      `Compacting does not stop or interrupt the task: work resumes automatically right after, so "don't stop" instructions are no reason to skip. ` +
      `Unless the current step is unfinished or a question to the user is open (finished work saved to disk and handed over for review counts as closed: list it in pending), call compact_now now (next: what to do next, or how to answer the user's latest message if nothing remains); otherwise reply with just "skip" and end.`,
    selfCheckWork: pct =>
      `[self-compact self-check] The last turn finished a block of work, context ${pct}%; the plugin has already checked that compacting now is worth it. ` +
      `Compacting does not stop or interrupt the task: work resumes automatically right after, so "don't stop" instructions are no reason to skip. ` +
      `If this block is closed (nothing unfinished, no open question; finished work saved to disk and handed over for review counts as closed, list it in pending; nothing left running), call compact_now now (next: what to do next, or how to answer the user's latest message if nothing remains); otherwise reply with just "skip" and end.`,
    selfCheckLong: pct =>
      `[self-compact self-check] Context is ${pct}% and has not been compacted; the plugin has already checked that compacting now is worth it. ` +
      `Compacting does not stop or interrupt the task: work resumes automatically right after, so "don't stop" instructions are no reason to skip. ` +
      `Unless the current step is unfinished or a question to the user is open (finished work saved to disk and handed over for review counts as closed: list it in pending), call compact_now now (next: what to do next, or how to answer the user's latest message if nothing remains); otherwise reply with just "skip" and end.`,
    topicSwitch: pct =>
      `[self-compact] Context ${pct}%; the plugin has already checked that compacting now is worth it. If this message opens a new block of work (a different topic, or picking the work up again after a pause) and the previous block is closed, call compact_now first (next: the gist of this request, in its own words) and end the turn; compacting does not stop the task, work resumes automatically right after.`,
    stopReason: 'compact queued: ending this turn so it can run, then work continues automatically.',
    preamble:
      'This compaction was started by the model at a task node. Write the summary from the handoff below: ' +
      'keep "Standing orders" verbatim, never paraphrase; list every "Pending" item with how it reports back; end the summary with "Next step". ' +
      'Copy exactly, never paraphrase: file paths with line numbers, function signatures and load-bearing code lines, error strings, numbers and IDs, the original request and how the goal changed since. ' +
      'Drop: logs whose result is already stated, repeated reads of the same file, the step-by-step path to a conclusion, and dead ends (keep the lesson of each in one line).',
    tail: path => `Full handoff written to: ${path} (readable after compaction)`,
    none: '(none)',
    hTitle: node => `# Node handoff: ${node}`,
    hObjective: 'Objective',
    hStanding: "Standing orders (user's words)",
    hDecisions: 'Decisions',
    hArtifacts: 'Artifacts',
    hPending: 'Pending',
    hDone: 'Done',
    hNext: 'Next step',
    hDropped: 'Dropped threads',
    hLessons: 'Lessons from dead ends',
    hIntent: 'Original request',
    hRecent: 'Recent user messages',
    contMarker: '[self-compact] Node "',
    contHead: (node, before, after, path) => `[self-compact] Node "${node}" compacted (context ${before}% → ${after}). Handoff: ${path}`,
    contUnknown: 'unknown',
    contNext: next => `Next step: ${next}`,
    contNextFallback: 'compacted, continue with the latest user instruction',
    contStanding: "Standing orders (user's words):",
    contPending: 'Pending:',
    contClosing: 'Continue with the next step; reread the handoff for details.',
    contRecall: sid =>
      `The summary drops detail. When you need an exact error string, value, path or command from before compaction, grep the transcript ~/.claude/projects/*/${sid}.jsonl instead of guessing or redoing the work.`,
    description: cfg => `Compact your own context at a task node. The call queues: the plugin compacts after the turn ends, then resumes you at \`next\`.

Tiers (enforced): <${cfg.floorPct}% denied; ${cfg.floorPct}-${cfg.floorPct + NODE_MARGIN_PCT}% only at a big phase handoff; >=${cfg.floorPct + NODE_MARGIN_PCT}% any clean node. Nudged at >=${Math.max(cfg.nudgeStartPct, cfg.floorPct)}%, urgent at >=${cfg.urgentPct}%.

Good nodes: a verified block end (push, merge, PR, tests green, sent, todos done), topic change, phase handoff, subagent returned, delegation waiting, work saved for review. Anti-nodes: open question, unsent draft, new user rule not yet in standing_orders, mid retry/debug loop, unread agent result.

The plugin flags nodes (push, PR, tests, sent): act when the phase is closed.

After "Queued", end the turn now: one line, call no more tools.
`,
    node: 'Node type in one sentence, e.g. "plan written -> start implementation"',
    objective: 'Goal of the whole task',
    standing_orders: 'The user\'s "don\'t/must" rules, authorisations and preferences, verbatim; may be an empty array',
    decisions: 'Decisions made and why',
    artifacts: 'Artifact paths or links (spec, plan, MR, branch)',
    pending: 'Running agents, drafts awaiting approval, items awaiting an outside reply, and how each reports back; may be an empty array',
    done: 'What is done, briefly',
    next: 'The first concrete action after compaction',
    drop: 'Threads explicitly dropped (optional)',
    lessons: 'What failed and why, one line each, so it is not retried (optional)',
  },
  zh: {
    gateNoUsage: '上下文用量暂不可用（首次请求之前），稍后再试。',
    gateBelow: (pct, used, needPct, need) =>
      `当前上下文 ${pct}%（${used}），低于压缩门槛 ${needPct}%（${need}）：现在压不划算，继续工作。`,
    denySubagent: 'compact_now 只能由主会话调用，subagent 不可用。',
    denyNonInteractive: '非交互会话（-p / SDK / 定时任务）不支持 compact_now。',
    denyDisabled: 'compact_now 已禁用（enabled=false 或 DISABLE_COMPACT=1）。',
    denyInvalid: missing => `handoff 缺少或无效的字段：${missing}。补全后重新调用。`,
    denyAskedUser: '上一步是向用户提问，等用户回答之后再考虑压缩。',
    denyNoHome: '找不到用户主目录，无法写入交接单。',
    denyWriteFailed: err => `交接单写入失败：${err}`,
    statusQueued: node => `compact 已排队 · ${node}`,
    statusCompacting: 'compacting…',
    queued: pct => `已排队（上下文 ${pct}%）：本轮结束后自动压缩并续接。现在用一行话收尾本轮，不要再调用任何工具。`,
    staleNote:
      '[self-compact] 排队的 compact_now 已过期（之后又调用了多个工具，交接单不再反映当前状态），已丢弃。' +
      '若仍要压缩，请用最新状态重新调用 compact_now。',
    toastFailed: reason => `压缩未执行：${reason}`,
    noteFailed: reason =>
      `[self-compact] 排队的 compact_now 未能执行（${reason}），已放弃。若仍需压缩，请在合适的节点用最新状态重新调用。`,
    toastDone: (before, after) => `压缩 ${before}% → ${after}%`,
    nudgeSoft: pct => `[self-compact] 上下文 ${pct}%，留意下一个节点调用 compact_now。`,
    nudgeUrgent: pct => `[self-compact] 上下文 ${pct}%，在下一个安全步骤调用 compact_now，不必等完美节点。`,
    nodeNames: {
      push: 'git push',
      pr: 'PR/MR 创建、评审或合并',
      tag: 'git tag',
      merge: 'git merge',
      sent: '对外消息已发送',
      'spec-plan': 'spec/plan 落盘',
      handoff: '交接文档',
      'todos-done': '待办全部完成',
      commit: 'git commit',
      tests: '测试通过',
      'doc-written': '新文档',
      delegated: '后台委派',
      'agent-done': '子代理返回',
    },
    nodeNudge: (kind, pct) =>
      `[self-compact] 刚才的 ${STRINGS.zh.nodeNames[kind]} 像是一个节点（上下文 ${pct}%，插件已确认现在压缩划算，不用再判断大小）。` +
      `压缩不会打断任务，压完会自动接着做；只要这一步已收尾、没有开着的提问（成果已落盘、交给用户审阅也算收尾，写进 pending），就在本轮结束前调用 compact_now。`,
    selfCheck: (kind, pct) =>
      `[self-compact 自检] 上一轮出现了节点信号（${kind}），上下文 ${pct}%，插件已确认现在压缩划算。` +
      `压缩不会打断任务，压完会自动接着做。` +
      `只要当前步骤已收尾、没有开着的提问（成果已落盘、交给用户审阅也算收尾，写进 pending），现在就调用 compact_now（next 写接下来要做的事；没有就写怎么回应用户最新的消息）；否则只回复「不压」并结束。`,
    selfCheckWork: pct =>
      `[self-compact 自检] 上一轮做完了一整块工作，上下文 ${pct}%，插件已确认现在压缩划算。` +
      `压缩不会打断任务，压完会自动接着做。` +
      `如果这一块已经收尾（没有未完成的步骤、没有开着的提问；成果已落盘、交给用户审阅也算收尾，写进 pending、没有还在跑的任务），现在就调用 compact_now（next 写接下来要做的事；没有就写怎么回应用户最新的消息）；否则只回复「不压」并结束。`,
    selfCheckLong: pct =>
      `[self-compact 自检] 上下文已到 ${pct}%，一直没有压缩，插件已确认现在压缩划算。` +
      `压缩不会打断任务，压完会自动接着做。` +
      `只要当前步骤已收尾、没有开着的提问（成果已落盘、交给用户审阅也算收尾，写进 pending），现在就调用 compact_now（next 写接下来要做的事；没有就写怎么回应用户最新的消息）；否则只回复「不压」并结束。`,
    topicSwitch: pct =>
      `[self-compact] 上下文 ${pct}%，插件已确认现在压缩划算。如果这条消息开启一个新工作块（换了话题，或隔了一阵重新接着做）而上一块已经收尾，先调用 compact_now（next 写这条需求的原文要点）再结束本轮；压缩不会打断任务，压完会自动接着做。`,
    stopReason: 'compact 已排队：先结束本轮以执行压缩，随后自动续接。',
    preamble:
      '这是模型在任务节点上主动发起的压缩，请按下面的交接单写摘要：' +
      '「常驻指令」逐字保留，不要转述；「待处理」每一项都要列出，写明各自如何回报；摘要以「下一步」收尾。' +
      '以下内容原样照抄、不要转述：带行号的文件路径、函数签名和关键代码行、报错原文、数值和 ID、用户最初的需求及之后目标的变化。' +
      '可以丢掉：结论已写明的日志、同一文件的重复读取、得出结论的逐步过程、走不通的路（每条留一行教训）。',
    tail: path => `完整交接单已写入：${path}（压缩后可回读）`,
    none: '（无）',
    hTitle: node => `# 节点交接：${node}`,
    hObjective: '目标',
    hStanding: '常驻指令（用户原话）',
    hDecisions: '已定决定',
    hArtifacts: '产物',
    hPending: '待处理',
    hDone: '已完成',
    hNext: '下一步',
    hDropped: '丢弃的支线',
    hLessons: '走不通的路及教训',
    hIntent: '用户最初的需求',
    hRecent: '用户最近原话',
    contMarker: '节点「',
    contHead: (node, before, after, path) => `节点「${node}」已压缩（上下文 ${before}% → ${after}）。交接单：${path}`,
    contUnknown: '未知',
    contNext: next => `下一步：${next}`,
    contNextFallback: '已压缩，按用户最新指令继续',
    contStanding: '常驻指令（用户原话）：',
    contPending: '待处理：',
    contClosing: '先按下一步继续；需要细节回读交接单。',
    contRecall: sid =>
      `摘要会丢细节。需要压缩前的报错原文、数值、路径或命令时，grep transcript ~/.claude/projects/*/${sid}.jsonl，不要猜，也不要重做。`,
    description: cfg => `在任务节点上压缩你自己的上下文。调用只排队：本轮结束后插件自动压缩，并发续接消息让你按 next 继续。

门槛（插件强制，不够会被拒）：<${cfg.floorPct}% 拒绝；${cfg.floorPct}-${cfg.floorPct + NODE_MARGIN_PCT}% 只在大阶段交接压（spec→plan、plan→实现、MR 创建→review）且下一阶段明显够长；>=${cfg.floorPct + NODE_MARGIN_PCT}% 任何干净节点可压。>=${Math.max(cfg.nudgeStartPct, cfg.floorPct)}% 未压插件会提醒；>=${cfg.urgentPct}% 在下一个安全步骤就压，不必等完美节点。

好节点：一块工作收尾并已验证（push、合并、PR、测试通过、消息已发、待办全完成），转新需求；状态刚落盘；用户换话题；阶段交接；子代理返回；任务委派出去进入等待（pending 写明每个任务及回报方式）；成果落盘待用户审阅；用户说"等会 compact/继续/下一个"。

反节点（不要调用）：提问没答且答案决定下一步；外发草稿等用户说"发"；用户刚纠正或给了新规则/授权但未写进 standing_orders；轮询、重试、调试循环中途；API 刚报错；等用户登录或处理弹窗；后台 agent 结果已到未读。

standing_orders 填用户"不要/必须"、授权、偏好的原话；pending 列每个在跑任务、待批准草稿、等外部回复的事及回报方式；next 写压缩后第一步具体动作。

插件会在工具结果里标出节点（push、PR、测试通过、消息已发、spec/plan、待办全完成）：阶段已收尾就按标记压缩。

收到"已排队"后用一行话收尾本轮，不要再调用任何工具。`,
    node: '节点类型，一句话，如"plan 已落盘 → 开始实现"',
    objective: '整个任务的目标',
    standing_orders: '用户的"不要/必须"、授权、偏好，原话；可为空数组',
    decisions: '已定决定及原因',
    artifacts: '产物路径或链接（spec、plan、MR、分支）',
    pending: '在跑的 agent、待批准草稿、等外部回复的事，各自如何回报；可为空数组',
    done: '已完成的事，简述',
    next: '压缩后的第一步具体动作',
    drop: '明确丢弃的支线（可选）',
    lessons: '试过不行的做法及原因，每条一行，免得重试（可选）',
  },
}

const S = (): Strings => STRINGS[state.cfg.language]

const k = (n: number): string => `${Math.round(n / 1000)}k`

/** Context fill, 0-100 with one decimal; undefined before the first request. */
export function pctOf(u: Usage): number | undefined {
  if (u.tokens === undefined || !u.window) return undefined
  return Math.round((u.tokens / u.window) * 1000) / 10
}

/**
 * The engine's context reading, with the last main-step total as the fallback: a provider that
 * answers with zero usage leaves the engine unable to measure, so it reports no tokens.
 */
function contextOf(u: Usage): Usage {
  return { tokens: u.tokens ?? state.lastStepTokens, window: u.window }
}

/** Smallest context worth compacting: the percent floor, or the size that still frees minSavingK tokens. */
export function floorTokens(window: number, baseline: number | undefined, cfg: Config): number {
  return Math.max((cfg.floorPct / 100) * window, (baseline ?? DEFAULT_BASELINE) + POST_COMPACT_EXTRA + cfg.minSavingK * 1_000)
}

export type GateResult = { ok: true; pct: number } | { ok: false; reason: string; pct?: number }

export function gate(u: Usage, baseline: number | undefined, cfg: Config): GateResult {
  const pct = pctOf(u)
  if (pct === undefined || u.tokens === undefined || !u.window) {
    return { ok: false, reason: STRINGS[cfg.language].gateNoUsage }
  }
  const need = floorTokens(u.window, baseline, cfg)
  if (u.tokens < need) {
    const needPct = Math.round((need / u.window) * 1000) / 10
    return {
      ok: false,
      pct,
      reason: STRINGS[cfg.language].gateBelow(pct, k(u.tokens), needPct, k(need)),
    }
  }
  return { ok: true, pct }
}

export type NudgeLevel = 'none' | 'soft' | 'urgent'

/** Nudge from `max(start, floor)`, again only after each further step; urgent from urgentPct. */
export function nudgeLevel(pct: number, lastNudgedPct: number | undefined, floorPct: number, cfg: Config): NudgeLevel {
  const start = Math.max(cfg.nudgeStartPct, floorPct)
  if (pct < start) return 'none'
  const isUrgent = pct >= cfg.urgentPct
  if (lastNudgedPct !== undefined && pct < lastNudgedPct + cfg.nudgeStepPct) {
    // Crossing into urgent territory escalates at once.
    if (!(isUrgent && lastNudgedPct < cfg.urgentPct)) return 'none'
  }
  return isUrgent ? 'urgent' : 'soft'
}

const num = (v: unknown, d: number): number => {
  const n = Number(v)
  return v === undefined || v === '' || !Number.isFinite(n) ? d : n
}

/** Booleans default on; "false" and "0" turn them off. */
const flag = (v: unknown): boolean => v === undefined || !(v === false || v === 'false' || v === '0')

export function configFrom(options: Record<string, unknown> | undefined): Config {
  const o = options ?? {}
  const en = o.enabled
  const rs = o.releaseStopHooks
  return {
    floorPct: num(o.floorPct, DEFAULTS.floorPct),
    minSavingK: num(o.minSavingK, DEFAULTS.minSavingK),
    nudgeStartPct: num(o.nudgeStartPct, DEFAULTS.nudgeStartPct),
    nudgeStepPct: num(o.nudgeStepPct, DEFAULTS.nudgeStepPct),
    urgentPct: num(o.urgentPct, DEFAULTS.urgentPct),
    enabled: en === undefined ? true : !(en === false || en === 'false' || en === '0'),
    releaseStopHooks: rs === true || rs === 'true' || rs === '1',
    autoNodes: flag(o.autoNodes),
    turnEndCheck: flag(o.turnEndCheck),
    language: o.language === 'zh' ? 'zh' : 'en',
  }
}

// ---- Handoff ----

export type Handoff = {
  node: string
  objective: string
  standing_orders: string[]
  decisions: string[]
  artifacts: string[]
  pending: string[]
  done: string[]
  next: string
  drop?: string[]
  lessons?: string[]
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText)

export type HandoffCheck = { ok: true; h: Handoff } | { ok: false; missing: string[] }

/** `standing_orders` and `pending` may be empty arrays; every other field but `drop` and `lessons` is required. */
export function validateHandoff(x: unknown): HandoffCheck {
  const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>
  const missing: string[] = []
  for (const f of ['node', 'objective', 'next'] as const) if (!isText(o[f])) missing.push(f)
  for (const f of ['standing_orders', 'pending'] as const) if (!isTexts(o[f])) missing.push(f)
  for (const f of ['decisions', 'artifacts', 'done'] as const) {
    if (!isTexts(o[f]) || (o[f] as string[]).length === 0) missing.push(f)
  }
  for (const f of ['drop', 'lessons'] as const) if (o[f] !== undefined && !isTexts(o[f])) missing.push(f)
  if (missing.length > 0) return { ok: false, missing }
  const h: Handoff = {
    node: o.node as string,
    objective: o.objective as string,
    standing_orders: o.standing_orders as string[],
    decisions: o.decisions as string[],
    artifacts: o.artifacts as string[],
    pending: o.pending as string[],
    done: o.done as string[],
    next: o.next as string,
  }
  if (o.drop !== undefined) h.drop = o.drop as string[]
  if (o.lessons !== undefined) h.lessons = o.lessons as string[]
  return { ok: true, h }
}

const bullets = (items: readonly string[]): string => items.map(s => `- ${s}`).join('\n')

// A fence longer than any backtick run inside, so the text stays verbatim.
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(m => m.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

export function renderHandoff(h: Handoff, userMsgs: readonly string[], lang: Lang = 'en', intent?: string): string {
  const t = STRINGS[lang]
  const sec = (title: string): string => `## ${title}`
  const out = [t.hTitle(h.node), sec(t.hObjective), h.objective]
  // Skipped when the opening request is still among the recent messages.
  if (intent !== undefined && !userMsgs.includes(intent)) out.push(sec(t.hIntent), fenced(intent))
  out.push(sec(t.hStanding), h.standing_orders.length > 0 ? bullets(h.standing_orders) : t.none)
  if (h.decisions.length > 0) out.push(sec(t.hDecisions), bullets(h.decisions))
  if (h.artifacts.length > 0) out.push(sec(t.hArtifacts), bullets(h.artifacts))
  out.push(sec(t.hPending), h.pending.length > 0 ? bullets(h.pending) : t.none)
  if (h.done.length > 0) out.push(sec(t.hDone), bullets(h.done))
  out.push(sec(t.hNext), h.next)
  if (h.lessons && h.lessons.length > 0) out.push(sec(t.hLessons), bullets(h.lessons))
  if (h.drop && h.drop.length > 0) out.push(sec(t.hDropped), bullets(h.drop))
  if (userMsgs.length > 0) {
    out.push(sec(t.hRecent))
    userMsgs.forEach((m, i) => out.push(`### ${i + 1}`, fenced(m)))
  }
  return out.join('\n\n')
}

const NOT_REAL_USER = [
  '<command-',
  '<local-command',
  '<system-reminder',
  '<task-notification',
  'Caveat:',
  '[Request interrupted',
  'This session is being continued',
  // Our own continuation prompt (see continuationText).
  ...Object.values(STRINGS).map(t => t.contMarker),
]

const isRealUser = (m: { role: string; text: string }): boolean =>
  m.role === 'user' && m.text.trim() !== '' && !NOT_REAL_USER.some(p => m.text.trimStart().startsWith(p))

/** The last `n` user messages typed by the person, oldest first. */
export function realUserMessages(msgs: readonly { role: string; text: string }[], n = 5): string[] {
  const real = msgs.filter(isRealUser).map(m => m.text)
  return n > 0 ? real.slice(-n) : []
}

export const INTENT_CAP = 1_500

/** The first message the person typed, capped at INTENT_CAP: the task intent that later compactions would otherwise paraphrase away. */
export function firstUserMessage(msgs: readonly { role: string; text: string }[]): string | undefined {
  const m = msgs.find(isRealUser)
  if (m === undefined) return undefined
  return m.text.length > INTENT_CAP ? `${m.text.slice(0, INTENT_CAP)}\n[...]` : m.text
}

export const INSTRUCTIONS_CAP = 8_000

/** Compact instructions within INSTRUCTIONS_CAP: drops `done`, then the oldest user messages, then (last resort) `drop`, `lessons`, the original request, `decisions`, `artifacts`. standing_orders, pending and next are never trimmed. */
export function buildInstructions(
  h: Handoff,
  userMsgs: readonly string[],
  handoffPath: string,
  lang: Lang = 'en',
  intent?: string,
): string {
  const t = STRINGS[lang]
  const build = (hh: Handoff, msgs: readonly string[], it: string | undefined): string =>
    `${t.preamble}\n\n${renderHandoff(hh, msgs, lang, it)}\n\n${t.tail(handoffPath)}`
  let cur: Handoff = h
  let msgs = [...userMsgs]
  let it = intent
  const fits = (): boolean => build(cur, msgs, it).length <= INSTRUCTIONS_CAP
  if (!fits()) cur = { ...cur, done: [] }
  while (!fits() && msgs.length > 0) msgs = msgs.slice(1)
  if (!fits() && cur.drop) cur = { ...cur, drop: undefined }
  if (!fits() && cur.lessons) cur = { ...cur, lessons: undefined }
  if (!fits()) it = undefined
  while (!fits() && cur.decisions.length > 0) cur = { ...cur, decisions: cur.decisions.slice(0, -1) }
  while (!fits() && cur.artifacts.length > 0) cur = { ...cur, artifacts: cur.artifacts.slice(0, -1) }
  return build(cur, msgs, it)
}

export type Continuation = {
  node: string
  beforePct: number
  afterPct?: number
  handoffPath: string
  next?: string
  standing_orders: string[]
  pending: string[]
  sessionId?: string
}

export function continuationText(p: Continuation, lang: Lang = 'en'): string {
  const t = STRINGS[lang]
  const after = p.afterPct === undefined ? t.contUnknown : `${p.afterPct}%`
  const lines = [
    t.contHead(p.node, p.beforePct, after, p.handoffPath),
    t.contNext(p.next ?? t.contNextFallback),
    `${t.contStanding}\n${p.standing_orders.length > 0 ? bullets(p.standing_orders) : t.none}`,
    `${t.contPending}\n${p.pending.length > 0 ? bullets(p.pending) : t.none}`,
    t.contClosing,
  ]
  // Models do not look back on their own; the pointer has to be explicit.
  if (p.sessionId) lines.push(t.contRecall(p.sessionId))
  return lines.join('\n\n')
}

// ---- node signals ----

export type NodeKind =
  | 'push'
  | 'pr'
  | 'tag'
  | 'merge'
  | 'sent'
  | 'spec-plan'
  | 'handoff'
  | 'todos-done'
  | 'commit'
  | 'tests'
  | 'doc-written'
  | 'delegated'
  | 'agent-done'
export type NodeSignal = { kind: NodeKind; strength: 'strong' | 'weak' }

const STRONG_BASH: readonly [RegExp, NodeKind][] = [
  [/\bgit\s+push\b/, 'push'],
  [/\b(gh\s+pr|glab\s+mr)\s+(create|merge|review|comment|close)\b/, 'pr'],
  [/\bgh\s+issue\s+(comment|close)\b/, 'pr'],
  [/\bgit\s+tag\b/, 'tag'],
  [/\bgit\s+merge\b(?!-)/, 'merge'],
  // Outbound messages: the "sent a message / replied" node in the design's list.
  [/\b(gog|agent-slack|slack|outlook)\b[^|;&\n]*\s(send|reply|post)\b/, 'sent'],
]
const SPEC_PLAN_PATH = /(^|\/)(specs?|plans?)\/[^/]+\.md$/
const HANDOFF_BASENAME = /^(HANDOFF|handoff)/
const COMMIT_CMD = /\bgit\s+commit\b/
// A unit verified green is a node; it stays weak because loops rerun it.
const TESTS_CMD =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|tox|nox|vitest|jest|rspec|phpunit|ctest)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\b(?:mvn|gradlew?)\b[^|;&\n]*\btest\b|\bmake\s+(?:test|check)\b/

const asObj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined

function failed(result: unknown): boolean {
  const o = asObj(result)
  if (o === undefined) return false
  if (o.isError === true || o.is_error === true) return true
  if (o.error !== undefined && o.error !== null && o.error !== false && o.error !== '') return true
  return typeof o.exitCode === 'number' && o.exitCode !== 0
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  const o = asObj(result)
  return typeof o?.result === 'string' ? o.result : typeof o?.text === 'string' ? o.text : ''
}

/**
 * Whether a finished main-session tool call looks like a task node. Pure: callers filter subagents.
 * `input` is the call's arguments (flat on the tool.call event, or under `input`).
 */
export function detectNode(tool: string, input: unknown, result?: unknown): NodeSignal | undefined {
  if (failed(result)) return undefined
  const flat = asObj(input) ?? {}
  const inp = asObj(flat.input) ?? flat
  const strong = (kind: NodeKind): NodeSignal => ({ kind, strength: 'strong' })
  const weak = (kind: NodeKind): NodeSignal => ({ kind, strength: 'weak' })
  if (tool === 'Bash') {
    const cmd = inp.command
    if (typeof cmd !== 'string') return undefined
    for (const [re, kind] of STRONG_BASH) if (re.test(cmd)) return strong(kind)
    if (COMMIT_CMD.test(cmd)) return weak('commit')
    return TESTS_CMD.test(cmd) ? weak('tests') : undefined
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    const p = inp.file_path ?? inp.path
    if (typeof p !== 'string') return undefined
    if (SPEC_PLAN_PATH.test(p)) return strong('spec-plan')
    if (HANDOFF_BASENAME.test(p.slice(p.lastIndexOf('/') + 1))) return strong('handoff')
    // A Write that updated an existing file is an edit, not a new document.
    if (tool === 'Write' && p.endsWith('.md') && !/\b(updated|overwritten)\b/i.test(resultText(result))) return weak('doc-written')
    return undefined
  }
  if (tool === 'TodoWrite' || tool === 'TaskUpdate') {
    const items = Array.isArray(inp.todos) ? inp.todos : Array.isArray(inp.tasks) ? inp.tasks : []
    return items.length > 0 && items.every(t => asObj(t)?.status === 'completed') ? strong('todos-done') : undefined
  }
  if (tool === 'Agent' || tool === 'Task') {
    return inp.run_in_background === true || inp.run_in_background === 'true' ? weak('delegated') : weak('agent-done')
  }
  return undefined
}

// ---- compact_now tool and request queue ----

export const TOOL = 'compact_now'
export const TOOL_FULL = 'mcp__self-compact__compact_now'
// A queued request goes stale once more than this many other tool calls follow it.
export const STALE_AFTER_CALLS = 3

export type Pending = {
  h: Handoff
  instructions: string
  handoffPath: string
  sessionId: string
  requestedPct: number
  turnId?: string
  toolCallsSince: number
  nextValid: boolean
}

type State = {
  cfg: Config
  interactive: boolean
  pending?: Pending
  baseline?: number
  // Context tokens of the last main-loop request, for when the engine cannot measure.
  lastStepTokens?: number
  seq: number
  lastTool?: string
  // Main-loop turn running; the executor only runs while idle.
  busy: boolean
  compacting: boolean
  timer?: Timer
  retries: number
  // All retries failed: the next main turn end gets one last attempt.
  waitingNextTurn: boolean
  finalTry: boolean
  // One-shot lines for Claude (compaction failures), carried by the next prompt context or text tool result.
  notes: string[]
  // Latest nudge line waiting for a carrier; replaced by a newer one, dropped if a request is queued.
  nudge?: string
  lastNudgedPct?: number
  // Stop-hook release: a Stop we forced to end the turn, and whether that end failed to compact.
  forcing: boolean
  lastEndForced: boolean
  forceFailed: boolean
  // Autonomous triggers: the turn's strongest node signal, whether it was nudged, whether compact_now was tried.
  turnSignal?: NodeSignal
  nodeNudged: boolean
  compactCalled: boolean
  // Main-session tool calls in the current turn: a turn that did real work is a work-block node.
  turnToolCalls: number
  // Self-check: context pct at the last check per key (node kind or "pct"), no tool call since it, and which turn answers it.
  checkedAt: Map<string, number>
  idleSinceCheck: boolean
  awaitingCheck: boolean
  checkTurn: boolean
  checkTimer?: Timer
}

// One state per loaded module; a session start begins afresh.
export const state: State = {
  cfg: { ...DEFAULTS },
  interactive: false,
  seq: 0,
  busy: false,
  compacting: false,
  retries: 0,
  waitingNextTurn: false,
  finalTry: false,
  notes: [],
  forcing: false,
  lastEndForced: false,
  forceFailed: false,
  nodeNudged: false,
  compactCalled: false,
  turnToolCalls: 0,
  checkedAt: new Map(),
  idleSinceCheck: false,
  awaitingCheck: false,
  checkTurn: false,
}

const str = { type: 'string' }
const strs = { type: 'array', items: { type: 'string' } }

function inputSchema(t: Strings) {
  return {
    type: 'object',
    properties: {
      node: { ...str, description: t.node },
      objective: { ...str, description: t.objective },
      standing_orders: { ...strs, description: t.standing_orders },
      decisions: { ...strs, description: t.decisions },
      artifacts: { ...strs, description: t.artifacts },
      pending: { ...strs, description: t.pending },
      done: { ...strs, description: t.done },
      next: { ...str, description: t.next },
      drop: { ...strs, description: t.drop },
      lessons: { ...strs, description: t.lessons },
    },
    required: ['node', 'objective', 'standing_orders', 'decisions', 'artifacts', 'pending', 'done', 'next'],
  }
}


type Dollar = EngineInterface

type LogLine = {
  node?: string
  pct?: number
  result: string
  reason?: string
  beforePct?: number
  afterPct?: number
  durationMs?: number
  kind?: string
}

// $.fs has no append: each write is read-modify-write, so writers queue behind one another.
let logTail: Promise<void> = Promise.resolve()
const LOG_ROTATE_CHARS = 2_000_000

/** Appends one JSON line to ~/.claude/self-compact/log.jsonl; never throws. An unreadable log is left alone, never overwritten. */
function logLine($: Dollar, line: LogLine): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      const home = await dataRoot($)
      if (home === undefined) return
      const path = `${home}/log.jsonl`
      let prev = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
      if (typeof prev !== 'string') return
      const row = { ts: new Date(await $.clock.now()).toISOString(), session: await $.session.id(), ...line }
      // $.fs rejects files over 4 MiB: keep the old log aside before it gets there.
      if (prev.length > LOG_ROTATE_CHARS) {
        await $.fs.write(`${home}/log.1.jsonl`, prev)
        prev = ''
      }
      await $.fs.write(path, `${prev}${JSON.stringify(row)}\n`)
    } catch {
      // Logging is best effort.
    }
  }
  logTail = logTail.then(run, run)
  return logTail
}

/** `<home>/.claude/self-compact`; undefined when no home directory is known. */
async function dataRoot($: Dollar): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home === undefined || home === '' ? undefined : `${home.replace(/[\\/]$/, '')}/.claude/self-compact`
}

/** The session's opening request, saved on first sight: after a compaction the transcript the engine returns no longer starts with it. */
async function sessionIntent($: Dollar, path: string, msgs: readonly { role: string; text: string }[]): Promise<string | undefined> {
  try {
    if (await $.fs.exists(path)) {
      const saved = await $.fs.read(path)
      if (typeof saved === 'string' && saved !== '') return saved
    }
    const first = firstUserMessage(msgs)
    if (first !== undefined) await $.fs.write(path, first)
    return first
  } catch {
    // The original request is a nice-to-have; never block the compaction on it.
    return undefined
  }
}

async function handleCompact($: Dollar, input: Record<string, unknown>, isSub: boolean) {
  const deny = async (reason: string, tag: string, node?: string, pct?: number) => {
    await logLine($, { node, pct, result: `denied:${tag}`, reason })
    return { deny: reason }
  }
  if (isSub) return deny(S().denySubagent, 'subagent')
  if (!state.interactive) return deny(S().denyNonInteractive, 'non-interactive')
  if (!state.cfg.enabled || (await $.env.get('DISABLE_COMPACT')) === '1') {
    return deny(S().denyDisabled, 'disabled')
  }
  const v = validateHandoff(input)
  const node = typeof input.node === 'string' ? input.node : undefined
  if (!v.ok) return deny(S().denyInvalid(v.missing.join(', ')), 'invalid', node)
  if (state.lastTool === 'AskUserQuestion') {
    return deny(S().denyAskedUser, 'asked-user', node)
  }
  const usage = contextOf((await $.session.usage()).context)
  const g = gate(usage, state.baseline, state.cfg)
  if (!g.ok) return deny(g.reason, 'gate', node, g.pct)

  const root = await dataRoot($)
  if (root === undefined) return deny(S().denyNoHome, 'no-home', node, g.pct)
  const sid = await $.session.id()
  const n = state.seq + 1
  const path = `${root}/${sid}/handoff-${n}.md`
  const raw = await $.session.messages()
  const all = Array.isArray(raw) ? raw : []
  const msgs = realUserMessages(all)
  const intent = await sessionIntent($, `${root}/${sid}/intent.md`, all)
  try {
    await $.fs.write(path, renderHandoff(v.h, msgs, state.cfg.language, intent))
  } catch (err) {
    return deny(S().denyWriteFailed(String(err)), 'write-failed', node, g.pct)
  }
  state.seq = n
  state.pending = {
    h: v.h,
    instructions: buildInstructions(v.h, msgs, path, state.cfg.language, intent),
    handoffPath: path,
    sessionId: sid,
    requestedPct: g.pct,
    toolCallsSince: 0,
    nextValid: true,
  }
  state.retries = 0
  state.waitingNextTurn = false
  state.finalTry = false
  $.ui.status(S().statusQueued(v.h.node))
  await logLine($, { node: v.h.node, pct: g.pct, result: 'queued' })
  return { result: S().queued(g.pct) }
}

/** Results the model reads as plain text; other shapes cannot carry a trailing note reliably. */
function isTextResult(r: { result?: unknown; text?: string }): boolean {
  return typeof r.text === 'string' || typeof r.result === 'string'
}

// ---- executor and continuation ----

export const IDLE_DEBOUNCE_MS = 1_500
export const RETRY_MS = 2_000
export const MAX_RETRIES = 5

const ABORTED = /abort|interrupt|cancel/i

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function arm($: Dollar, ms: number): void {
  state.timer?.cancel()
  state.timer = $.clock.after(ms, () => {
    void runCompact($)
  })
}

/** Drops the queued request and clears the status line. */
async function dropPending($: Dollar, p: Pending, line: Omit<LogLine, 'node' | 'pct'>): Promise<void> {
  state.pending = undefined
  state.timer?.cancel()
  state.timer = undefined
  state.waitingNextTurn = false
  state.finalTry = false
  state.lastEndForced = false
  state.forceFailed = false
  // A nudge made before this request was queued is stale once it is gone.
  state.nudge = undefined
  $.ui.status(undefined)
  await logLine($, { node: p.h.node, pct: p.requestedPct, ...line })
}

function sendContinuation($: Dollar, p: Pending, beforePct: number, afterPct: number | undefined): void {
  const text = continuationText(
    {
    node: p.h.node,
    beforePct,
    afterPct,
    handoffPath: p.handoffPath,
    next: p.nextValid ? p.h.next : undefined,
    standing_orders: p.h.standing_orders,
    pending: p.h.pending,
    sessionId: p.sessionId,
    },
    state.cfg.language,
  )
  // Not awaited: submit resolves only once the next turn starts.
  void Promise.resolve($.prompt.submit({ text })).catch(() => {})
}

async function giveUp($: Dollar, p: Pending, reason: string): Promise<void> {
  await dropPending($, p, { result: 'failed', reason })
  $.ui.toast(S().toastFailed(reason))
  state.notes.push(S().noteFailed(reason))
}

async function runCompact($: Dollar): Promise<void> {
  state.timer = undefined
  const p = state.pending
  if (p === undefined || state.compacting || state.busy) return
  state.compacting = true
  try {
    const started = await $.clock.now()
    const ctx = contextOf((await $.session.usage()).context)
    const before = pctOf(ctx)
    // Auto-compact got there first: the request is moot, but work still resumes.
    if (ctx.tokens !== undefined && !gate(ctx, state.baseline, state.cfg).ok) {
      await dropPending($, p, { result: 'preempted', beforePct: p.requestedPct, afterPct: before })
      state.compacting = false
      sendContinuation($, p, p.requestedPct, before)
      return
    }
    $.ui.status(S().statusCompacting)
    let failure: string | undefined
    let tokensAfter: number | undefined
    try {
      const r = await $.session.compact({ instructions: p.instructions })
      if (typeof r.skip === 'string') failure = r.skip
      else tokensAfter = r.tokensAfter
    } catch (err) {
      failure = errText(err)
    }
    if (state.pending !== p) return // dropped while compacting
    // Esc during compaction surfaces as an abort/cancel: hand the next step to the user.
    if (failure !== undefined && ABORTED.test(failure)) {
      await dropPending($, p, { result: 'aborted', reason: failure })
      return
    }
    if (failure !== undefined) {
      $.ui.status(S().statusQueued(p.h.node))
      if (state.lastEndForced) state.forceFailed = true
      if (state.finalTry) await giveUp($, p, failure)
      else if (state.retries < MAX_RETRIES) {
        state.retries++
        arm($, RETRY_MS)
      } else state.waitingNextTurn = true
      return
    }
    // The usage reading can lag the compaction; the result's own count wins.
    const after =
      tokensAfter !== undefined && ctx.window
        ? pctOf({ tokens: tokensAfter, window: ctx.window })
        : pctOf((await $.session.usage()).context)
    const durationMs = (await $.clock.now()) - started
    await dropPending($, p, { result: 'done', beforePct: before, afterPct: after, durationMs })
    state.lastNudgedPct = undefined
    // The old step total is stale; the result's count stands in until the next step.
    state.lastStepTokens = tokensAfter
    state.checkedAt.clear()
    $.ui.toast(S().toastDone(String(before ?? '?'), String(after ?? '?')))
    sendContinuation($, p, before ?? p.requestedPct, after)
  } catch (err) {
    await logLine($, { node: p.h.node, pct: p.requestedPct, result: 'error', reason: errText(err) })
  } finally {
    state.compacting = false
  }
}

// ---- nudges ----

type StepUsage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

// The first request of a fresh session carries little more than the opening prompt; a resumed transcript is far longer and would inflate the baseline.
export const BASELINE_MAX_MESSAGES = 3

async function onMainStep($: Dollar, u: StepUsage, messageCount: number): Promise<void> {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  // All-zero usage (a failed or empty response) measures nothing; keep the last reading.
  if (total === 0) return
  state.lastStepTokens = total
  if (state.baseline === undefined && messageCount <= BASELINE_MAX_MESSAGES) state.baseline = total
  if (!state.interactive || !state.cfg.enabled || (await $.env.get('DISABLE_COMPACT')) === '1') return
  if (state.pending !== undefined || state.compacting) return
  const window = (await $.session.usage()).context.window
  const pct = pctOf({ tokens: total, window })
  if (pct === undefined || !window) return
  const floorPct = (floorTokens(window, state.baseline, state.cfg) / window) * 100
  const level = nudgeLevel(pct, state.lastNudgedPct, floorPct, state.cfg)
  if (level === 'none') {
    // Back under the start line: something compacted, so count afresh.
    if (pct < Math.max(state.cfg.nudgeStartPct, floorPct)) state.lastNudgedPct = undefined
    return
  }
  state.lastNudgedPct = pct
  state.nudge = level === 'urgent' ? S().nudgeUrgent(pct) : S().nudgeSoft(pct)
}

/** Lines owed to Claude, oldest first; a nudge goes stale once a compaction is queued or running. */
function takeNotes(): string[] {
  const out = state.notes.splice(0)
  const nudge = state.nudge
  state.nudge = undefined
  if (nudge !== undefined && state.pending === undefined && !state.compacting) out.push(nudge)
  return out
}

const hasNotes = (): boolean => state.notes.length > 0 || state.nudge !== undefined

/** Everything tied to one conversation. Runs at session.start and at session.end: /clear, /resume and /branch fire no session.start. */
function resetConversation(): void {
  state.pending = undefined
  state.baseline = undefined
  state.lastStepTokens = undefined
  state.seq = 0
  state.lastTool = undefined
  state.busy = false
  state.compacting = false
  state.timer?.cancel()
  state.timer = undefined
  state.notes = []
  state.nudge = undefined
  state.lastNudgedPct = undefined
  state.forcing = false
  state.lastEndForced = false
  state.forceFailed = false
  state.turnSignal = undefined
  state.nodeNudged = false
  state.compactCalled = false
  state.turnToolCalls = 0
  state.checkedAt.clear()
  state.idleSinceCheck = false
  state.awaitingCheck = false
  state.checkTurn = false
  state.checkTimer?.cancel()
  state.checkTimer = undefined
  state.retries = 0
  state.waitingNextTurn = false
  state.finalTry = false
}

// ---- autonomous triggers: node nudge, turn-end self-check, topic switch ----

// A weak node signal and a topic-switch hint need this much room above the floor.
export const NODE_MARGIN_PCT = 5
// One self-check per node kind per this much context growth.
export const CHECK_STEP_PCT = 5

/** Context state for the autonomous triggers; undefined while they must stay quiet. */
async function triggerGate($: Dollar): Promise<{ pct: number; floorPct: number } | undefined> {
  if (!state.cfg.autoNodes || !state.cfg.enabled || !state.interactive) return undefined
  if (state.pending !== undefined || state.compacting) return undefined
  if ((await $.env.get('DISABLE_COMPACT')) === '1') return undefined
  const u = contextOf((await $.session.usage()).context)
  const g = gate(u, state.baseline, state.cfg)
  if (!g.ok || !u.window) return undefined
  const floorPct = (floorTokens(u.window, state.baseline, state.cfg) / u.window) * 100
  return { pct: g.pct, floorPct }
}

/** After a main-session tool returns: record the node signal and, at most once per turn, build the nudge line. */
async function onNodeSignal($: Dollar, e: Record<string, unknown>, r: unknown): Promise<string | undefined> {
  const sig = detectNode(String(e.tool), e, r)
  if (sig === undefined || !state.cfg.autoNodes) return undefined
  const cur = state.turnSignal
  if (cur === undefined || sig.strength === 'strong' || cur.strength === 'weak') state.turnSignal = sig
  if (state.nodeNudged) return undefined
  const g = await triggerGate($)
  if (g === undefined) return undefined
  if (sig.strength === 'weak' && g.pct < g.floorPct + NODE_MARGIN_PCT) return undefined
  state.nodeNudged = true
  await logLine($, { result: 'node-nudge', kind: sig.kind, pct: g.pct })
  return S().nodeNudge(sig.kind, g.pct)
}

// A main turn with at least this many tool calls did a block of work.
export const WORK_TURN_MIN_CALLS = 2

/** Turn-end fallback: after a node, a block of work or a long uncompacted stretch, ask Claude once whether to compact. */
async function scheduleSelfCheck($: Dollar): Promise<void> {
  if (!state.cfg.turnEndCheck || state.compactCalled || state.idleSinceCheck) return
  if (state.lastTool === 'AskUserQuestion') return
  const g = await triggerGate($)
  if (g === undefined) return
  const sig = state.turnSignal
  const weakOk = g.pct >= g.floorPct + NODE_MARGIN_PCT
  const workStart = Math.max(g.floorPct, state.cfg.nudgeStartPct - NODE_MARGIN_PCT)
  let key: string
  let text: string
  if (sig !== undefined && (sig.strength === 'strong' || weakOk)) {
    key = sig.kind
    text = S().selfCheck(sig.kind, g.pct)
  } else if (state.turnToolCalls >= WORK_TURN_MIN_CALLS && g.pct >= workStart) {
    key = 'work'
    text = S().selfCheckWork(g.pct)
  } else if (g.pct >= state.cfg.nudgeStartPct) {
    key = 'pct'
    text = S().selfCheckLong(g.pct)
  } else return
  const prev = state.checkedAt.get(key)
  if (prev !== undefined && g.pct >= prev && g.pct < prev + CHECK_STEP_PCT) return
  state.checkedAt.set(key, g.pct)
  state.idleSinceCheck = true
  state.checkTimer?.cancel()
  state.checkTimer = $.clock.after(IDLE_DEBOUNCE_MS, () => {
    void fireSelfCheck($, key, text)
  })
}

async function fireSelfCheck($: Dollar, key: string, text: string): Promise<void> {
  state.checkTimer = undefined
  if (state.busy || state.pending !== undefined || state.compacting) return
  // The context may have shrunk (auto-compact) while the debounce ran.
  if ((await triggerGate($)) === undefined) return
  state.awaitingCheck = true
  const pct = pctOf(contextOf((await $.session.usage()).context))
  await logLine($, { result: 'self-check', kind: key === 'pct' ? undefined : key, pct })
  // Not awaited: submit resolves only once the next turn starts.
  void Promise.resolve($.prompt.submit({ text })).catch(() => {})
}

/** Hint for a human prompt: a new block of work starts here, compact first if the previous one is closed. */
async function topicHint($: Dollar): Promise<string | undefined> {
  const g = await triggerGate($)
  return g === undefined ? undefined : S().topicSwitch(g.pct)
}

export const register: Register = (on, options) => {
  state.cfg = configFrom(options as Record<string, unknown> | undefined)

  on('session.start', async ($, e, next) => {
    state.interactive = e.isInteractive
    resetConversation()
    await $.tool.register({
      name: TOOL,
      description: S().description(state.cfg),
      inputSchema: inputSchema(S()),
      isDeferred: false,
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const hadPending = state.pending !== undefined
    resetConversation()
    if (hadPending) $.ui.status(undefined)
    return next(e)
  })

  on('turn.start', async (_$, e, next) => {
    if (e.agentId === undefined) {
      state.lastTool = undefined
      state.busy = true
      state.turnSignal = undefined
      state.nodeNudged = false
      state.compactCalled = false
      state.turnToolCalls = 0
      state.checkTurn = state.awaitingCheck
      state.awaitingCheck = false
      state.checkTimer?.cancel()
      state.checkTimer = undefined
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    state.busy = false
    state.lastEndForced = state.forcing
    state.forcing = false
    if (!state.lastEndForced) state.forceFailed = false
    const p = state.pending
    if (p !== undefined) {
      if (e.isAborted) await dropPending($, p, { result: 'aborted' })
      else {
        if (state.waitingNextTurn) {
          state.waitingNextTurn = false
          state.finalTry = true
        }
        arm($, IDLE_DEBOUNCE_MS)
      }
    }
    if (state.checkTurn) {
      state.checkTurn = false
      if (!e.isAborted) await logLine($, { result: state.compactCalled ? 'self-check:compacted' : 'self-check:declined' })
    }
    if (!e.isAborted) {
      try {
        await scheduleSelfCheck($)
      } catch {
        // The self-check is best effort.
      }
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    const human = kind === 'composer' || kind === 'bridge'
    if (state.pending !== undefined && human) state.pending.nextValid = false
    if (human) state.awaitingCheck = false
    if (e.command !== undefined) return next(e)
    const lines = hasNotes() ? takeNotes() : []
    if (human) {
      try {
        const hint = await topicHint($)
        if (hint !== undefined) lines.push(hint)
      } catch {
        // A hint is best effort.
      }
    }
    return lines.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...lines] })
  })

  on('tool.call', async ($, e, next) => {
    const isSub = e.agentId !== undefined
    if (e.tool === TOOL_FULL) {
      if (!isSub) state.compactCalled = true
      return handleCompact($, e as unknown as Record<string, unknown>, isSub)
    }
    if (isSub) return next(e)
    state.lastTool = e.tool
    state.turnToolCalls++
    state.idleSinceCheck = false
    const p = state.pending
    if (p !== undefined) p.toolCallsSince++
    let r = await next(e)
    if (p !== undefined && state.pending === p && p.toolCallsSince > STALE_AFTER_CALLS) {
      await dropPending($, p, { result: 'stale' })
      if (r.deny === undefined) r = { ...r, context: [...(r.context ?? []), S().staleNote] }
    }
    if (r.deny === undefined) {
      try {
        const line = await onNodeSignal($, e as unknown as Record<string, unknown>, r)
        if (line !== undefined) {
          if (isTextResult(r)) r = { ...r, context: [...(r.context ?? []), line] }
          else state.notes.push(line)
        }
      } catch {
        // A node nudge is best effort; never break the call.
      }
    }
    if (r.deny === undefined && hasNotes() && isTextResult(r)) {
      const notes = takeNotes()
      if (notes.length > 0) r = { ...r, context: [...(r.context ?? []), ...notes] }
    }
    return r
  })

  // Auto-compact and /compact shrink the context too; a pre-compaction step total would reopen the gate.
  on('session.compact', async (_$, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && typeof r.skip !== 'string') {
      const after = (r as { tokensAfter?: unknown }).tokensAfter
      state.lastStepTokens = typeof after === 'number' && after > 0 ? after : undefined
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      try {
        await onMainStep($, result.usage, e.messageCount ?? 1)
      } catch {
        // A nudge is best effort; never break the turn.
      }
    }
    return result
  })

  // A blocking Stop hook (such as /goal) would keep the turn alive and the queued compaction waiting forever.
  if (state.cfg.releaseStopHooks) {
    on('classic.Stop', async (_$, e, next) => {
      const r = await next(e)
      if ((e as { agent_id?: string }).agent_id !== undefined) return r
      if (r.block === undefined || state.pending === undefined || state.forceFailed) return r
      state.forcing = true
      return { ...r, preventContinuation: true, stopReason: S().stopReason }
    })
  }
}
