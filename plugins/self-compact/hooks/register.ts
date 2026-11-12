import type { EngineInterface, Register, Timer } from 'claude-code'

export type Config = {
  floorPct: number
  maxPostRatio: number
  nudgeStartPct: number
  nudgeStepPct: number
  urgentPct: number
  enabled: boolean
  releaseStopHooks: boolean
  language: Lang
}

export const DEFAULTS: Config = {
  floorPct: 15,
  maxPostRatio: 0.55,
  nudgeStartPct: 30,
  nudgeStepPct: 5,
  urgentPct: 40,
  enabled: true,
  releaseStopHooks: true,
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
  hRecent: string
  contMarker: string
  contHead: (node: string, before: number, after: string, path: string) => string
  contUnknown: string
  contNext: (next: string) => string
  contNextFallback: string
  contStanding: string
  contPending: string
  contClosing: string
  description: string
  node: string
  objective: string
  standing_orders: string
  decisions: string
  artifacts: string
  pending: string
  done: string
  next: string
  drop: string
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
    stopReason: 'compact queued: ending this turn so it can run, then work continues automatically.',
    preamble:
      'This compaction was started by the model at a task node. Write the summary from the handoff below: ' +
      'keep "Standing orders" verbatim, never paraphrase; list every "Pending" item with how it reports back; end the summary with "Next step".',
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
    hRecent: 'Recent user messages',
    contMarker: '[self-compact] Node "',
    contHead: (node, before, after, path) => `[self-compact] Node "${node}" compacted (context ${before}% → ${after}). Handoff: ${path}`,
    contUnknown: 'unknown',
    contNext: next => `Next step: ${next}`,
    contNextFallback: 'compacted, continue with the latest user instruction',
    contStanding: "Standing orders (user's words):",
    contPending: 'Pending:',
    contClosing: 'Continue with the next step; reread the handoff for details.',
    description: `Compact your own context at a task node. The call only queues: the plugin compacts after this turn ends, then resumes you at \`next\`.

Tiers (enforced): <15% denied; 15-20% only at a phase handoff with a long next phase; >=20% any clean node. Nudged at >=30%; at >=40% compact at the next safe step.

Good nodes: unit done and verified, topic change, phase handoff, work delegated and waiting. Anti-nodes: question awaiting the user, unsent draft, new user rule not yet in standing_orders, mid retry/debug loop, unread agent result.

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
    stopReason: 'compact 已排队：先结束本轮以执行压缩，随后自动续接。',
    preamble:
      '这是模型在任务节点上主动发起的压缩，请按下面的交接单写摘要：' +
      '「常驻指令」逐字保留，不要转述；「待处理」每一项都要列出，写明各自如何回报；摘要以「下一步」收尾。',
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
    hRecent: '用户最近原话',
    contMarker: '节点「',
    contHead: (node, before, after, path) => `节点「${node}」已压缩（上下文 ${before}% → ${after}）。交接单：${path}`,
    contUnknown: '未知',
    contNext: next => `下一步：${next}`,
    contNextFallback: '已压缩，按用户最新指令继续',
    contStanding: '常驻指令（用户原话）：',
    contPending: '待处理：',
    contClosing: '先按下一步继续；需要细节回读交接单。',
    description: `在任务节点上压缩你自己的上下文。调用只排队：本轮结束后插件自动压缩，并发续接消息让你按 next 继续。

门槛（插件强制，不够会被拒）：<15% 拒绝；15-20% 只在大阶段交接压（spec→plan、plan→实现、MR 创建→review）且下一阶段明显够长；>=20% 任何干净节点可压。>=30% 未压插件会提醒；>=40% 在下一个安全步骤就压，不必等完美节点。

好节点：一个单元收尾转新需求（commit+push 已验证、合并、消息已发、ticket 已更新，无在跑 agent）；状态刚落盘；用户换话题；阶段交接；任务委派出去进入等待（pending 写明每个任务及回报方式）；用户说"等会 compact/继续/下一个"。

反节点（不要调用）：有问题在等用户回答；草稿等用户说"发"；用户刚纠正或给了新规则/授权但未写进 standing_orders；轮询、重试、调试循环中途；API 刚报错；等用户登录或处理弹窗；后台 agent 结果已到未读。

standing_orders 填用户"不要/必须"、授权、偏好的原话；pending 列每个在跑任务、待批准草稿、等外部回复的事及回报方式；next 写压缩后第一步具体动作。

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
  },
}

const S = (): Strings => STRINGS[state.cfg.language]

const k = (n: number): string => `${Math.round(n / 1000)}k`

/** Context fill, 0-100 with one decimal; undefined before the first request. */
export function pctOf(u: Usage): number | undefined {
  if (u.tokens === undefined || !u.window) return undefined
  return Math.round((u.tokens / u.window) * 1000) / 10
}

/** Smallest context worth compacting: the percent floor, or the size at which the estimated post-compact size is within maxPostRatio. */
export function floorTokens(window: number, baseline: number, cfg: Config): number {
  return Math.max((cfg.floorPct / 100) * window, (baseline + POST_COMPACT_EXTRA) / cfg.maxPostRatio)
}

export type GateResult = { ok: true; pct: number } | { ok: false; reason: string; pct?: number }

export function gate(u: Usage, baseline: number | undefined, cfg: Config): GateResult {
  const pct = pctOf(u)
  if (pct === undefined || u.tokens === undefined || !u.window) {
    return { ok: false, reason: STRINGS[cfg.language].gateNoUsage }
  }
  const need = floorTokens(u.window, baseline ?? DEFAULT_BASELINE, cfg)
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

export function configFrom(options: Record<string, unknown> | undefined): Config {
  const o = options ?? {}
  const en = o.enabled
  const rs = o.releaseStopHooks
  return {
    floorPct: num(o.floorPct, DEFAULTS.floorPct),
    maxPostRatio: num(o.maxPostRatio, DEFAULTS.maxPostRatio),
    nudgeStartPct: num(o.nudgeStartPct, DEFAULTS.nudgeStartPct),
    nudgeStepPct: num(o.nudgeStepPct, DEFAULTS.nudgeStepPct),
    urgentPct: num(o.urgentPct, DEFAULTS.urgentPct),
    enabled: en === undefined ? true : !(en === false || en === 'false' || en === '0'),
    releaseStopHooks: rs === undefined ? true : !(rs === false || rs === 'false' || rs === '0'),
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
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText)

export type HandoffCheck = { ok: true; h: Handoff } | { ok: false; missing: string[] }

/** `standing_orders` and `pending` may be empty arrays; every other field but `drop` is required. */
export function validateHandoff(x: unknown): HandoffCheck {
  const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>
  const missing: string[] = []
  for (const f of ['node', 'objective', 'next'] as const) if (!isText(o[f])) missing.push(f)
  for (const f of ['standing_orders', 'pending'] as const) if (!isTexts(o[f])) missing.push(f)
  for (const f of ['decisions', 'artifacts', 'done'] as const) {
    if (!isTexts(o[f]) || (o[f] as string[]).length === 0) missing.push(f)
  }
  if (o.drop !== undefined && !isTexts(o.drop)) missing.push('drop')
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
  return { ok: true, h }
}

const bullets = (items: readonly string[]): string => items.map(s => `- ${s}`).join('\n')

// A fence longer than any backtick run inside, so the text stays verbatim.
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(m => m.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

export function renderHandoff(h: Handoff, userMsgs: readonly string[], lang: Lang = 'en'): string {
  const t = STRINGS[lang]
  const sec = (title: string): string => `## ${title}`
  const out = [t.hTitle(h.node), sec(t.hObjective), h.objective]
  out.push(sec(t.hStanding), h.standing_orders.length > 0 ? bullets(h.standing_orders) : t.none)
  if (h.decisions.length > 0) out.push(sec(t.hDecisions), bullets(h.decisions))
  if (h.artifacts.length > 0) out.push(sec(t.hArtifacts), bullets(h.artifacts))
  out.push(sec(t.hPending), h.pending.length > 0 ? bullets(h.pending) : t.none)
  if (h.done.length > 0) out.push(sec(t.hDone), bullets(h.done))
  out.push(sec(t.hNext), h.next)
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

/** The last `n` user messages typed by the person, oldest first. */
export function realUserMessages(msgs: readonly { role: string; text: string }[], n = 5): string[] {
  const real = msgs
    .filter(m => m.role === 'user' && m.text.trim() !== '' && !NOT_REAL_USER.some(p => m.text.trimStart().startsWith(p)))
    .map(m => m.text)
  return n > 0 ? real.slice(-n) : []
}

export const INSTRUCTIONS_CAP = 8_000

/** Compact instructions within INSTRUCTIONS_CAP: drops `done`, then the oldest user messages, then (last resort) `drop`, `decisions`, `artifacts`. standing_orders, pending and next are never trimmed. */
export function buildInstructions(h: Handoff, userMsgs: readonly string[], handoffPath: string, lang: Lang = 'en'): string {
  const t = STRINGS[lang]
  const build = (hh: Handoff, msgs: readonly string[]): string =>
    `${t.preamble}\n\n${renderHandoff(hh, msgs, lang)}\n\n${t.tail(handoffPath)}`
  let cur: Handoff = h
  let msgs = [...userMsgs]
  const fits = (): boolean => build(cur, msgs).length <= INSTRUCTIONS_CAP
  if (!fits()) cur = { ...cur, done: [] }
  while (!fits() && msgs.length > 0) msgs = msgs.slice(1)
  if (!fits() && cur.drop) cur = { ...cur, drop: undefined }
  while (!fits() && cur.decisions.length > 0) cur = { ...cur, decisions: cur.decisions.slice(0, -1) }
  while (!fits() && cur.artifacts.length > 0) cur = { ...cur, artifacts: cur.artifacts.slice(0, -1) }
  return build(cur, msgs)
}

export type Continuation = {
  node: string
  beforePct: number
  afterPct?: number
  handoffPath: string
  next?: string
  standing_orders: string[]
  pending: string[]
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
  return lines.join('\n\n')
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
  const usage = (await $.session.usage()).context
  const g = gate({ tokens: usage.tokens, window: usage.window }, state.baseline, state.cfg)
  if (!g.ok) return deny(g.reason, 'gate', node, g.pct)

  const root = await dataRoot($)
  if (root === undefined) return deny(S().denyNoHome, 'no-home', node, g.pct)
  const sid = await $.session.id()
  const n = state.seq + 1
  const path = `${root}/${sid}/handoff-${n}.md`
  const raw = await $.session.messages()
  const msgs = realUserMessages(Array.isArray(raw) ? raw : [])
  try {
    await $.fs.write(path, renderHandoff(v.h, msgs, state.cfg.language))
  } catch (err) {
    return deny(S().denyWriteFailed(String(err)), 'write-failed', node, g.pct)
  }
  state.seq = n
  state.pending = {
    h: v.h,
    instructions: buildInstructions(v.h, msgs, path, state.cfg.language),
    handoffPath: path,
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
    const ctx = (await $.session.usage()).context
    const before = pctOf({ tokens: ctx.tokens, window: ctx.window })
    // Auto-compact got there first: the request is moot, but work still resumes.
    if (ctx.tokens !== undefined && !gate({ tokens: ctx.tokens, window: ctx.window }, state.baseline, state.cfg).ok) {
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
  state.retries = 0
  state.waitingNextTurn = false
  state.finalTry = false
}

export const register: Register = (on, options) => {
  state.cfg = configFrom(options as Record<string, unknown> | undefined)

  on('session.start', async ($, e, next) => {
    state.interactive = e.isInteractive
    resetConversation()
    await $.tool.register({
      name: TOOL,
      description: S().description,
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
    return next(e)
  })

  on('prompt.submit', async (_$, e, next) => {
    const kind = e.origin?.kind
    if (state.pending !== undefined && (kind === 'composer' || kind === 'bridge')) state.pending.nextValid = false
    if (e.command !== undefined || !hasNotes()) return next(e)
    const notes = takeNotes()
    return notes.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  on('tool.call', async ($, e, next) => {
    const isSub = e.agentId !== undefined
    if (e.tool === TOOL_FULL) return handleCompact($, e as unknown as Record<string, unknown>, isSub)
    if (isSub) return next(e)
    state.lastTool = e.tool
    const p = state.pending
    if (p !== undefined) p.toolCallsSince++
    let r = await next(e)
    if (p !== undefined && state.pending === p && p.toolCallsSince > STALE_AFTER_CALLS) {
      await dropPending($, p, { result: 'stale' })
      if (r.deny === undefined) r = { ...r, context: [...(r.context ?? []), S().staleNote] }
    }
    if (r.deny === undefined && hasNotes() && isTextResult(r)) {
      const notes = takeNotes()
      if (notes.length > 0) r = { ...r, context: [...(r.context ?? []), ...notes] }
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
