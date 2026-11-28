import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import {
  DEFAULTS,
  STRINGS,
  stepAwayDelay,
  ttlFromUsage,
  callsToTokens,
  learnP,
  pickP,
  parseProfile,
  saveProfile,
  deprecatedKeys,
  thresholds,
  buildInstructions,
  continuationText,
  configFrom,
  gate,
  nudgeLevel,
  detectNode,
  realUserMessages,
  firstUserMessage,
  INTENT_CAP,
  renderHandoff,
  TOOL_FULL,
  validateHandoff,
  detectChatLang,
  mergeLanguage,
  trackSkillCall,
  normalizePath,
  tierSkills,
  renderSkillSection,
} from '../hooks/register'
import type { Handoff, PEst, SkillUse } from '../hooks/register'

const TH = (p: number, window = 1_000_000, cfg = DEFAULTS) => thresholds(p, window, cfg)

test('gate: below the call-count floor denies, at it opens', () => {
  // P = 90k: C(20) = (1.05M + 20*90k) / 19 = 150k.
  const g = gate({ tokens: 140_000, window: 1_000_000 }, TH(90_000), 'en')
  expect(g.ok).toBe(false)
  if (!g.ok) expect(g.reason).toContain('15%')
  if (!g.ok) expect(g.reason).toContain('150k')
  expect(gate({ tokens: 150_000, window: 1_000_000 }, TH(90_000), 'en')).toEqual({ ok: true, pct: 15 })
})

test('gate: missing usage denies', () => {
  const g = gate({}, TH(90_000), 'en')
  expect(g.ok).toBe(false)
  expect(gate({ tokens: 130_000 }, TH(90_000), 'en').ok).toBe(false)
})

test('gate: a 200k window keeps the same floor in tokens', () => {
  const t = TH(90_000, 200_000)
  expect(gate({ tokens: 140_000, window: 200_000 }, t, 'en').ok).toBe(false)
  expect(gate({ tokens: 150_000, window: 200_000 }, t, 'en')).toEqual({ ok: true, pct: 75 })
})

test('gate: floorPct is an extra lower bound on a 1M window', () => {
  const cfg = { ...DEFAULTS, floorPct: 20 }
  const t = TH(65_000, 1_000_000, cfg)
  expect(gate({ tokens: 190_000, window: 1_000_000 }, t, 'en').ok).toBe(false)
  expect(gate({ tokens: 200_000, window: 1_000_000 }, t, 'en').ok).toBe(true)
})

test('nudgeLevel: starts at the node tier, steps by nudgeStepPct, urgent at 350k', () => {
  // P = 90k on 1M: node C(10) = 216.7k.
  const t = TH(90_000)
  const step = 50_000
  expect(nudgeLevel(216_000, undefined, t, step)).toBe('none')
  expect(nudgeLevel(217_000, undefined, t, step)).toBe('soft')
  expect(nudgeLevel(240_000, 217_000, t, step)).toBe('none')
  expect(nudgeLevel(270_000, 217_000, t, step)).toBe('soft')
  expect(nudgeLevel(350_000, undefined, t, step)).toBe('urgent')
  // Crossing into urgent escalates at once.
  expect(nudgeLevel(350_000, 340_000, t, step)).toBe('urgent')
})

test('nudgeLevel: start raised to floor', () => {
  const t = TH(65_000, 1_000_000, { ...DEFAULTS, floorPct: 30 })
  expect(nudgeLevel(299_000, undefined, t, 50_000)).toBe('none')
  expect(nudgeLevel(300_000, undefined, t, 50_000)).toBe('soft')
})

test('callsToTokens: P=87k matches the spec table', () => {
  expect(Math.round(callsToTokens(20, 87_000, 105_000) / 1000)).toBe(147)
  expect(Math.round(callsToTokens(10, 87_000, 105_000) / 1000)).toBe(213)
  expect(Math.round(callsToTokens(8, 87_000, 105_000) / 1000)).toBe(249)
})

test('thresholds: 1M window, P=87k', () => {
  const t = thresholds(87_000, 1_000_000, DEFAULTS)
  expect(t.urgent).toBe(350_000)
  expect(t.heavy).toBe(false)
  expect(t.floor < t.node && t.node < t.work && t.work < t.urgent).toBe(true)
})

test('thresholds: 200k window clamps', () => {
  const t = thresholds(87_000, 200_000, DEFAULTS)
  expect(t.urgent).toBe(160_000)
  expect(Math.max(t.floor, t.node, t.work)).toBeLessThanOrEqual(t.urgent)
  expect(t.heavy).toBe(false) // small window is not a heavy harness
})

test('thresholds: P=200k is heavy', () => {
  expect(thresholds(200_000, 1_000_000, DEFAULTS).heavy).toBe(true) // C(8)=379k >= 350k
})

test('thresholds: floorPct is an extra lower bound', () => {
  expect(thresholds(40_000, 1_000_000, { ...DEFAULTS, floorPct: 20 }).floor).toBe(200_000)
})

test('thresholds: every tier is at least P + 25k, even above urgentK', () => {
  const t = thresholds(63_000, 1_000_000, { ...DEFAULTS, urgentK: 50 })
  expect(t.urgent).toBe(88_000)
  expect(Math.min(t.floor, t.node, t.work)).toBeGreaterThanOrEqual(88_000)
})

test('thresholds: the minimum gain leaves default tiers unchanged', () => {
  const t = thresholds(87_000, 1_000_000, DEFAULTS)
  expect([t.floor, t.node, t.work, t.urgent].map(v => Math.round(v / 1000))).toEqual([147, 213, 249, 350])
})

test('configFrom: calls clamp to >= 2', () => {
  expect(configFrom({ nodeCalls: 1 }).nodeCalls).toBe(2)
  expect(configFrom({ workCalls: 'x' }).workCalls).toBe(DEFAULTS.workCalls)
})

test('deprecatedKeys: lists the old keys that were set', () => {
  expect(deprecatedKeys({ minSavingK: 40, floorPct: 15 })).toEqual(['minSavingK'])
})

const HANDOFF: Handoff = {
  node: 'plan 已落盘 → 开始实现',
  objective: '实现 self-compact',
  standing_orders: ['不要 push', '代码注释只用英文'],
  decisions: ['用 $.fs.write 落盘：mod 不能 import node:fs'],
  artifacts: ['/tmp/plan.md'],
  pending: ['后台 agent A：完成后通知'],
  done: ['写完 spec'],
  next: '实现 Task 1',
}

test('validateHandoff: missing next and objective listed', () => {
  const { next: _n, objective: _o, ...rest } = HANDOFF
  const v = validateHandoff(rest)
  expect(v.ok).toBe(false)
  if (!v.ok) {
    expect(v.missing).toContain('next')
    expect(v.missing).toContain('objective')
  }
  expect(validateHandoff({ ...HANDOFF, next: '' }).ok).toBe(false)
  expect(validateHandoff(null).ok).toBe(false)
})

test('validateHandoff: empty pending ok', () => {
  const v = validateHandoff({ ...HANDOFF, pending: [], standing_orders: [] })
  expect(v.ok).toBe(true)
  const bad = validateHandoff({ ...HANDOFF, decisions: [] })
  expect(bad.ok).toBe(false)
})

test('realUserMessages: filters reminders and notifications, keeps last 5', () => {
  const msgs = [
    ...[1, 2, 3, 4, 5, 6].map(i => ({ role: 'user', text: `real ${i}` })),
    { role: 'assistant', text: 'assistant words' },
    { role: 'user', text: '<system-reminder>x</system-reminder>' },
    { role: 'user', text: '<task-notification>done</task-notification>' },
    { role: 'user', text: '<command-name>/foo</command-name>' },
    { role: 'user', text: '<local-command-stdout>y</local-command-stdout>' },
    { role: 'user', text: 'Caveat: the messages below' },
    { role: 'user', text: '[Request interrupted by user]' },
  ]
  expect(realUserMessages(msgs)).toEqual(['real 2', 'real 3', 'real 4', 'real 5', 'real 6'])
  expect(realUserMessages(msgs, 2)).toEqual(['real 5', 'real 6'])
})

test('renderHandoff: quotes user messages verbatim', () => {
  const msg = '第一行\n第二行 `code` ```fence```\n  缩进保留'
  const md = renderHandoff(HANDOFF, [msg, '另一条'], 'zh')
  expect(md).toContain(msg)
  expect(md).toContain('另一条')
  expect(md).toContain('## 用户最近原话')
  expect(md.indexOf('不要 push')).toBeLessThan(md.indexOf('## 用户最近原话'))
})

test('instructions: truncation priority', () => {
  const h: Handoff = { ...HANDOFF, done: ['DONE_MARKER ' + 'd'.repeat(20_000)] }
  const msgs = [1, 2, 3, 4, 5, 6].map(i => `USER_${i} ` + 'u'.repeat(2_000))
  const out = buildInstructions(h, msgs, '/x/handoff-1.md')
  expect(out.length <= 8_000).toBe(true)
  for (const s of h.standing_orders) expect(out).toContain(s)
  for (const p of h.pending) expect(out).toContain(p)
  expect(out).toContain(h.next)
  expect(out).not.toContain('DONE_MARKER')
  expect(out).toContain('/x/handoff-1.md')
  // Oldest user messages go before newer ones.
  expect(out).not.toContain('USER_1 ')
})

test('instructions: short input kept whole', () => {
  const out = buildInstructions(HANDOFF, ['hi'], '/x/handoff-1.md')
  expect(out).toContain('写完 spec')
  expect(out).toContain('hi')
})

test('continuationText: no next → fallback sentence', () => {
  const t = continuationText({
    node: 'N',
    beforePct: 31,
    afterPct: 9,
    handoffPath: '/x/h.md',
    standing_orders: ['不要 push'],
    pending: ['等 MR'],
  }, 'zh')
  expect(t).toContain('已压缩，按用户最新指令继续')
  expect(t).toContain('31% → 9%')
  expect(t).toContain('/x/h.md')
  expect(t).toContain('不要 push')
  expect(t).toContain('等 MR')
  const t2 = continuationText({ node: 'N', beforePct: 31, handoffPath: '/x/h.md', next: '做 X', standing_orders: [], pending: [] }, 'zh')
  expect(t2).toContain('做 X')
  expect(t2).not.toContain('已压缩，按用户最新指令继续')
})

test('continuationText: points at the transcript only when the session id is known', () => {
  const base = { node: 'N', beforePct: 31, handoffPath: '/x/h.md', standing_orders: [], pending: [] }
  expect(continuationText({ ...base, sessionId: 'abc' })).toContain('~/.claude/projects/*/abc.jsonl')
  expect(continuationText({ ...base, sessionId: 'abc' }, 'zh')).toContain('grep transcript ~/.claude/projects/*/abc.jsonl')
  expect(continuationText(base)).not.toContain('.jsonl')
})

test('validateHandoff: lessons optional, must be strings when given', () => {
  const v = validateHandoff({ ...HANDOFF, lessons: ['retry with --force broke the lock'] })
  expect(v.ok).toBe(true)
  if (v.ok) expect(v.h.lessons).toEqual(['retry with --force broke the lock'])
  const bad = validateHandoff({ ...HANDOFF, lessons: 'one string' })
  expect(bad.ok).toBe(false)
  if (!bad.ok) expect(bad.missing).toEqual(['lessons'])
})

test('firstUserMessage: skips non-user text and caps length', () => {
  const msgs = [
    { role: 'user', text: '<system-reminder>x</system-reminder>' },
    { role: 'assistant', text: 'hi' },
    { role: 'user', text: 'build the parser' },
    { role: 'user', text: 'later message' },
  ]
  expect(firstUserMessage(msgs)).toBe('build the parser')
  expect(firstUserMessage([{ role: 'assistant', text: 'x' }])).toBeUndefined()
  const long = firstUserMessage([{ role: 'user', text: 'a'.repeat(5_000) }]) as string
  expect(long.length).toBe(INTENT_CAP + '\n[...]'.length)
})

test('renderHandoff: original request and lessons get their own sections', () => {
  const h: Handoff = { ...HANDOFF, lessons: ['LESSON_X'] }
  const md = renderHandoff(h, ['recent'], 'en', 'ORIGINAL_ASK')
  expect(md).toContain('## Original request')
  expect(md).toContain('ORIGINAL_ASK')
  expect(md).toContain('## Lessons from dead ends')
  expect(md).toContain('- LESSON_X')
  // Not repeated when it is still one of the recent messages.
  expect(renderHandoff(HANDOFF, ['ORIGINAL_ASK'], 'en', 'ORIGINAL_ASK')).not.toContain('## Original request')
})

test('instructions: preamble asks for exact copies and lists what to drop', () => {
  for (const lang of ['en', 'zh'] as const) {
    const out = buildInstructions(HANDOFF, [], '/x/h.md', lang)
    expect(out).toContain(lang === 'en' ? 'file paths with line numbers' : '带行号的文件路径')
    expect(out).toContain(lang === 'en' ? 'dead ends' : '走不通的路')
  }
})

test('instructions: original request trimmed after lessons, before decisions', () => {
  const h: Handoff = { ...HANDOFF, lessons: ['LESSON_' + 'l'.repeat(3_000)], decisions: ['DECISION_KEEP'] }
  const intent = 'INTENT_' + 'i'.repeat(1_400)
  const pad = 'p'.repeat(8_000 - buildInstructions({ ...h, lessons: undefined }, [], '/x/h.md', 'en', intent).length - 200)
  const out = buildInstructions({ ...h, objective: h.objective + pad }, [], '/x/h.md', 'en', intent)
  expect(out.length <= 8_000).toBe(true)
  expect(out).not.toContain('LESSON_')
  expect(out).toContain('INTENT_')
  expect(out).toContain('DECISION_KEEP')
})

// ---- compact_now tool and queue ----
// The module under test is loaded fresh by the harness, so its state is read through
// effects (files, status line, tool results), never through an imported binding.

const testZh = (name: string, body: TestBody) => test(name, { options: { language: 'zh' } }, body)

type On = Parameters<TestBody>[1]
type Dollar = Parameters<TestBody>[0]

const ROOT = '/home/u/.claude/self-compact'

function engine(
  on: On,
  usageArg: { tokens?: number; window?: number } = { tokens: 200_000, window: 1_000_000 },
  env: Record<string, string> = {},
) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 12) })
  const usage = { ...usageArg }
  mock.env(on, { HOME: '/home/u', ...env })
  const files = new Map<string, string>()
  // The engine resolves a POSIX fixture path against the current drive on Windows.
  const key = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  const registered: { name: string; description: string; isDeferred?: boolean }[] = []
  const statuses: (string | undefined)[] = []
  const messages = [{ role: 'user', text: '请继续做 Task 3', toolUses: [] }]
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess1' }))
  const fail = { usage: false, invalidate: false }
  const usageCalls: unknown[] = []
  const limits: { kind: string; percentUsed: number }[] = []
  on('session.usage', async (_, e) => {
    usageCalls.push(e)
    if (fail.usage) throw new Error('usage unsupported')
    return { value: { startedAt: 0, context: usage, rateLimits: limits } }
  })
  on('session.messages', () => ({ value: messages }))
  on('tool.register', (_, e) => {
    registered.push(e as never)
    return { value: { tool: TOOL_FULL } }
  })
  const describeHook: { run?: () => Promise<unknown> } = {}
  on('tool.describe', async (_, e) => {
    await describeHook.run?.()
    return { description: e.description }
  })
  const invalidated: string[] = []
  on('ui.invalidate', (_, e) => {
    if (fail.invalidate) throw new Error("invalidate unsupported")
    invalidated.push(e.event)
    return { value: undefined }
  })
  on('fs.write', (_, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
  const fsFlags = { failRead: false }
  // Paths read through $.fs.read, and symlink targets for $.fs.stat's realPath.
  const reads: string[] = []
  const links = new Map<string, string>()
  on('fs.read', (_, e) => {
    if (!key(e.path).includes('/self-compact/')) reads.push(key(e.path))
    if (fsFlags.failRead) return { deny: 'EIO' }
    return files.has(key(e.path)) ? { value: files.get(key(e.path)) as string } : { deny: 'ENOENT' }
  })
  on('fs.stat', (_, e) => {
    const p = key(e.path).replace(/\/+$/, '')
    const target = links.get(p) ?? p
    const real = e.resolve ? { realPath: target } : {}
    if (files.has(target)) return { value: { kind: 'file' as const, size: (files.get(target) as string).length, mtimeMs: 0, isLink: target !== p, ...real } }
    if ([...files.keys()].some(k => k.startsWith(`${target}/`))) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: target !== p, ...real } }
    return { deny: 'ENOENT' }
  })
  on('fs.exists', (_, e) => ({ value: files.has(key(e.path)) }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  // Scripted outcomes of session.compact, one per call; the last one repeats.
  const compactPlan: ('ok' | 'busy' | 'throw' | 'abort')[] = ['ok']
  const compactCalls: string[] = []
  const toasts: string[] = []
  const submits: { text: string; context?: readonly string[] }[] = []
  const wait = { compactMs: 0, afterTokens: 80_000, reportAfter: undefined as number | undefined }
  on('session.compact', async (_, e) => {
    compactCalls.push(e.instructions ?? '')
    const step = compactPlan.length > 1 ? (compactPlan.shift() as string) : compactPlan[0]
    if (wait.compactMs > 0) await clock.sleep(wait.compactMs)
    if (step === 'throw') throw new Error('turn running')
    if (step === 'abort') return { skip: 'compaction aborted by user' }
    if (step === 'busy') return { skip: 'busy' }
    usage.tokens = wait.afterTokens
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensAfter: wait.reportAfter }
  })
  // What each model request reports as its context size, and what the user's Stop hooks answer.
  const step = { total: 65_000, index: 0, ephemeral: {} as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } }
  const stopAnswer: { block?: string } = {}
  on('turn.step', async function* (_, e) {
    step.index++
    const usage = {
      input_tokens: 1_000,
      output_tokens: 10,
      cache_read_input_tokens: step.total - 1_000,
      cache_creation_input_tokens: 0,
      ...step.ephemeral,
      model: 'm',
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('classic.Stop', () => ({ ...stopAnswer }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    submits.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  const handoffs = () => [...files.keys()].filter(k => k.includes('/handoff-')).sort()
  const log = () =>
    (files.get(`${ROOT}/log.jsonl`) ?? '')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { result: string; session: string; node?: string; pct?: number; reason?: string; beforePct?: number; afterPct?: number; durationMs?: number })
  return { limits, describeHook, usageCalls, clock, files, registered, invalidated, statuses, handoffs, log, usage, compactPlan, compactCalls, toasts, submits, wait, step, stopAnswer, fsFlags, reads, links, messages, fail }
}

const start = ($: Dollar, isInteractive = true) =>
  $.session.start({ cwd: '/', surface: 'terminal', isInteractive } as never)

type Out = { deny?: string; result?: unknown; context?: string[] }

const call = ($: Dollar, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: TOOL_FULL, ...input, ...extra } as never) as Promise<Out>

const bash = ($: Dollar) => $.tool.call({ tool: 'Bash', command: 'ls' } as never) as Promise<Out>

testZh('tool: registered undeferred on start', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(w.registered.length).toBe(1)
  expect(w.registered[0].name).toBe('compact_now')
  expect(w.registered[0].isDeferred).toBe(false)
  expect(w.registered[0].description.length > 100).toBe(true)
})

testZh('tool: subagent call denied', async ($, on) => {
  const w = engine(on)
  await start($)
  const r = await call($, HANDOFF, { agentId: 'sub1' })
  expect(r.deny).toContain('主会话')
  expect(w.handoffs()).toEqual([])
  expect(w.log().at(-1)?.result).toBe('denied:subagent')
})

testZh('tool: non-interactive denied', async ($, on) => {
  const w = engine(on)
  await start($, false)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('非交互')
  expect(w.handoffs()).toEqual([])
})

testZh('tool: below floor denied with pct', async ($, on) => {
  const w = engine(on, { tokens: 120_000, window: 1_000_000 })
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('12%')
  expect(r.deny).toContain('15%')
  expect(w.handoffs()).toEqual([])
  expect(w.statuses).toEqual([])
  expect(w.log().at(-1)?.result).toBe('denied:gate')
})

testZh('tool: missing usage denies without throwing', async ($, on) => {
  engine(on, {})
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('不可用')
})

testZh('tool: last step total fills a missing engine reading', async ($, on) => {
  const w = engine(on, { window: 1_000_000 })
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 200_000)
  // A provider answering with zero usage leaves the engine without a context reading.
  w.usage.tokens = undefined
  const r = await call($, HANDOFF)
  expect(r.deny).toBeUndefined()
  expect(String(r.result)).toContain('已排队')
})

testZh('tool: a step with zero usage keeps the last real reading', async ($, on) => {
  const w = engine(on, { window: 1_000_000 })
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 200_000)
  // A failed or empty response can report all-zero usage; it says nothing about the context.
  await modelStep($, w, 0)
  w.usage.tokens = undefined
  const r = await call($, HANDOFF)
  expect(r.deny).toBeUndefined()
  expect(String(r.result)).toContain('已排队')
})

testZh('tool: a compaction the plugin did not run replaces the last step total', async ($, on) => {
  const w = engine(on, { window: 1_000_000 })
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 400_000)
  w.wait.reportAfter = 80_000
  // Auto-compact or /compact: the engine still has no reading of its own afterwards.
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never)
  w.usage.tokens = undefined
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('8%')
})

testZh('tool: a compaction without a reported size leaves no stale reading', async ($, on) => {
  const w = engine(on, { window: 1_000_000 })
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 400_000)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never)
  w.usage.tokens = undefined
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('不可用')
})

testZh('tool: last step total below the floor still denies', async ($, on) => {
  const w = engine(on, { window: 1_000_000 })
  await start($)
  await modelStep($, w, 65_000)
  w.usage.tokens = undefined
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('6.5')
})

testZh('tool: missing fields denied', async ($, on) => {
  const w = engine(on)
  await start($)
  const { next: _n, objective: _o, ...rest } = HANDOFF
  const r = await call($, rest)
  expect(r.deny).toContain('next')
  expect(r.deny).toContain('objective')
  expect(w.handoffs()).toEqual([])
})

testZh('tool: after AskUserQuestion denied', async ($, on) => {
  const w = engine(on)
  await start($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('提问')
  expect(w.handoffs()).toEqual([])
  // A tool call in between clears it.
  await bash($)
  expect((await call($, HANDOFF)).deny).toBeUndefined()
})

testZh('tool: disabled by DISABLE_COMPACT', async ($, on) => {
  engine(on, undefined, { DISABLE_COMPACT: '1' })
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('禁用')
})

testZh('tool: valid call queues and writes handoff', async ($, on) => {
  const w = engine(on)
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toBeUndefined()
  expect(String(r.result)).toContain('已排队')
  const path = `${ROOT}/sess1/handoff-1.md`
  expect(w.handoffs()).toEqual([path])
  expect(w.files.get(path)).toContain('不要 push')
  expect(w.files.get(path)).toContain('请继续做 Task 3')
  expect(w.statuses.at(-1)).toBe('compact 已排队 · plan 已落盘 → 开始实现')
  const last = w.log().at(-1)
  expect(last?.result).toBe('queued')
  expect(last?.session).toBe('sess1')
  expect(last?.pct).toBe(20)
})

testZh('tool: original request is saved once and survives a compacted transcript', async ($, on) => {
  const w = engine(on)
  w.messages.unshift({ role: 'user', text: '最初的需求：做一个解析器', toolUses: [] })
  w.messages.push({ role: 'user', text: 'r1', toolUses: [] }, { role: 'user', text: 'r2', toolUses: [] })
  w.messages.push({ role: 'user', text: 'r3', toolUses: [] }, { role: 'user', text: 'r4', toolUses: [] })
  w.messages.push({ role: 'user', text: 'r5', toolUses: [] })
  await start($)
  await call($, HANDOFF)
  expect(w.files.get(`${ROOT}/sess1/intent.md`)).toBe('最初的需求：做一个解析器')
  expect(w.files.get(`${ROOT}/sess1/handoff-1.md`)).toContain('## 用户最初的需求')
  // After a compaction the engine's transcript starts with the summary.
  w.messages.splice(0, w.messages.length, { role: 'user', text: '压缩后的新消息', toolUses: [] })
  await bash($)
  await call($, { ...HANDOFF, node: '第二个节点' })
  expect(w.files.get(`${ROOT}/sess1/handoff-2.md`)).toContain('最初的需求：做一个解析器')
  expect(w.files.get(`${ROOT}/sess1/intent.md`)).toBe('最初的需求：做一个解析器')
})

testZh('second call replaces queued', async ($, on) => {
  const w = engine(on)
  await start($)
  await call($, HANDOFF)
  await bash($)
  await bash($)
  await call($, { ...HANDOFF, node: '第二个节点', next: '做 Y' })
  expect(w.handoffs()).toEqual([`${ROOT}/sess1/handoff-1.md`, `${ROOT}/sess1/handoff-2.md`])
  expect(w.statuses.at(-1)).toBe('compact 已排队 · 第二个节点')
  // The counter restarted with the replacement: three more calls do not expire it.
  for (let i = 0; i < 3; i++) expect((await bash($)).context).toBeUndefined()
  expect(w.log().filter(l => l.result === 'stale').length).toBe(0)
  expect((await bash($)).context?.join(' ')).toContain('compact_now')
  expect(w.log().filter(l => l.result === 'stale').length).toBe(1)
})

testZh('stale after 4 tool calls drops request', async ($, on) => {
  const w = engine(on)
  await start($)
  await call($, HANDOFF)
  for (let i = 0; i < 3; i++) expect((await bash($)).context).toBeUndefined()
  const fourth = await bash($)
  expect(fourth.context?.join(' ')).toContain('compact_now')
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.log().at(-1)?.result).toBe('stale')
  // Dropped: further calls carry no note and log no second stale.
  expect((await bash($)).context).toBeUndefined()
  expect(w.log().filter(l => l.result === 'stale').length).toBe(1)
})

// ---- executor and continuation ----

const turnStart = ($: Dollar, turnId: string) => $.turn.start({ text: 'x', turnId } as never)
const expectEnCriteria = (t: string) => {
  expect(t).toContain('break-even line')
  expect(t).toContain('necessary, not sufficient')
  expect(t).toContain('(1)')
  expect(t).toContain('(2)')
  expect(t).toContain('(3)')
  expect(t).not.toMatch(/do not judge|already checked/)
}
const expectZhCriteria = (t: string) => {
  expect(t).toContain('回本线')
  expect(t).toContain('必要条件')
  expect(t).toContain('（1）')
  expect(t).toContain('（2）')
  expect(t).toContain('（3）')
  expect(t).not.toMatch(/不用再判断|已确认现在压缩划算/)
}
const turnComplete = ($: Dollar, turnId: string, isAborted = false, answer = '') =>
  $.turn.complete({
    answer: answer,
    durationMs: 1,
    isAborted,
    turnId,
    reason: isAborted ? 'aborted' : 'answer',
  } as never)
const userPrompt = ($: Dollar, text: string) =>
  $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)

/** A queued request at 20%, its turn complete: the executor is armed (1_500 ms debounce). */
async function queued($: Dollar, on: On, usage?: { tokens?: number; window?: number }) {
  const w = engine(on, usage)
  await start($)
  await turnStart($, 't1')
  await call($, HANDOFF)
  await turnComplete($, 't1')
  return w
}

testZh('executor: compacts after turn and submits continuation with next', async ($, on) => {
  const w = await queued($, on)
  expect(w.compactCalls.length).toBe(0)
  await w.clock.advance(1_499)
  expect(w.compactCalls.length).toBe(0)
  await w.clock.advance(1)
  expect(w.compactCalls.length).toBe(1)
  expect(w.compactCalls[0]).toContain('不要 push')
  expect(w.compactCalls[0]).toContain('handoff-1.md')
  expect(w.statuses).toContain('compacting…')
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.toasts).toEqual(['压缩 20% → 8%'])
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('下一步：实现 Task 1')
  expect(w.submits[0].text).toContain('20% → 8%')
  expect(w.submits[0].text).toContain('不要 push')
  expect(w.submits[0].text).toContain('后台 agent A：完成后通知')
  expect(w.submits[0].text).toContain('~/.claude/projects/*/sess1.jsonl')
  // Nothing left queued: a later turn end does not compact again.
  await turnStart($, 't2')
  await turnComplete($, 't2')
  await w.clock.advance(10_000)
  expect(w.compactCalls.length).toBe(1)
})

testZh('executor: not during a running turn', async ($, on) => {
  const w = await queued($, on)
  await w.clock.advance(1_000)
  await turnStart($, 't2')
  await w.clock.advance(5_000)
  expect(w.compactCalls.length).toBe(0)
  await turnComplete($, 't2')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(1)
})

testZh('executor: retries 5 times then waits for next turn', async ($, on) => {
  const w = await queued($, on)
  w.compactPlan.splice(0, 1, 'busy')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(1)
  for (let i = 2; i <= 6; i++) {
    await w.clock.advance(1_999)
    expect(w.compactCalls.length).toBe(i - 1)
    await w.clock.advance(1)
    expect(w.compactCalls.length).toBe(i)
  }
  // Initial try plus five retries; then it waits for the next main turn end.
  await w.clock.advance(60_000)
  expect(w.compactCalls.length).toBe(6)
  expect(w.toasts).toEqual([])
  w.compactPlan.splice(0, 1, 'ok')
  await turnStart($, 't2')
  await turnComplete($, 't2')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(7)
  expect(w.submits.length).toBe(1)
  expect(w.toasts).toEqual(['压缩 20% → 8%'])
})

testZh('executor: gives up and toasts', async ($, on) => {
  const w = await queued($, on)
  w.compactPlan.splice(0, 1, 'busy')
  await w.clock.advance(1_500 + 5 * 2_000)
  expect(w.compactCalls.length).toBe(6)
  await turnStart($, 't2')
  await turnComplete($, 't2')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(7)
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('压缩未执行')
  expect(w.toasts[0]).toContain('busy')
  expect(w.log().at(-1)?.result).toBe('failed')
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.submits).toEqual([])
  // Given up: no more attempts, and the reason reaches Claude on the next prompt.
  await turnStart($, 't3')
  await turnComplete($, 't3')
  await w.clock.advance(30_000)
  expect(w.compactCalls.length).toBe(7)
  await userPrompt($, '继续')
  expect(w.submits.at(-1)?.context?.join(' ')).toContain('busy')
  await userPrompt($, '再来')
  expect(w.submits.at(-1)?.context?.join(' ') ?? '').not.toContain('busy')
})

testZh('executor: a thrown compact error is retried like a skip', async ($, on) => {
  const w = await queued($, on)
  w.compactPlan.splice(0, 1, 'throw', 'ok')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(1)
  expect(w.submits).toEqual([])
  await w.clock.advance(2_000)
  expect(w.compactCalls.length).toBe(2)
  expect(w.submits.length).toBe(1)
  expect(w.log().at(-1)?.result).toBe('done')
})

testZh('auto-compact preempts', async ($, on) => {
  const w = await queued($, on)
  w.usage.tokens = 90_000 // auto-compact ran between the request and the executor
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(0)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('9%')
  expect(w.submits[0].text).toContain('下一步：实现 Task 1')
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.log().at(-1)?.result).toBe('preempted')
})

testZh('new user turn drops next', async ($, on) => {
  const w = await queued($, on)
  await userPrompt($, '换个方向：先看 CI')
  await turnStart($, 't2')
  await turnComplete($, 't2')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(1)
  expect(w.submits.length).toBe(2) // the user's own prompt, then the continuation
  const cont = w.submits[1].text
  expect(cont).not.toContain('实现 Task 1')
  expect(cont).toContain('已压缩，按用户最新指令继续')
  expect(cont).toContain('不要 push')
})

testZh('aborted turn drops request', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  await call($, HANDOFF)
  await turnComplete($, 't1', true)
  await w.clock.advance(30_000)
  expect(w.compactCalls.length).toBe(0)
  expect(w.submits).toEqual([])
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.log().at(-1)?.result).toBe('aborted')
})

testZh('log line written on done', async ($, on) => {
  const w = await queued($, on)
  w.wait.compactMs = 40_000
  await w.clock.advance(1_500)
  await w.clock.advance(40_000)
  const row = w.log().at(-1)
  expect(row?.result).toBe('done')
  expect(row?.session).toBe('sess1')
  expect(row?.node).toBe('plan 已落盘 → 开始实现')
  expect(row?.pct).toBe(20)
  expect(row?.beforePct).toBe(20)
  expect(row?.afterPct).toBe(8)
  expect(row?.durationMs).toBe(40_000)
})

// ---- nudges, stop-hook release ----

type W = ReturnType<typeof engine>

/** One main-loop model request that reports `total` context tokens (window 1M). */
async function modelStep($: Dollar, w: W, total: number, agentId?: string) {
  w.step.total = total
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, agentId } as never)
  for await (const _chunk of stream) {
    // drain
  }
  await stream.result
}

/** Stub text tool result: the context lines it carries. */
const ctxOf = async ($: Dollar) => ((await bash($)).context ?? []).join(' ')

const stop = ($: Dollar) => $.classic.Stop({ stop_hook_active: false } as never)

testZh('nudge: none below 20%', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 190_000)
  expect(await ctxOf($)).toBe('')
})

testZh('nudge: soft at 20 then every 5', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  const first = await ctxOf($)
  expect(first).toContain('30%')
  expect(first).toContain('compact_now')
  expect(first).not.toContain('下一个安全步骤')
  await modelStep($, w, 320_000)
  expect(await ctxOf($)).toBe('')
  await modelStep($, w, 350_000)
  expect(await ctxOf($)).toContain('35%')
  expect(await ctxOf($)).toBe('') // delivered once
})

testZh('nudge: urgent at 35', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 410_000)
  const note = await ctxOf($)
  expect(note).toContain('41%')
  expect(note).toContain('下一个安全步骤')
})

testZh('nudge: rides next text tool result', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  expect(w.submits).toEqual([])
  expect(await ctxOf($)).toContain('30%')
  // Taken by the tool result, so the prompt carries nothing.
  await userPrompt($, '继续')
  expect(w.submits.at(-1)?.context?.join(' ') ?? '').not.toContain('留意下一个节点')
})

testZh('nudge: falls back to the next prompt context', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  await userPrompt($, '继续')
  expect(w.submits.at(-1)?.context?.join(' ')).toContain('30%')
  expect(await ctxOf($)).toBe('')
})

testZh('nudge: silent while queued', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await call($, HANDOFF)
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toBe('')
})

testZh('nudge: silent when disabled by DISABLE_COMPACT', async ($, on) => {
  const w = engine(on, undefined, { DISABLE_COMPACT: '1' })
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toBe('') // disabled by DISABLE_COMPACT
})

testZh('nudge: silent for subagent steps', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000, 'sub1')
  expect(await ctxOf($)).toBe('')
})

testZh('nudge: silent when non-interactive', async ($, on) => {
  const w = engine(on)
  await start($, false)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toBe('')
})

testZh('nudge: counts afresh after a compaction', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toContain('30%')
  w.usage.tokens = 300_000
  await turnStart($, 't1')
  await call($, HANDOFF)
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(1)
  // The first step after a compaction is the post-compact size, not a nudge candidate.
  await modelStep($, w, 80_000)
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toContain('30%')
})

testZh('baseline: seeds P (baseline + 25k) while nothing is learned', async ($, on) => {
  // First step 120k: P = 145k, floor C(20) = 208k.
  const w = engine(on, { tokens: 200_000, window: 1_000_000 })
  await start($)
  await modelStep($, w, 120_000)
  expect((await call($, HANDOFF)).deny).toContain('208k')
  w.usage.tokens = 210_000
  expect((await call($, HANDOFF)).deny).toBeUndefined()
})

test('stop: queued compaction ends a blocked turn', { options: { language: 'zh', releaseStopHooks: true } }, async ($, on) => {
  const w = engine(on)
  await start($)
  w.stopAnswer.block = '继续完成 goal'
  // Nothing queued: another hook's block stands.
  const plain = await stop($)
  expect(plain.block).toBe('继续完成 goal')
  expect(plain.preventContinuation).toBeUndefined()
  await call($, HANDOFF)
  const forced = await stop($)
  expect(forced.preventContinuation).toBe(true)
  expect(forced.stopReason).toContain('compact')
  // Not blocked: nothing to release.
  delete w.stopAnswer.block
  expect((await stop($)).preventContinuation).toBeUndefined()
})

test('stop: no forcing loop after a failed forced end', { options: { language: 'zh', releaseStopHooks: true } }, async ($, on) => {
  const w = engine(on)
  await start($)
  w.stopAnswer.block = '继续完成 goal'
  w.compactPlan.splice(0, 1, 'busy')
  await turnStart($, 't1')
  await call($, HANDOFF)
  expect((await stop($)).preventContinuation).toBe(true)
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(1) // the forced end failed to compact
  // Still queued, but the next Stop is left alone.
  await turnStart($, 't2')
  expect((await stop($)).preventContinuation).toBeUndefined()
  // A natural turn end re-arms forcing.
  await turnComplete($, 't2')
  await turnStart($, 't3')
  expect((await stop($)).preventContinuation).toBe(true)
})

// ---- review fixes ----

const sessionEnd = ($: Dollar, reason = 'clear') =>
  $.session.end({ reason, sessionId: 'sess1', resume: { id: 'sess1' } } as never)

testZh('session.end (/clear): a queued request and its timer do not leak into the next session', async ($, on) => {
  const w = await queued($, on)
  await sessionEnd($)
  expect(w.statuses.at(-1)).toBeUndefined()
  await w.clock.advance(30_000)
  expect(w.compactCalls.length).toBe(0)
  expect(w.submits).toEqual([])
  // A turn end in the new session does not revive the old request.
  await turnStart($, 't2')
  await turnComplete($, 't2')
  await w.clock.advance(30_000)
  expect(w.compactCalls.length).toBe(0)
})

testZh('session.end (/clear): nudge counters, notes and baseline start afresh', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toContain('30%')
  await sessionEnd($)
  // Same 30% again in the new session nudges again, and a 120k first step is the new baseline (floor 208k).
  await modelStep($, w, 120_000)
  w.usage.tokens = 140_000
  expect((await call($, HANDOFF)).deny).toContain('208k')
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toContain('30%')
})

testZh('baseline: a resumed transcript (many messages) does not become the baseline', async ($, on) => {
  const w = engine(on, { tokens: 160_000, window: 1_000_000 })
  await start($)
  w.step.total = 400_000
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 80 } as never)
  for await (const _chunk of stream) {
    // drain
  }
  await stream.result
  // With the 65k default the gate opens at 160k; a 400k baseline would have kept it shut.
  expect((await call($, HANDOFF)).deny).toBeUndefined()
})

testZh('nudge: counts afresh after an auto-compact or /compact the plugin did not run', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toContain('30%')
  await modelStep($, w, 90_000) // context shrank: someone compacted
  expect(await ctxOf($)).toBe('')
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toContain('30%')
})

testZh('nudge: a stale pre-queue nudge is not delivered after the compaction', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000) // nudge waits for a carrier
  w.usage.tokens = 300_000
  await turnStart($, 't1')
  await call($, HANDOFF)
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(1)
  expect(await ctxOf($)).toBe('')
})

testZh('log: concurrent writers keep every line', async ($, on) => {
  const w = engine(on)
  await start($)
  await Promise.all([call($, HANDOFF, { agentId: 'a' }), call($, HANDOFF, { agentId: 'b' }), call($, HANDOFF, { agentId: 'c' })])
  expect(w.log().filter(l => l.result.startsWith('denied')).length).toBe(3)
})

testZh('log: an unreadable existing log is never overwritten', async ($, on) => {
  const w = engine(on)
  await start($)
  w.files.set(`${ROOT}/log.jsonl`, 'KEEP\n')
  w.fsFlags.failRead = true
  await call($, HANDOFF, { agentId: 'a' })
  expect(w.files.get(`${ROOT}/log.jsonl`)).toBe('KEEP\n')
})

testZh('files: empty HOME falls back to USERPROFILE', async ($, on) => {
  const w = engine(on, undefined, { HOME: '', USERPROFILE: '/win/u' })
  await start($)
  await call($, HANDOFF)
  expect(w.handoffs()).toEqual(['/win/u/.claude/self-compact/sess1/handoff-1.md'])
})

testZh('executor: user Esc during compaction abandons the request without a continuation', async ($, on) => {
  const w = await queued($, on)
  w.compactPlan.splice(0, 1, 'abort')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(1)
  await w.clock.advance(60_000)
  expect(w.compactCalls.length).toBe(1)
  expect(w.submits).toEqual([])
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.log().at(-1)?.result).toBe('aborted')
  await turnStart($, 't2')
  await turnComplete($, 't2')
  await w.clock.advance(10_000)
  expect(w.compactCalls.length).toBe(1)
})

test('stop: a subagent Stop is never forced', { options: { language: 'zh', releaseStopHooks: true } }, async ($, on) => {
  const w = engine(on)
  await start($)
  w.stopAnswer.block = '继续'
  await call($, HANDOFF)
  const r = await $.classic.Stop({ stop_hook_active: false, agent_id: 'sub1' } as never)
  expect(r.preventContinuation).toBeUndefined()
})

testZh('executor: after-compact size comes from the compaction result when present', async ($, on) => {
  const w = await queued($, on)
  w.wait.reportAfter = 70_000
  w.wait.afterTokens = 200_000 // the usage reading still stale
  await w.clock.advance(1_500)
  expect(w.toasts).toEqual(['压缩 20% → 7%'])
  expect(w.submits[0].text).toContain('20% → 7%')
})

test('realUserMessages: skips our continuation and the compact summary', () => {
  const msgs = [
    { role: 'user', text: '真实消息' },
    { role: 'user', text: '节点「plan」已压缩（上下文 20% → 8%）。交接单：/x' },
    { role: 'user', text: '[self-compact] Node "plan" compacted (context 20% → 8%). Handoff: /x' },
    { role: 'user', text: 'This session is being continued from a previous conversation...' },
  ]
  expect(realUserMessages(msgs)).toEqual(['真实消息'])
})

testZh('tool description (zh): short, with tiers, nodes, anti-nodes and the end-the-turn instruction', async ($, on) => {
  const w = engine(on)
  await start($)
  const d = w.registered[0].description
  expect(d.length).toBeLessThanOrEqual(680)
  for (const s of ['150k（15%）', '217k（22%）', '350k（35%）', '好节点', '反节点', '标出节点', '不要再调用']) expect(d).toContain(s)
})

test('configFrom: defaults, strings and booleans', () => {
  expect(configFrom(undefined)).toEqual(DEFAULTS)
  const c = configFrom({ floorPct: '20', urgentK: 300, nodeCalls: '', enabled: 'false' })
  expect(c.floorPct).toBe(20)
  expect(c.urgentK).toBe(300)
  expect(c.nodeCalls).toBe(DEFAULTS.nodeCalls)
  expect(c.enabled).toBe(false)
  expect(configFrom({ enabled: false }).enabled).toBe(false)
  expect(configFrom({ enabled: true }).enabled).toBe(true)
})

// ---- i18n ----

const NON_ASCII = /[^\x00-\x7F]/

test('configFrom: language accepts zh, anything else is en', () => {
  expect(configFrom(undefined).language).toBe('en')
  expect(configFrom({ language: 'zh' }).language).toBe('zh')
  expect(configFrom({ language: 'fr' }).language).toBe('en')
  expect(configFrom({ language: 5 }).language).toBe('en')
})

test('i18n: default language is English for deny, toast and continuation', async ($, on) => {
  const w = engine(on, { tokens: 120_000, window: 1_000_000 })
  await start($)
  const denied = await call($, HANDOFF)
  expect(denied.deny).toContain('12%')
  expect(NON_ASCII.test(denied.deny ?? '')).toBe(false)
  expect((await call($, HANDOFF, { agentId: 's' })).deny).toContain('main session')
  w.usage.tokens = 200_000
  await turnStart($, 't1')
  const queuedRes = await call($, HANDOFF)
  expect(String(queuedRes.result)).toContain('Queued')
  expect(String(queuedRes.result)).toContain('call no more tools')
  expect(w.statuses.at(-1)).toBe('compact queued · plan 已落盘 → 开始实现')
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.toasts).toEqual(['compacted 20% → 8%'])
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('20% → 8%')
  expect(w.submits[0].text).toContain('Next step: 实现 Task 1')
  expect(w.submits[0].text).toContain('Standing orders (user\'s words)')
  expect(w.compactCalls[0]).toContain('## Standing orders (user\'s words)')
  expect(w.files.get(`${ROOT}/sess1/handoff-1.md`)).toContain('## Next step')
})

test('i18n: zh config keeps Chinese strings', { options: { language: 'zh' } }, async ($, on) => {
  const w = engine(on, { tokens: 120_000, window: 1_000_000 })
  await start($)
  expect((await call($, HANDOFF)).deny).toContain('低于压缩门槛')
  w.usage.tokens = 200_000
  await turnStart($, 't1')
  expect(String((await call($, HANDOFF)).result)).toContain('已排队')
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.toasts).toEqual(['压缩 20% → 8%'])
  expect(w.submits[0].text).toContain('下一步：实现 Task 1')
  expect(w.registered[0].description).toContain('好节点')
})

test('i18n: unknown language falls back to English', { options: { language: 'fr' } }, async ($, on) => {
  const w = engine(on, { tokens: 120_000, window: 1_000_000 })
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('below the compaction threshold')
  expect(w.registered[0].description).toContain('Good nodes')
})

test('tool description (en): short with tiers, nodes, anti-nodes and end-the-turn', async ($, on) => {
  const w = engine(on)
  await start($)
  const d = w.registered[0].description
  expect(d.length).toBeLessThanOrEqual(800)
  for (const s of ['150k (15%)', '217k (22%)', '350k (35%)', 'Good nodes', 'Anti-nodes', 'flags nodes', 'end the turn now', 'call no more tools']) {
    expect(d).toContain(s)
  }
  expect(d.replace(/[→·]/g, '')).not.toMatch(NON_ASCII)
})
test('prompts (en): thresholds are necessary, the three criteria decide', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  expectEnCriteria(await ctxOf($))
  await modelStep($, w, 410_000)
  const urgent = await ctxOf($)
  expect(urgent).toContain('(1)')
  expect(urgent).not.toMatch(/do not judge|already checked/)
  for (const [k, f] of [
    ['selfCheck', STRINGS.en.selfCheck('push', 20)],
    ['selfCheckWork', STRINGS.en.selfCheckWork(20)],
    ['selfCheckLong', STRINGS.en.selfCheckLong(20)],
    ['topicSwitch', STRINGS.en.topicSwitch(20)],
    ['nodeNudge', STRINGS.en.nodeNudge('push', 20)],
  ] as const) {
    expectEnCriteria(f)
    if (k.startsWith('selfCheck')) expect(f).toContain('skip: <one-line reason>')
  }
  expect(STRINGS.zh.nudgeUrgent(40)).toContain('（1）')
  for (const f of [STRINGS.zh.nudgeSoft(30), STRINGS.zh.selfCheckWork(20), STRINGS.zh.selfCheckLong(20), STRINGS.zh.topicSwitch(20)]) expectZhCriteria(f)
})
test('i18n: en nudges and stale note are English', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  const soft = await ctxOf($)
  expect(soft).toContain('[self-compact] Context 30%')
  expect(soft).not.toMatch(NON_ASCII)
  await modelStep($, w, 410_000)
  expect(await ctxOf($)).toContain('next safe step')
  await call($, HANDOFF)
  for (let i = 0; i < 3; i++) await bash($)
  const stale = (await bash($)).context?.join(' ') ?? ''
  expect(stale).toContain('expired')
  expect(stale).not.toMatch(NON_ASCII)
})

test('stop: releaseStopHooks=false registers no Stop release', { options: { language: 'zh', releaseStopHooks: false } }, async ($, on) => {
  const w = engine(on)
  await start($)
  w.stopAnswer.block = '继续完成 goal'
  await call($, HANDOFF)
  const r = await stop($)
  expect(r.block).toBe('继续完成 goal')
  expect(r.preventContinuation).toBeUndefined()
})

test('configFrom: releaseStopHooks defaults off, accepts true/"true"/"1"', () => {
  expect(configFrom(undefined).releaseStopHooks).toBe(false)
  expect(configFrom({ releaseStopHooks: true }).releaseStopHooks).toBe(true)
  expect(configFrom({ releaseStopHooks: 'true' }).releaseStopHooks).toBe(true)
  expect(configFrom({ releaseStopHooks: '1' }).releaseStopHooks).toBe(true)
  expect(configFrom({ releaseStopHooks: false }).releaseStopHooks).toBe(false)
})

// ---- autonomous triggers ----

test('detectNode: strong and weak signals', () => {
  const strong = (tool: string, input: unknown, kind: string) =>
    expect(detectNode(tool, input)).toEqual({ kind, strength: 'strong' })
  const weak = (tool: string, input: unknown, kind: string, result?: unknown) =>
    expect(detectNode(tool, input, result)).toEqual({ kind, strength: 'weak' })
  strong('Bash', { command: 'git push origin main' }, 'push')
  strong('Bash', { command: 'cd x && git push -u origin feat' }, 'push')
  strong('Bash', { command: 'gh pr create --fill' }, 'pr')
  strong('Bash', { command: 'gh pr merge 12' }, 'pr')
  strong('Bash', { command: 'gh pr review 12 --comment' }, 'pr')
  strong('Bash', { command: 'gh issue comment 3 --body ok' }, 'pr')
  strong('Bash', { command: 'git tag v1.0.0' }, 'tag')
  strong('Bash', { command: 'git merge feat' }, 'merge')
  strong('Bash', { command: 'gog gmail send --to a@b --subject x' }, 'sent')
  strong('Bash', { command: 'agent-slack message send --channel general' }, 'sent')
  strong('Write', { file_path: '/g/docs/specs/2026-11-12-x-design.md' }, 'spec-plan')
  strong('Edit', { file_path: '/g/docs/superpowers/plans/p.md' }, 'spec-plan')
  strong('MultiEdit', { file_path: 'docs/spec/x.md' }, 'spec-plan')
  strong('Write', { file_path: '/g/HANDOFF.md' }, 'handoff')
  strong('Write', { file_path: '/g/notes/handoff-2.md' }, 'handoff')
  strong('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] }, 'todos-done')
  weak('Bash', { command: 'git commit -m "x"' }, 'commit')
  weak('Bash', { command: 'npm test' }, 'tests')
  weak('Bash', { command: 'cd g && go test ./...' }, 'tests')
  weak('Bash', { command: 'pytest -q' }, 'tests')
  weak('Write', { file_path: '/g/notes/readme.md' }, 'doc-written', 'File created successfully at: /g/notes/readme.md')
  weak('Agent', { run_in_background: true, prompt: 'p' }, 'delegated')
  weak('Task', { run_in_background: true }, 'delegated')
  weak('Agent', { prompt: 'p' }, 'agent-done')
  // A commit that also pushes is the stronger node.
  strong('Bash', { command: 'git commit -m x && git push' }, 'push')
  // No signal.
  expect(detectNode('Bash', { command: 'ls -la' })).toBeUndefined()
  expect(detectNode('Bash', { command: 'git status' })).toBeUndefined()
  expect(detectNode('Bash', { command: 'git merge-base a b' })).toBeUndefined()
  expect(detectNode('Bash', { command: 'gog gmail list' })).toBeUndefined()
  expect(detectNode('Bash', { command: 'npm install' })).toBeUndefined()
  expect(detectNode('Write', { file_path: '/g/src/a.ts' })).toBeUndefined()
  expect(detectNode('Write', { file_path: '/g/notes/readme.md' }, 'The file /g/notes/readme.md has been updated')).toBeUndefined()
  expect(detectNode('Edit', { file_path: '/g/notes/readme.md' })).toBeUndefined()
  expect(detectNode('TodoWrite', { todos: [{ status: 'completed' }, { status: 'in_progress' }] })).toBeUndefined()
  expect(detectNode('TodoWrite', { todos: [] })).toBeUndefined()
  expect(detectNode('Agent', { prompt: 'p' })).toEqual({ kind: 'agent-done', strength: 'weak' })
  expect(detectNode('Agent', { run_in_background: false })).toEqual({ kind: 'agent-done', strength: 'weak' })
})

test('detectNode: ignores errors and subagents', () => {
  expect(detectNode('Bash', { command: 'git push' }, { isError: true })).toBeUndefined()
  expect(detectNode('Bash', { command: 'git push' }, { error: 'rejected' })).toBeUndefined()
  expect(detectNode('Bash', { command: 'git push' }, { exitCode: 1 })).toBeUndefined()
  expect(detectNode('Bash', { command: 'git push' }, { result: 'ok' })).toEqual({ kind: 'push', strength: 'strong' })
})

testZh('detectNode: ignores subagent tool calls in the hook', async ($, on) => {
  const w = engine(on, { tokens: 190_000, window: 1_000_000 })
  await start($)
  await turnStart($, 't1')
  const r = (await $.tool.call({ tool: 'Bash', command: 'git push', agentId: 'sub1' } as never)) as Out
  expect(r.context).toBeUndefined()
  await turnComplete($, 't1')
  await w.clock.advance(5_000)
  expect(w.submits).toEqual([])
})

const gitPush = ($: Dollar) => $.tool.call({ tool: 'Bash', command: 'git push origin feat' } as never) as Promise<Out>
const gitTag = ($: Dollar) => $.tool.call({ tool: 'Bash', command: 'git tag v1' } as never) as Promise<Out>
const gitCommit = ($: Dollar) => $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never) as Promise<Out>

testZh('node nudge: rides the tool result after git push', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  const r = await gitPush($)
  const t = r.context?.join('\n') ?? ''
  expect(t).toContain('[self-compact] 刚才的 git push 像是一个节点（上下文 20%')
  expectZhCriteria(t)
  const row = w.log().find(l => l.result === 'node-nudge')
  expect(row?.kind).toBe('push')
  expect(row?.pct).toBe(20)
  // Delivered with the result, so the prompt carries nothing.
  await userPrompt($, '继续')
  expect(w.submits.at(-1)?.context?.join(' ') ?? '').not.toContain('刚才的')
})

test('node nudge: english text', async ($, on) => {
  engine(on)
  await start($)
  await turnStart($, 't1')
  const r = await gitPush($)
  const t = r.context?.join(' ') ?? ''
  expect(t).toContain('[self-compact]')
  expect(t).toContain('compact_now')
  expect(t).toContain('20%')
  expect(t).not.toMatch(NON_ASCII)
})

testZh('node nudge: once per turn', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  expect((await gitPush($)).context?.join(' ')).toContain('刚才的')
  expect((await gitTag($)).context).toBeUndefined()
  expect(w.log().filter(l => l.result === 'node-nudge').length).toBe(1)
  // A new turn may nudge again.
  await turnComplete($, 't1')
  await turnStart($, 't2')
  expect((await gitTag($)).context?.join(' ')).toContain('刚才的')
})

testZh('node nudge: silent below the gate', async ($, on) => {
  const w = engine(on, { tokens: 120_000, window: 1_000_000 })
  await start($)
  await turnStart($, 't1')
  expect((await gitPush($)).context).toBeUndefined()
  // Gate open (floor 150k) but a weak signal needs the node tier, 217k.
  w.usage.tokens = 170_000
  expect((await gitCommit($)).context).toBeUndefined()
  // A strong one does not.
  await turnComplete($, 't1')
  await turnStart($, 't2')
  expect((await gitPush($)).context?.join(' ')).toContain('17%')
  await turnComplete($, 't2')
  await turnStart($, 't3')
  w.usage.tokens = 220_000
  expect((await gitCommit($)).context?.join(' ')).toContain('git commit')
  expect(w.log().filter(l => l.result === 'node-nudge').length).toBe(2)
})

testZh('node nudge: silent while a request is queued', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  await call($, HANDOFF)
  expect((await gitPush($)).context).toBeUndefined()
  expect(w.log().some(l => l.result === 'node-nudge')).toBe(false)
})

testZh('self-check: submitted after a node turn without compact_now', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  await gitPush($)
  await turnComplete($, 't1')
  expect(w.submits).toEqual([])
  await w.clock.advance(1_499)
  expect(w.submits).toEqual([])
  await w.clock.advance(1)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('[self-compact 自检] 上一轮出现了节点信号（push），上下文 20%')
  expectZhCriteria(w.submits[0].text)
  expect(w.submits[0].text).toContain('skip: <一句理由>')
  expect(w.log().some(l => l.result === 'self-check' && l.kind === 'push')).toBe(true)
})

testZh('self-check: not after a turn that already called compact_now', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  await gitPush($)
  await call($, HANDOFF)
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.submits.length).toBe(1) // the continuation, not a self-check
  expect(w.submits[0].text).toContain('下一步：实现 Task 1')
  expect(w.log().some(l => l.result === 'self-check')).toBe(false)
})

const SKIP_CASES: [string, string, string | undefined][] = [
  ['skip: still comparing the diff line by line', 'reason', 'still comparing the diff line by line'],
  ['skip', 'bare', undefined],
  ['Skip：长文件刚读完', 'fullwidth colon', '长文件刚读完'],
  ['skip: ' + 'x'.repeat(300), 'capped', 'x'.repeat(200)],
  ['', 'empty answer', undefined],
]
for (const [answer, name, reason] of SKIP_CASES) {
  testZh(`self-check: declined log reason (${name})`, async ($, on) => {
    const w = engine(on)
    await start($)
    await turnStart($, 't1')
    await gitPush($)
    await turnComplete($, 't1')
    await w.clock.advance(1_500)
    await turnStart($, 't2')
    await turnComplete($, 't2', false, answer)
    const row = w.log().at(-1)
    expect(row?.result).toBe('self-check:declined')
    expect(row?.reason).toBe(reason)
  })
}

testZh('self-check: logs compacted and declined on the following turn', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  await gitPush($)
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  await turnStart($, 't2')
  await turnComplete($, 't2', false, 'skip: just pushed a small fix, no phase boundary')
  expect(w.log().at(-1)?.result).toBe('self-check:declined')
  expect(w.log().at(-1)?.reason).toBe('just pushed a small fix, no phase boundary')
  w.usage.tokens = 260_000
  await turnStart($, 't3')
  await gitPush($)
  await turnComplete($, 't3')
  await w.clock.advance(1_500)
  await turnStart($, 't4')
  await call($, HANDOFF)
  await turnComplete($, 't4')
  expect(w.log().some(l => l.result === 'self-check:compacted')).toBe(true)
})

testZh('self-check: long context with no node and no compaction', async ($, on) => {
  const w = engine(on, { tokens: 310_000, window: 1_000_000 })
  await start($)
  await turnStart($, 't1')
  await bash($)
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('[self-compact 自检]')
  expect(w.submits[0].text).toContain('31%')
  // Below nudgeStartPct, below the work-block start and no node: nothing.
  const before = w.submits.length
  w.usage.tokens = 150_000
  await turnStart($, 't2')
  await bash($)
  await turnComplete($, 't2')
  await w.clock.advance(5_000)
  expect(w.submits.length).toBe(before)
})

testZh('self-check: a turn ending with a question still asks (completion summaries often do)', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  await gitPush($)
  await turnComplete($, 't1', false, '要不要现在合并？')
  await w.clock.advance(1_500)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('compact_now')
})

testZh('self-check: a work turn without a node signal asks', async ($, on) => {
  // Work-block tier C(8) = 253k at P = 90k.
  const w = engine(on, { tokens: 260_000, window: 1_000_000 })
  await start($)
  await turnStart($, 't1')
  await bash($)
  await bash($)
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('上一轮做完了一整块工作')
  expect(w.submits[0].text).toContain('26%')
  // A single tool call is not a block of work.
  const before = w.submits.length
  w.usage.tokens = 190_000
  await turnStart($, 't2')
  await bash($)
  await turnComplete($, 't2')
  await w.clock.advance(5_000)
  expect(w.submits.length).toBe(before)
})

testZh('self-check: skipped after AskUserQuestion', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  await gitPush($)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await turnComplete($, 't1')
  await w.clock.advance(5_000)
  expect(w.submits).toEqual([])
})

testZh('self-check: skipped for an aborted turn and cancelled by a new turn', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  await gitPush($)
  await turnComplete($, 't1', true)
  await w.clock.advance(5_000)
  expect(w.submits).toEqual([])
  // A turn starts within the debounce: the check is cancelled.
  await turnStart($, 't2')
  await gitPush($)
  await turnComplete($, 't2')
  await w.clock.advance(1_000)
  await turnStart($, 't3')
  await w.clock.advance(5_000)
  expect(w.submits).toEqual([])
})

testZh('self-check: rate-limited per kind and growth', async ($, on) => {
  const w = engine(on)
  await start($)
  const turn = async (id: string, f: ($: Dollar) => Promise<Out>) => {
    await turnStart($, id)
    await f($)
    await turnComplete($, id)
    await w.clock.advance(1_500)
  }
  await turn('t1', gitPush)
  expect(w.submits.length).toBe(1)
  // The check turn itself: Claude declines without tools; no second check follows.
  await turnStart($, 't2')
  await turnComplete($, 't2', false, 'skip: rate-limit case')
  await w.clock.advance(5_000)
  expect(w.submits.length).toBe(1)
  // Same kind, same size: rate-limited.
  await turn('t3', gitPush)
  expect(w.submits.length).toBe(1)
  // Another kind is not.
  await turn('t4', gitTag)
  expect(w.submits.length).toBe(2)
  // Same kind after 5 points of growth.
  w.usage.tokens = 249_000
  await turn('t5', gitPush)
  expect(w.submits.length).toBe(2)
  w.usage.tokens = 250_000
  await turn('t6', gitPush)
  expect(w.submits.length).toBe(3)
  // Never twice in a row without tool activity.
  await turnStart($, 't7')
  await turnComplete($, 't7')
  await w.clock.advance(5_000)
  expect(w.submits.length).toBe(3)
})

test('self-check: disabled by turnEndCheck=false', { options: { language: 'zh', turnEndCheck: false } }, async ($, on) => {
  const w = engine(on, { tokens: 310_000, window: 1_000_000 })
  await start($)
  await turnStart($, 't1')
  const r = await gitPush($)
  expect(r.context?.join(' ')).toContain('刚才的') // the nudge still works
  await turnComplete($, 't1')
  await w.clock.advance(5_000)
  expect(w.submits).toEqual([])
})

testZh('topic switch: hint added as soon as the gate opens', async ($, on) => {
  const w = engine(on, { tokens: 140_000, window: 1_000_000 })
  await start($)
  await userPrompt($, '换个需求')
  expect(w.submits.at(-1)?.context).toBeUndefined()
  w.usage.tokens = 150_000
  await userPrompt($, '换个需求')
  const tsw = w.submits.at(-1)?.context?.join('\n') ?? ''
  expect(tsw).toContain('[self-compact] 上下文 15%')
  expectZhCriteria(tsw)
  expect(tsw).toContain('新工作块')
  // Slash commands and non-human prompts get none.
  await $.prompt.submit({ text: '/help', command: { name: 'help' }, origin: { kind: 'composer' }, wait: false } as never)
  expect(w.submits.at(-1)?.context).toBeUndefined()
  await $.prompt.submit({ text: 'bg done', origin: { kind: 'task-notification' }, wait: false } as never)
  expect(w.submits.at(-1)?.context).toBeUndefined()
})

testZh('topic switch: none while a request is queued', async ($, on) => {
  const w = engine(on)
  await start($)
  await call($, HANDOFF)
  await userPrompt($, '换个需求')
  expect(w.submits.at(-1)?.context).toBeUndefined()
})

test('autoNodes=false: no node nudge, no self-check, no topic hint', { options: { language: 'zh', autoNodes: false } }, async ($, on) => {
  const w = engine(on, { tokens: 310_000, window: 1_000_000 })
  await start($)
  await turnStart($, 't1')
  expect((await gitPush($)).context).toBeUndefined()
  await turnComplete($, 't1')
  await w.clock.advance(5_000)
  expect(w.submits).toEqual([])
  await userPrompt($, '换个需求')
  expect(w.submits.at(-1)?.context).toBeUndefined()
  expect(w.log().some(l => l.result === 'node-nudge' || l.result === 'self-check')).toBe(false)
})

testZh('continuation: always sent after a successful compaction', async ($, on) => {
  const w = await queued($, on)
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(1)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('下一步：实现 Task 1')
  expect(w.log().at(-1)?.result).toBe('done')
})

testZh('continuation: an empty next is refused', async ($, on) => {
  const w = engine(on)
  await start($)
  const r = await call($, { ...HANDOFF, next: '' })
  expect(r.deny).toContain('next')
  expect(w.handoffs()).toEqual([])
})

test('configFrom: autoNodes and turnEndCheck default on, accept booleans and strings', () => {
  expect(configFrom(undefined).autoNodes).toBe(true)
  expect(configFrom(undefined).turnEndCheck).toBe(true)
  expect(configFrom({ autoNodes: false, turnEndCheck: 'false' })).toMatchObject({ autoNodes: false, turnEndCheck: false })
  expect(configFrom({ autoNodes: '0' }).autoNodes).toBe(false)
  expect(configFrom({ autoNodes: 'true' }).autoNodes).toBe(true)
})

test('tool description: tiers come from config', { options: { floorPct: 20 } }, async ($, on) => {
  const w = engine(on)
  await start($)
  const d = w.registered[0].description
  expect(d).toContain('<200k (20%) denied')
  expect(d).toContain('200k (20%)-217k (22%)')
  expect(d).not.toContain('15%')
  expect(d.length).toBeLessThanOrEqual(800)
})

test('tool description (zh): tiers come from config', { options: { language: 'zh', floorPct: 20, urgentK: 300 } }, async ($, on) => {
  const w = engine(on)
  await start($)
  const d = w.registered[0].description
  expect(d).toContain('<200k（20%） 拒绝')
  expect(d).toContain('>=300k（30%）')
  expect(d).not.toContain('15%')
  expect(d.length).toBeLessThanOrEqual(800)
})

test('nudge text: says the gate passed and compaction does not stop the task', async ($, on) => {
  engine(on)
  await start($)
  await turnStart($, 't1')
  const r = await gitPush($)
  const t = r.context?.join('\n') ?? ''
  expectEnCriteria(t)
  expect(t).toContain('does not stop or interrupt the task')
})

testZh('nudge text (zh): says the gate passed and compaction does not stop the task', async ($, on) => {
  engine(on)
  await start($)
  await turnStart($, 't1')
  const r = await gitPush($)
  const t = r.context?.join('\n') ?? ''
  expectZhCriteria(t)
  expect(t).toContain('压缩不会打断任务')
})

test('learnP: first sample seeds, then EWMA 0.3', () => {
  const a = learnP(undefined, 80_000)
  expect(a).toEqual({ p: 80_000, n: 1 })
  expect(learnP(a, 90_000).p).toBe(83_000)
})

test('learnP: an outlier moves the estimate at 0.1', () => {
  expect(learnP({ p: 80_000, n: 5 }, 200_000).p).toBe(92_000)
})

test('learnP: three same-direction outliers reset', () => {
  let e: PEst = { p: 80_000, n: 9 }
  for (const s of [150_000, 160_000, 170_000]) e = learnP(e, s)
  expect(e.p).toBe(160_000)
  expect(e.n).toBe(3)
  expect(e.out).toBeUndefined()
})

test('learnP: a normal sample or a direction change clears the outlier run', () => {
  let e: PEst = learnP({ p: 80_000, n: 9 }, 150_000)
  e = learnP(e, 160_000)
  expect(e.out?.samples.length).toBe(2)
  expect(learnP(e, e.p).out).toBeUndefined()
  expect(learnP(e, 10_000).out).toEqual({ dir: -1, samples: [10_000] })
})

test('pickP: session sample > project n>=3 > global n>=3 > baseline+25k', () => {
  const prof = { global: { p: 70_000, n: 3 }, byProject: { '/a': { p: 90_000, n: 3 }, '/b': { p: 50_000, n: 2 } } }
  expect(pickP(prof, '/a', 99_000, 60_000)).toBe(99_000)
  expect(pickP(prof, '/a', undefined, 60_000)).toBe(90_000)
  expect(pickP(prof, '/b', undefined, 60_000)).toBe(70_000)
  expect(pickP({ byProject: {} }, '/b', undefined, undefined)).toBe(90_000)
  expect(pickP({ byProject: {} }, '/b', undefined, 60_000)).toBe(85_000)
})

test('profile: corrupt json reads as empty', () => {
  expect(parseProfile('{oops')).toEqual({ byProject: {} })
  expect(parseProfile('[1]')).toEqual({ byProject: {} })
  expect(parseProfile(undefined)).toEqual({ byProject: {} })
})

// saveProfile only touches env and fs; shim them over the engine fixture.
const mod = (w: ReturnType<typeof engine>) =>
  ({
    env: { get: async (k: string) => (k === 'HOME' ? '/home/u' : undefined) },
    fs: {
      exists: async (p: string) => w.files.has(p),
      read: async (p: string) => { if (w.fsFlags.failRead) throw new Error('EIO'); return w.files.get(p) as string },
      write: async (p: string, t: string) => void w.files.set(p, t),
    },
  }) as never

testZh('profile: merge keeps other project', async ($, on) => {
  const w = engine(on)
  w.files.set(`${ROOT}/profile.json`, JSON.stringify({ byProject: { '/other': { p: 70_000, n: 4 } } }))
  await saveProfile(mod(w), (p) => {
    p.byProject['/proj'] = learnP(p.byProject['/proj'], 80_000)
  })
  const saved = JSON.parse(w.files.get(`${ROOT}/profile.json`) as string)
  expect(saved.byProject['/other']).toEqual({ p: 70_000, n: 4 })
  expect(saved.byProject['/proj']).toEqual({ p: 80_000, n: 1 })
})

testZh('profile: unreadable file is left alone and never throws', async ($, on) => {
  const w = engine(on)
  w.files.set(`${ROOT}/profile.json`, '{keep')
  w.fsFlags.failRead = true
  await saveProfile(mod(w), (p) => {
    p.global = { p: 1, n: 1 }
  })
  w.fsFlags.failRead = false
  expect(w.files.get(`${ROOT}/profile.json`)).toBe('{keep')
})

// ---- adaptive thresholds wired in ----

const withProject = (w: W, p: number, n = 3) =>
  w.files.set(`${ROOT}/profile.json`, JSON.stringify({ byProject: { '/': { p, n } } }))

testZh('gate: P=87k denies 140k, accepts 150k', async ($, on) => {
  const w = engine(on, { tokens: 140_000, window: 1_000_000 })
  withProject(w, 87_000)
  await start($)
  const denied = await call($, HANDOFF)
  expect(denied.deny).toContain('147k')
  w.usage.tokens = 150_000
  expect(String((await call($, HANDOFF)).result)).toContain('已排队')
})

testZh('self-check: work turn below C(8) is quiet, above fires', async ($, on) => {
  const w = engine(on, { tokens: 200_000, window: 1_000_000 })
  withProject(w, 87_000)
  await start($)
  await turnStart($, 't1')
  await bash($)
  await bash($)
  await turnComplete($, 't1')
  await w.clock.advance(5_000)
  expect(w.submits.length).toBe(0)
  w.usage.tokens = 255_000
  await turnStart($, 't2')
  await bash($)
  await bash($)
  await turnComplete($, 't2')
  await w.clock.advance(1_500)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('上一轮做完了一整块工作')
})

testZh('self-check: weak node needs C(10), strong needs floor', async ($, on) => {
  const w = engine(on, { tokens: 200_000, window: 1_000_000 })
  withProject(w, 87_000)
  await start($)
  const turn = async (id: string, f: ($: Dollar) => Promise<Out>) => {
    await turnStart($, id)
    await f($)
    await turnComplete($, id)
    await w.clock.advance(1_500)
  }
  await turn('t1', gitCommit)
  expect(w.submits.length).toBe(0)
  await turn('t2', gitPush)
  expect(w.submits.length).toBe(1)
  await turnStart($, 't3')
  await turnComplete($, 't3', false, '不压')
  w.usage.tokens = 215_000
  await turn('t4', gitCommit)
  expect(w.submits.length).toBe(2)
})

testZh('nudge: starts at C(10), urgent at 350k', async ($, on) => {
  const w = engine(on)
  withProject(w, 87_000)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 212_000)
  expect(await ctxOf($)).toBe('')
  await modelStep($, w, 214_000)
  expect(await ctxOf($)).toContain('compact_now')
  await modelStep($, w, 350_000)
  expect(await ctxOf($)).toContain('下一个安全步骤')
})

test('nudgeLevel: absolute tiers and step', () => {
  const t = thresholds(87_000, 1_000_000, DEFAULTS)
  expect(nudgeLevel(212_000, undefined, t, 50_000)).toBe('none')
  expect(nudgeLevel(214_000, undefined, t, 50_000)).toBe('soft')
  expect(nudgeLevel(250_000, 214_000, t, 50_000)).toBe('none')
  expect(nudgeLevel(350_000, 214_000, t, 50_000)).toBe('urgent')
})

testZh('pSample: first main step after compaction is logged and learned', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  expect(w.log().some(l => l.result === 'p-sample')).toBe(false)
  await $.session.compact({ instructions: "x", messages: [{ role: 'user', text: 's', toolUses: [] }] } as never)
  await modelStep($, w, 80_000)
  const row = w.log().find(l => l.result === 'p-sample') as { pSample?: number; p?: number } | undefined
  expect(row?.pSample).toBe(80_000)
  expect(row?.p).toBe(80_000)
  const saved = JSON.parse(w.files.get(`${ROOT}/profile.json`) as string)
  expect(saved.global).toEqual({ p: 80_000, n: 1 })
  expect(saved.byProject['/']).toEqual({ p: 80_000, n: 1 })
  // Learned once: later steps add nothing, and the tool description is invalidated once.
  await modelStep($, w, 90_000)
  expect(w.log().filter(l => l.result === 'p-sample').length).toBe(1)
  expect(w.invalidated).toEqual(['tool.describe'])
})

testZh('pSample: zero-usage and subagent steps ignored', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await $.session.compact({ instructions: "x", messages: [{ role: 'user', text: 's', toolUses: [] }] } as never)
  await modelStep($, w, 70_000, 'sub1')
  await modelStep($, w, 0)
  expect(w.log().some(l => l.result === 'p-sample')).toBe(false)
  await modelStep($, w, 82_000)
  expect(w.log().filter(l => l.result === 'p-sample').length).toBe(1)
})

testZh('heavy harness note fires once', async ($, on) => {
  const w = engine(on)
  withProject(w, 200_000)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 100_000)
  const first = await ctxOf($)
  expect(first).toContain('压缩后上下文仍有 200k')
  await modelStep($, w, 110_000)
  expect(await ctxOf($)).toBe('')
})

test('tool description: shows absolute tiers for the current P', async ($, on) => {
  const w = engine(on)
  withProject(w, 87_000)
  await start($)
  const d = w.registered[0].description
  expect(d).toContain('147k (15%)')
  expect(d).toContain('213k (21%)')
  expect(d).toContain('350k (35%)')
})

test('tool description: urgent caps at the auto-compact limit, percent of the model window', async ($, on) => {
  const w = engine(on, { window: 1_000_000, breakdown: { maxTokens: 200_000 } } as never)
  withProject(w, 87_000)
  await start($)
  await modelStep($, w, 65_000)
  expect((await describeTool($)).description).toContain('160k (16%)')
})

test('queue: percent matches the status line when autoCompactWindow is below the model window', async ($, on) => {
  const w = await queued($, on, { tokens: 257_000, window: 1_000_000, breakdown: { maxTokens: 500_000 } } as never)
  expect(w.log().find(l => l.result === 'queued')).toMatchObject({ pct: 25.7 })
})

test('configFrom: deprecated keys logged once at start', { options: { minSavingK: 40, urgentPct: 30 } }, async ($, on) => {
  const w = engine(on)
  await start($)
  const rows = w.log().filter(l => l.result === 'deprecated')
  expect(rows.length).toBe(1)
  expect(rows[0].reason).toContain("minSavingK")
})

test('configFrom: urgentK and compactCostK are clamped positive', () => {
  expect(configFrom({ urgentK: -5, compactCostK: 0 }).urgentK).toBe(50)
  expect(configFrom({ urgentK: -5, compactCostK: 0 }).compactCostK).toBe(1)
  expect(configFrom({ urgentK: 300 }).urgentK).toBe(300)
})

test('parseProfile: entries with non-finite p or n read as absent', () => {
  const text = '{"global":{"p":null,"n":3},"byProject":{"/a":{"p":"x","n":1},"/b":{"p":90000,"n":3},"/c":{"p":8e4}}}'
  expect(parseProfile(text)).toEqual({ byProject: { '/b': { p: 90_000, n: 3 } } })
})

test('parseProfile: a __proto__ project key does not touch the prototype', () => {
  const p = parseProfile('{"byProject":{"__proto__":{"p":90000,"n":3},"/b":{"p":80000,"n":3}}}')
  expect(Object.getPrototypeOf(p.byProject)).toBe(Object.prototype)
  expect((p.byProject as { p?: number }).p).toBeUndefined()
  expect(p.byProject['/b']).toEqual({ p: 80_000, n: 3 })
})

test('session.start: a throwing usage read still registers compact_now and calls next', async ($, on) => {
  const w = engine(on)
  w.fail.usage = true
  const r = (await start($)) as { cwd?: string }
  expect(w.registered.length).toBe(1)
  expect(r.cwd).toBe('/')
})


const describeTool = ($: Dollar) =>
  $.tool.describe({ tool: TOOL_FULL, description: 'engine text', provider: { plugin: 'self-compact', tier: 'user' } } as never) as Promise<{ description: string; breakPromptCache?: boolean }>

test('tool.describe: answers with tiers for the current P and does not break the prompt cache', async ($, on) => {
  const w = engine(on)
  withProject(w, 87_000)
  await start($)
  expect((await describeTool($)).description).toContain('147k (15%)')
  await modelStep($, w, 65_000)
  await $.session.compact({ instructions: 'x', messages: [{ role: 'user', text: 's', toolUses: [] }] } as never)
  await modelStep($, w, 60_000)
  const r = await describeTool($)
  expect(r.description).toContain('leaves ~60k')
  expect(r.description).not.toContain('147k (15%)')
  expect(r.breakPromptCache).toBeUndefined()
  expect(w.log().filter(l => l.result === 'tool-describe').map(l => (l as { p?: number }).p)).toEqual([87_000, 60_000])
  expect(w.registered.length).toBe(1)
})

test('tool.describe: other tools pass through untouched', async ($, on) => {
  const w = engine(on)
  await start($)
  const r = (await $.tool.describe({ tool: 'Bash', description: 'engine text', provider: { plugin: 'engine', tier: 'core' } } as never)) as { description: string }
  expect(r.description).toBe('engine text')
})

test('learnSample: invalidates the cached tool description', async ($, on) => {
  const w = engine(on)
  const { invalidated } = w
  await start($)
  await modelStep($, w, 65_000)
  expect(invalidated).toEqual([])
  await $.session.compact({ instructions: 'x', messages: [{ role: 'user', text: 's', toolUses: [] }] } as never)
  await modelStep($, w, 80_000)
  expect(invalidated).toEqual(['tool.describe'])
})

// Sample 80k with urgentK 50: every tier is raised to P + 25k = 105k, and c(8) = (10*cost + 8*80k)/7 >= 50k, so the harness note is due.
// A nudge cannot fire on the sample step itself (tiers >= P + 25k > sample), so the note is the same-step output observed.
test('learnSample: a throwing ui.invalidate does not stop the rest of the step', { options: { urgentK: 50 } }, async ($, on) => {
  const w = engine(on)
  w.fail.invalidate = true
  await start($)
  await modelStep($, w, 65_000)
  await $.session.compact({ instructions: 'x', messages: [{ role: 'user', text: 's', toolUses: [] }] } as never)
  await modelStep($, w, 80_000)
  expect(w.log().some(l => l.result === 'p-sample')).toBe(true)
  expect(w.invalidated).toEqual([])
  expect(await ctxOf($)).toMatch(/is still \d+k/)
})

test('tool.describe: never reads usage, so a breakdown cannot re-enter it', async ($, on) => {
  const w = engine(on)
  await start($)
  const before = w.usageCalls.length
  await describeTool($)
  expect(w.usageCalls.length).toBe(before)
})

test('tool.describe: re-entrant describe passes through unchanged', async ($, on) => {
  const w = engine(on)
  await start($)
  // Rendering schemas inside describe fires describe again; stop after one nested call.
  let depth = 0
  w.describeHook.run = async () => {
    if (depth++ < 3) await describeTool($)
  }
  const r = await describeTool($)
  expect(r.description).toContain('compact')
  expect(w.log().filter(l => l.result === 'tool-describe').length).toBe(1)
})

test('tool.describe: uses the window the last step read', async ($, on) => {
  const w = engine(on, { tokens: 20_000, window: 100_000 })
  await start($)
  const ref = (await describeTool($)).description
  await modelStep($, w, 20_000)
  const small = (await describeTool($)).description
  expect(small).not.toBe(ref)
  expect(small).toContain('%')
})

// ---- language rules ----

const LANG = { chat: 'Chinese, English terms/identifiers OK', outputs: ['code/commit/PR: English', 'personal spec: Chinese'] }
const LANG_ZH = { chat: '中文，可夹英文术语', outputs: ['代码/commit/PR：英文', 'personal spec：中文'] }

test('detectChatLang: zh, en and empty', () => {
  expect(detectChatLang(['请继续做 Task 3', '好的，先看测试'])).toBe('zh')
  expect(detectChatLang(['please continue with task 3'])).toBe('en')
  expect(detectChatLang([])).toBeUndefined()
  // 3 CJK of 10 non-space chars is exactly the 0.3 boundary.
  expect(detectChatLang(['abcdefg 中中中'])).toBe('zh')
  expect(detectChatLang(['abcdefgh 中中'])).toBe('en')
})

test('detectChatLang: plugin-injected prompts are ignored', () => {
  const injected = [
    '[self-compact] Node "x" compacted (context 20% → 8%). Handoff: /x',
    '节点「x」已压缩（上下文 20% → 8%）。交接单：/x',
    '对话：中文｜代码：英文\n\n节点「x」已压缩（上下文 20% → 8%）。交接单：/x',
    'Chat: Chinese | code: English\n\n[self-compact] Node "x" compacted (context 20% → 8%). Handoff: /x',
    '[self-compact self-check] The last turn showed a node signal',
    '[self-compact 自检] 上一轮出现了节点信号',
    '[self-compact] 上下文 30%，已过回本线',
  ]
  expect(detectChatLang([...injected, 'plain english message'])).toBe('en')
  expect(detectChatLang(injected)).toBeUndefined()
})

test('detectChatLang: only the last 5 real messages count', () => {
  const longZh = '这是一条很长的中文消息'.repeat(10)
  expect(detectChatLang([longZh, ...Array.from({ length: 5 }, () => 'ok')])).toBe('en')
  expect(detectChatLang([longZh, ...Array.from({ length: 4 }, () => 'ok')])).toBe('zh')
  expect(detectChatLang([...Array.from({ length: 2 }, () => 'english words here'), ...Array.from({ length: 5 }, () => '这是一条中文消息')])).toBe('zh')
})

test('mergeLanguage: given beats prev, per sub-field', () => {
  const prev = { chat: 'English', outputs: ['code: English'] }
  expect(mergeLanguage(prev, LANG, 'en', 'en')).toEqual({ ...LANG, source: 'tool' })
  // A partial given inherits the rest from prev.
  expect(mergeLanguage(prev, { chat: '', outputs: ['spec: Chinese'] }, 'en', 'en')).toEqual({
    chat: 'English',
    outputs: ['spec: Chinese'],
    source: 'inherited',
  })
  expect(mergeLanguage(prev, { chat: 'Chinese', outputs: [] }, 'en', 'en')).toEqual({
    chat: 'Chinese',
    outputs: ['code: English'],
    source: 'tool',
  })
})

test('mergeLanguage: prev, then detected in the current language, then none', () => {
  const prev = { chat: 'English', outputs: ['code: English'] }
  expect(mergeLanguage(prev, undefined, 'zh', 'en')).toEqual({ ...prev, source: 'inherited' })
  expect(mergeLanguage(undefined, undefined, 'zh', 'en')).toEqual({ chat: 'Chinese', outputs: [], source: 'detected' })
  expect(mergeLanguage(undefined, undefined, 'zh', 'zh')).toEqual({ chat: '中文', outputs: [], source: 'detected' })
  expect(mergeLanguage(undefined, undefined, 'en', 'zh')).toEqual({ chat: '英文', outputs: [], source: 'detected' })
  expect(mergeLanguage(undefined, { chat: '', outputs: ['code: English'] }, 'en', 'en')).toEqual({
    chat: 'English',
    outputs: ['code: English'],
    source: 'detected',
  })
  expect(mergeLanguage(undefined, undefined, undefined, 'en')).toEqual({ chat: '', outputs: [], source: 'none' })
})

test('validateHandoff: language is optional and malformed language is dropped', () => {
  const ok = validateHandoff({ ...HANDOFF, language: LANG })
  expect(ok.ok && ok.h.language).toEqual(LANG)
  const none = validateHandoff(HANDOFF)
  expect(none.ok && none.h.language).toBeUndefined()
  for (const bad of ['zh', 42, null, { chat: 5, outputs: [] }, { chat: 'x', outputs: 'y' }, { chat: 'x', outputs: [1] }, { outputs: ['a'] }]) {
    const v = validateHandoff({ ...HANDOFF, language: bad })
    expect(v.ok).toBe(true)
    expect(v.ok && v.h.language).toBeUndefined()
  }
})

test('renderHandoff: Language rules is the first section', () => {
  const en = renderHandoff({ ...HANDOFF, language: LANG }, [], 'en')
  expect(en.indexOf('## Language rules')).toBeGreaterThan(0)
  expect(en.indexOf('## Language rules')).toBeLessThan(en.indexOf('## Objective'))
  expect(en).toContain('code/commit/PR: English')
  expect(en).toContain(LANG.chat)
  const zh = renderHandoff({ ...HANDOFF, language: LANG_ZH }, [], 'zh')
  expect(zh.indexOf('## 语言约定')).toBeLessThan(zh.indexOf('## 目标'))
  expect(zh).toContain('personal spec：中文')
  expect(renderHandoff(HANDOFF, [], 'en')).not.toContain('Language rules')
})

test('instructions: summary language line is present and survives heavy trimming', () => {
  const h: Handoff = { ...HANDOFF, language: LANG, done: ['d'.repeat(20_000)], decisions: ['x'.repeat(9_000)], artifacts: ['y'.repeat(9_000)] }
  const msgs = [1, 2, 3].map(i => `USER_${i} ` + 'u'.repeat(3_000))
  const out = buildInstructions(h, msgs, '/x/handoff-1.md', 'en', 'I'.repeat(1_400))
  expect(out).toContain(`write the summary in ${LANG.chat}`)
  expect(out).toContain("first section is 'Language rules'")
  for (const r of LANG.outputs) expect(out).toContain(r)
  const zh = buildInstructions({ ...h, language: LANG_ZH }, msgs, '/x/handoff-1.md', 'zh')
  expect(zh).toContain(`用「${LANG_ZH.chat}」写摘要`)
  expect(zh).toContain('第一节是「语言约定」')
  expect(buildInstructions(HANDOFF, [], '/x/h.md', 'en')).not.toContain('Language rules')
})

test('continuationText: the language line comes first', () => {
  const base = { node: 'N', beforePct: 31, handoffPath: '/x/h.md', next: 'go', standing_orders: [], pending: [] }
  const en = continuationText({ ...base, language: LANG }, 'en')
  expect(en.split('\n')[0]).toBe('Chat: Chinese, English terms/identifiers OK | code/commit/PR: English | personal spec: Chinese')
  expect(en.indexOf('Next step')).toBeGreaterThan(0)
  const zh = continuationText({ ...base, language: LANG_ZH }, 'zh')
  expect(zh.split('\n')[0]).toBe('对话：中文，可夹英文术语｜代码/commit/PR：英文｜personal spec：中文')
  expect(continuationText(base, 'en').startsWith('[self-compact] Node')).toBe(true)
})

test('realUserMessages: the resume message with a language line is not a user message', () => {
  const resume = continuationText({ node: 'N', beforePct: 1, handoffPath: '/x', standing_orders: [], pending: [], language: LANG }, 'en')
  expect(realUserMessages([{ role: 'user', text: resume }, { role: 'user', text: 'hello' }])).toEqual(['hello'])
  expect(realUserMessages([{ role: 'user', text: '[self-compact self-check] x' }])).toEqual([])
})

const langHandoff = (language: unknown = LANG) => ({ ...HANDOFF, language })

async function compacted($: Dollar, on: On, language: unknown = LANG, usage?: { tokens?: number; window?: number }) {
  const w = engine(on, usage)
  await start($)
  await turnStart($, 't1')
  await call($, langHandoff(language))
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  return w
}

test('compact_now: schema requires language and describes it in both languages', async ($, on) => {
  const w = engine(on)
  await start($)
  const schema = (w.registered[0] as unknown as { inputSchema: { required: string[]; properties: Record<string, { description: string; properties?: object }> } }).inputSchema
  expect(schema.required).toContain('language')
  expect(schema.properties.language.description).toBe(STRINGS.en.language)
  expect(Object.keys(schema.properties.language.properties ?? {})).toEqual(['chat', 'outputs'])
  expect(STRINGS.zh.language).not.toBe(STRINGS.en.language)
})

test('compact_now: a missing language never blocks and falls back to the detected language', async ($, on) => {
  const w = engine(on)
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toBeUndefined()
  expect(w.log().at(-1)).toMatchObject({ result: 'queued', langSource: 'detected' })
  const file = w.files.get(`${ROOT}/sess1/handoff-1.md`) ?? ''
  expect(file).toContain('## Language rules')
  expect(file).toContain('Chat: Chinese')
})

test('compact_now: no messages and no language logs langSource none and omits the section', async ($, on) => {
  const w = engine(on)
  w.messages.length = 0
  await start($)
  await call($, HANDOFF)
  expect(w.log().at(-1)).toMatchObject({ result: 'queued', langSource: 'none' })
  expect(w.files.get(`${ROOT}/sess1/handoff-1.md`) ?? '').not.toContain('Language rules')
})

test('language: handoff file, instructions and resume line carry the rules', async ($, on) => {
  const w = await compacted($, on)
  expect(w.log().find(l => l.result === 'queued')).toMatchObject({ langSource: 'tool' })
  expect(w.log().find(l => l.result === 'done')).toMatchObject({ langSource: 'tool' })
  const file = w.files.get(`${ROOT}/sess1/handoff-1.md`) ?? ''
  expect(file.indexOf('## Language rules')).toBeLessThan(file.indexOf('## Objective'))
  expect(w.compactCalls[0]).toContain(`write the summary in ${LANG.chat}`)
  expect(w.compactCalls[0]).toContain('personal spec: Chinese')
  expect(w.submits[0].text.split('\n')[0]).toBe('Chat: Chinese, English terms/identifiers OK | code/commit/PR: English | personal spec: Chinese')
})

test('language: the resume line is Chinese under language=zh', { options: { language: 'zh' } }, async ($, on) => {
  const w = await compacted($, on, LANG_ZH)
  expect(w.submits[0].text.split('\n')[0]).toBe('对话：中文，可夹英文术语｜代码/commit/PR：英文｜personal spec：中文')
  expect(w.compactCalls[0]).toContain(`用「${LANG_ZH.chat}」写摘要`)
})

test('language: the first 3 real turns after a compaction get the rule line, the 4th and injected prompts do not', async ($, on) => {
  const w = await compacted($, on)
  const line = (): string => (w.submits.at(-1)?.context ?? []).join('\n')
  // The resume message and a background notification are not turns.
  await $.prompt.submit({ text: 'bg done', origin: { kind: 'task-notification' }, wait: false } as never)
  expect(line()).not.toContain('code/commit/PR: English')
  await $.prompt.submit({ text: '[self-compact self-check] x', origin: { kind: 'plugin', name: 'self-compact' }, wait: false } as never)
  expect(line()).not.toContain('code/commit/PR: English')
  await $.prompt.submit({ text: '/help', command: { name: 'help' }, origin: { kind: 'composer' }, wait: false } as never)
  expect(line()).not.toContain('code/commit/PR: English')
  for (let i = 1; i <= 3; i++) {
    await userPrompt($, `message ${i}`)
    expect(line()).toContain('code/commit/PR: English')
    expect(w.submits.at(-1)?.text).toBe(`message ${i}`)
  }
  await userPrompt($, 'message 4')
  expect(w.submits.at(-1)?.context ?? []).toEqual([])
})

test('language: no rule line before any compaction', async ($, on) => {
  const w = engine(on, { tokens: 50_000, window: 1_000_000 })
  await start($)
  await userPrompt($, 'hello')
  expect(w.submits.at(-1)?.context).toBeUndefined()
})

test('language: a second compaction without language inherits the first rules', async ($, on) => {
  const w = await compacted($, on)
  w.usage.tokens = 200_000
  await turnStart($, 't2')
  await call($, HANDOFF)
  await turnComplete($, 't2')
  await w.clock.advance(1_500)
  const queuedLines = w.log().filter(l => l.result === 'queued')
  expect(queuedLines.map(l => (l as { langSource?: string }).langSource)).toEqual(['tool', 'inherited'])
  expect(w.compactCalls[1]).toContain('personal spec: Chinese')
  expect(w.submits[1].text.split('\n')[0]).toContain('code/commit/PR: English')
  // A partial update changes only that sub-field.
  w.usage.tokens = 200_000
  await turnStart($, 't3')
  await call($, langHandoff({ chat: '', outputs: ['code: Rust'] }))
  await turnComplete($, 't3')
  await w.clock.advance(1_500)
  expect(w.submits[2].text.split('\n')[0]).toBe('Chat: Chinese, English terms/identifiers OK | code: Rust')
})

test('language: rules do not leak into a new conversation', async ($, on) => {
  const w = await compacted($, on)
  await $.session.end({ sessionId: 'sess1' } as never)
  await start($)
  await userPrompt($, 'hello')
  expect(w.submits.at(-1)?.context).toBeUndefined()
  w.usage.tokens = 200_000
  await call($, HANDOFF)
  expect(w.log().filter(l => l.result === 'queued').map(l => (l as { langSource?: string }).langSource)).toEqual(['tool', 'detected'])
})

test('language: lang-drift is logged once when the first reply after compaction mismatches', async ($, on) => {
  const w = await compacted($, on, LANG_ZH)
  const drifts = () => w.log().filter(l => l.result === 'lang-drift')
  await turnStart($, 't2')
  // Tool-only turn: no text yet, keep waiting.
  await turnComplete($, 't2', false, '')
  expect(drifts().length).toBe(0)
  await turnStart($, 't3')
  await turnComplete($, 't3', false, 'Continuing with the next step now.')
  expect(drifts().length).toBe(1)
  await turnStart($, 't4')
  await turnComplete($, 't4', false, 'Another English reply.')
  expect(drifts().length).toBe(1)
})

test('language: no lang-drift when the first reply matches the chat language', async ($, on) => {
  const w = await compacted($, on, LANG_ZH)
  await turnStart($, 't2')
  await turnComplete($, 't2', false, '好的，继续做下一步。')
  await turnStart($, 't3')
  await turnComplete($, 't3', false, 'English later.')
  expect(w.log().filter(l => l.result === 'lang-drift').length).toBe(0)
})

test('language: an English chat with an English reply is no drift; a Chinese reply is', async ($, on) => {
  const w = await compacted($, on, { chat: 'English', outputs: [] })
  await turnStart($, 't2')
  await turnComplete($, 't2', false, '好的，继续做下一步。')
  expect(w.log().filter(l => l.result === 'lang-drift').length).toBe(1)
})

// ---- skill working set (S2) ----

const SKS = '/home/u/.claude/skills'
const ALL_ROOTS = () => true
const track = (m: Map<string, SkillUse>, tool: string, input: unknown, n: number) => trackSkillCall(m, tool, input, n, ALL_ROOTS)
const mkSkill = (name: string, lastUse: number, refs: string[] = []): SkillUse => ({ name, short: name.slice(name.lastIndexOf(':') + 1), lastUse, refs })

test('trackSkillCall: a Skill call records the name and request; the short name is the part after the last colon', () => {
  const m = new Map<string, SkillUse>()
  track(m, 'Skill', { skill: 'plug:voice' }, 7)
  expect(m.get('plug:voice')).toEqual({ name: 'plug:voice', short: 'voice', lastUse: 7, refs: [] })
  track(m, 'Skill', { skill: 'plug:voice' }, 12)
  expect(m.get('plug:voice')?.lastUse).toBe(12)
  track(m, 'Skill', { input: { skill: 'plain' } }, 13)
  expect(m.get('plain')?.short).toBe('plain')
  track(m, 'Skill', { skill: '  ' }, 14)
  expect(m.size).toBe(2)
})

test('trackSkillCall: a Read under /skills/<short>/ adds a ref and counts as use; SKILL.md is use, not a ref', () => {
  const m = new Map<string, SkillUse>()
  track(m, 'Skill', { skill: 'plug:voice' }, 1)
  track(m, 'Read', { file_path: `${SKS}/voice/references/voice.md` }, 5)
  expect(m.get('plug:voice')).toMatchObject({ lastUse: 5, refs: [`${SKS}/voice/references/voice.md`] })
  track(m, 'Read', { file_path: `${SKS}/voice/SKILL.md` }, 9)
  expect(m.get('plug:voice')).toMatchObject({ lastUse: 9, refs: [`${SKS}/voice/references/voice.md`] })
  // Edit/Write/Grep/Glob paths count too; another skill's dir does not.
  track(m, 'Edit', { file_path: `${SKS}/voice/scripts/run.py` }, 10)
  track(m, 'Write', { file_path: `${SKS}/other/x.md` }, 11)
  expect(m.get('plug:voice')?.lastUse).toBe(10)
  expect(m.get('plug:voice')?.refs[0]).toBe(`${SKS}/voice/scripts/run.py`)
  track(m, 'Grep', { pattern: 'x', path: `${SKS}/voice/references/g.md` }, 12)
  expect(m.get('plug:voice')?.refs[0]).toBe(`${SKS}/voice/references/g.md`)
  track(m, 'Glob', { pattern: `${SKS}/voice/references/*.md` }, 13)
  expect(m.get('plug:voice')).toMatchObject({ lastUse: 13 })
  expect(m.get('plug:voice')?.refs.some(r => r.includes('*'))).toBe(false)
})

test('trackSkillCall: a skill that was never loaded is not tracked from a path alone', () => {
  const m = new Map<string, SkillUse>()
  track(m, 'Read', { file_path: `${SKS}/voice/references/voice.md` }, 5)
  expect(m.size).toBe(0)
})

test('trackSkillCall: path-like tokens in a Bash command are detected', () => {
  const m = new Map<string, SkillUse>()
  track(m, 'Skill', { skill: 'voice' }, 1)
  track(m, 'Bash', { command: `cat "${SKS}/voice/references/a.md" | head -5 && ls ${SKS}/voice/` }, 6)
  expect(m.get('voice')).toMatchObject({ lastUse: 6, refs: [`${SKS}/voice/references/a.md`] })
  track(m, 'Bash', { command: 'echo /skills/voice-extra/x.md' }, 8)
  expect(m.get('voice')?.lastUse).toBe(6)
})

test('trackSkillCall: refs keep at most 8, newest first, deduplicated', () => {
  const m = new Map<string, SkillUse>()
  track(m, 'Skill', { skill: 'voice' }, 1)
  for (let i = 1; i <= 10; i++) track(m, 'Read', { file_path: `${SKS}/voice/r${i}.md` }, 1 + i)
  const refs = m.get('voice')?.refs ?? []
  expect(refs.length).toBe(8)
  expect(refs[0]).toBe(`${SKS}/voice/r10.md`)
  expect(refs.at(-1)).toBe(`${SKS}/voice/r3.md`)
  track(m, 'Read', { file_path: `${SKS}/voice/r5.md` }, 20)
  expect(m.get('voice')?.refs.slice(0, 2)).toEqual([`${SKS}/voice/r5.md`, `${SKS}/voice/r10.md`])
  expect(m.get('voice')?.refs.length).toBe(8)
})

test('trackSkillCall: a path is normalized first; one that escapes or leaves the skill dir is not a ref', () => {
  const m = new Map<string, SkillUse>()
  track(m, 'Skill', { skill: 'foo' }, 1)
  track(m, 'Read', { file_path: '/x/skills/foo/../../etc/passwd' }, 2)
  track(m, 'Read', { file_path: '/../skills/foo/r.md' }, 3)
  track(m, 'Bash', { command: 'cat /x/skills/foo/../../../etc/passwd' }, 4)
  expect(m.get('foo')).toMatchObject({ lastUse: 1, refs: [] })
  track(m, 'Read', { file_path: '/x//skills/./foo/references/../a.md' }, 5)
  expect(m.get('foo')).toMatchObject({ lastUse: 5, refs: ['/x/skills/foo/a.md'] })
  track(m, 'Read', { file_path: '/x/skills/foo/../../skills/foo/b.md' }, 6)
  expect(m.get('foo')?.refs).toEqual(['/x/skills/foo/b.md', '/x/skills/foo/a.md'])
})

test('normalizePath: collapses ., .. and //, resolves ~ and relative paths, refuses escapes', () => {
  expect(normalizePath('/a/./b//c/../d.md')).toBe('/a/b/d.md')
  expect(normalizePath('/a/skills/foo/.')).toBe('/a/skills/foo/')
  expect(normalizePath('/a/../..')).toBeUndefined()
  expect(normalizePath('~/s/x.md', { home: '/home/u' })).toBe('/home/u/s/x.md')
  expect(normalizePath('~/s/x.md')).toBeUndefined()
  expect(normalizePath('s/x.md', { cwd: '/w/p' })).toBe('/w/p/s/x.md')
  expect(normalizePath('../s/x.md', { cwd: '/w/p' })).toBe('/w/s/x.md')
  expect(normalizePath('C:\\u\\s\\..\\x.md')).toBe('C:/u/x.md')
})

test('trackSkillCall: only a dir confirmed to hold SKILL.md counts; an unknown one is deferred, a refused one ignored', () => {
  const m = new Map<string, SkillUse>()
  track(m, 'Skill', { skill: 'review' }, 1)
  const p = '/x/skills/review/'
  expect(trackSkillCall(m, 'Read', { file_path: `${p}a.md` }, 2, () => false)).toEqual([])
  expect(m.get('review')).toMatchObject({ lastUse: 1, refs: [] })
  const d = trackSkillCall(m, 'Read', { file_path: `${p}a.md` }, 3, () => undefined)
  expect(d.map(x => x.prefix)).toEqual([p])
  expect(m.get('review')).toMatchObject({ lastUse: 1, refs: [] })
  d[0].apply()
  expect(m.get('review')).toMatchObject({ lastUse: 3, refs: [`${p}a.md`] })
  expect(trackSkillCall(m, 'Read', { file_path: `${p}b.md` }, 4, () => true)).toEqual([])
  expect(m.get('review')?.refs).toEqual([`${p}b.md`, `${p}a.md`])
})

test('trackSkillCall: two skills sharing a short name: the plugin segment decides, else the latest loaded', () => {
  const m = new Map<string, SkillUse>()
  track(m, 'Skill', { skill: 'a:foo' }, 1)
  track(m, 'Skill', { skill: 'b:foo' }, 2)
  track(m, 'Read', { file_path: '/cache/a/1.0/skills/foo/r1.md' }, 3)
  track(m, 'Read', { file_path: '/cache/b/1.0/skills/foo/r2.md' }, 4)
  expect(m.get('a:foo')?.refs).toEqual(['/cache/a/1.0/skills/foo/r1.md'])
  expect(m.get('b:foo')?.refs).toEqual(['/cache/b/1.0/skills/foo/r2.md'])
  track(m, 'Read', { file_path: '/home/u/skills/foo/r3.md' }, 5)
  expect(m.get('b:foo')?.refs[0]).toBe('/home/u/skills/foo/r3.md')
  expect(m.get('a:foo')?.refs).toEqual(['/cache/a/1.0/skills/foo/r1.md'])
  track(m, 'Skill', { skill: 'a:foo' }, 6)
  track(m, 'Read', { file_path: '/home/u/skills/foo/r4.md' }, 7)
  expect(m.get('a:foo')?.refs[0]).toBe('/home/u/skills/foo/r4.md')
})

test('trackSkillCall: Bash tokens lose trailing punctuation and :line:col suffixes; relative and ~ paths resolve', () => {
  const m = new Map<string, SkillUse>()
  track(m, 'Skill', { skill: 'voice' }, 1)
  track(m, 'Bash', { command: `see ${SKS}/voice/a.md:12:3, and ${SKS}/voice/b.md. also ${SKS}/voice/c.md:7` }, 2)
  expect(m.get('voice')?.refs).toEqual([`${SKS}/voice/c.md`, `${SKS}/voice/b.md`, `${SKS}/voice/a.md`])
  trackSkillCall(m, 'Read', { file_path: '~/.claude/skills/voice/h.md' }, 3, ALL_ROOTS, { home: '/home/u' })
  trackSkillCall(m, 'Read', { file_path: 'skills/voice/rel.md' }, 4, ALL_ROOTS, { cwd: '/home/u/.claude' })
  expect(m.get('voice')?.refs.slice(0, 2)).toEqual([`${SKS}/voice/rel.md`, `${SKS}/voice/h.md`])
})

test('trackSkillCall: a Bash token ending in `/..` is not trimmed into a use of the skill dir', () => {
  const m = new Map<string, SkillUse>()
  track(m, 'Skill', { skill: 'voice' }, 1)
  track(m, 'Bash', { command: `ls ${SKS}/voice/..` }, 9)
  expect(m.get('voice')?.lastUse).toBe(1)
})

test('instructions: the hot-skill line names at most 8 skills and counts the rest', () => {
  const names = Array.from({ length: 11 }, (_, i) => `s${i}`)
  const out = buildInstructions(HANDOFF, [], '/h.md', 'en', undefined, names)
  expect(out).toContain('s7')
  expect(out).not.toContain('s8')
  expect(out).toContain('+3 more')
  expect(buildInstructions(HANDOFF, [], '/h.md', 'en', undefined, names.slice(0, 8))).not.toContain('more')
  expect(buildInstructions(HANDOFF, [], '/h.md', 'zh', undefined, names)).toContain(STRINGS.zh.skillMore(3))
})

test('tierSkills: used within hotWindow is hot, older is nothing', () => {
  const t = tierSkills([mkSkill('a', 80), mkSkill('b', 79), mkSkill('c', 10)], [], [], 100, 20, {})
  expect(t.hot.map(s => s.name)).toEqual(['a'])
  expect(t.done).toEqual([])
})

test('tierSkills: keep_skills makes a skill hot whatever its age, by name or short name', () => {
  const t = tierSkills([mkSkill('plug:old', 1), mkSkill('c', 1)], ['old'], [], 100, 20, {})
  expect(t.hot.map(s => s.name)).toEqual(['plug:old'])
  expect(tierSkills([mkSkill('plug:old', 1)], ['plug:old'], [], 100, 20, {}).hot.length).toBe(1)
})

test('tierSkills: drop_skills is done, keep beats drop, and drop beats recent use', () => {
  const t = tierSkills([mkSkill('a', 99), mkSkill('b', 99), mkSkill('c', 1)], ['b'], ['a', 'b', 'c'], 100, 20, {})
  expect(t.hot.map(s => s.name)).toEqual(['b'])
  expect(t.done.map(s => s.name)).toEqual(['a', 'c'])
})

test('tierSkills: a prior miss rate of 0.3 over at least 3 compactions makes a skill hot', () => {
  const sk = [mkSkill('a', 1)]
  const pri = (compactions: number, refMisses: number) => ({ a: { compactions, refMisses } })
  expect(tierSkills(sk, [], [], 100, 20, pri(3, 1)).hot.length).toBe(1)
  expect(tierSkills(sk, [], [], 100, 20, pri(10, 3)).hot.length).toBe(1)
  expect(tierSkills(sk, [], [], 100, 20, pri(3, 0)).hot.length).toBe(0)
  expect(tierSkills(sk, [], [], 100, 20, pri(10, 2)).hot.length).toBe(0)
  // n gate: a perfect miss rate over fewer than 3 compactions is not enough.
  expect(tierSkills(sk, [], [], 100, 20, pri(2, 2)).hot.length).toBe(0)
})

test('tierSkills: hot skills are ordered by recency', () => {
  const t = tierSkills([mkSkill('a', 85), mkSkill('b', 95), mkSkill('c', 90)], [], [], 100, 20, {})
  expect(t.hot.map(s => s.name)).toEqual(['b', 'c', 'a'])
})

const hotOf = (name: string, refs: { path: string; content?: string }[]) => ({ name, refs })

test('renderSkillSection: small refs inline within the budget, big or unreadable ones are listed', () => {
  const refs = [
    { path: `${SKS}/voice/a.md`, content: 'A'.repeat(4_000) },
    { path: `${SKS}/voice/b.md`, content: 'B'.repeat(12_000) },
    { path: `${SKS}/voice/c.md` },
  ]
  const r = renderSkillSection([hotOf('voice', refs)], [], 'en', 2, 6)
  expect(r?.text).toContain('Skill working set')
  expect(r?.text).toContain('voice: still in use')
  expect(r?.text).toContain('A'.repeat(4_000))
  expect(r?.text).not.toContain('B')
  expect(r?.text).toContain(`${SKS}/voice/b.md`)
  expect(r?.text).toContain('re-read when needed')
  expect(r?.text).toContain(`${SKS}/voice/c.md`)
  expect(r?.inlined).toEqual([`${SKS}/voice/a.md`])
  expect(r?.listed).toBe(2)
  expect(r?.inlinedK).toBe(1)
})

test('renderSkillSection: the total budget caps inlining, in recency order across skills', () => {
  const six = (n: string) => Array.from({ length: 3 }, (_, i) => ({ path: `${SKS}/${n}/r${i}.md`, content: `${n}${i}`.padEnd(6_000, '.') }))
  const r = renderSkillSection([hotOf('a', six('a')), hotOf('b', six('b'))], [], 'en', 2, 6)
  expect(r?.inlined).toEqual([`${SKS}/a/r0.md`, `${SKS}/a/r1.md`, `${SKS}/a/r2.md`, `${SKS}/b/r0.md`])
  expect(r?.listed).toBe(2)
  expect(r?.inlinedK).toBe(6)
  // refInlineK 0 inlines nothing.
  expect(renderSkillSection([hotOf('a', six('a'))], [], 'en', 0, 6)?.inlined).toEqual([])
})

test('renderSkillSection: a done skill gets one finished line; nothing hot or done gives no section', () => {
  const r = renderSkillSection([], ['pdf'], 'en', 2, 6)
  expect(r?.text).toContain('pdf')
  expect(r?.text).toContain('finished')
  expect(r?.text).toContain('no longer apply')
  expect(renderSkillSection([], [], 'en', 2, 6)).toBeUndefined()
  const zh = renderSkillSection([hotOf('voice', [])], ['pdf'], 'zh', 2, 6)
  expect(zh?.text).toContain('skill 工作集')
  expect(zh?.text).toContain('voice')
  expect(zh?.text).toContain('已完成')
})

test('continuationText: the skill section follows next and precedes the standing orders', () => {
  const base = { node: 'N', beforePct: 31, handoffPath: '/x/h.md', next: 'go', standing_orders: ['S1'], pending: [], language: LANG }
  const out = continuationText({ ...base, skills: 'SKILL_SECTION' }, 'en')
  expect(out.split('\n')[0]).toContain('Chat:')
  expect(out.indexOf('Next step: go')).toBeLessThan(out.indexOf('SKILL_SECTION'))
  expect(out.indexOf('SKILL_SECTION')).toBeLessThan(out.indexOf('S1'))
  expect(continuationText(base, 'en')).not.toContain('SKILL_SECTION')
})

test('instructions: the hot skill line is present and survives heavy trimming', () => {
  const h: Handoff = { ...HANDOFF, language: LANG, done: ['d'.repeat(20_000)], decisions: ['x'.repeat(9_000)], artifacts: ['y'.repeat(9_000)] }
  const msgs = [1, 2, 3].map(i => `USER_${i} ` + 'u'.repeat(3_000))
  const out = buildInstructions(h, msgs, '/x/handoff-1.md', 'en', 'I'.repeat(1_400), ['voice', 'plug:pdf'])
  expect(out.length <= 8_000).toBe(true)
  expect(out).toContain('voice, plug:pdf')
  expect(out).toContain('step')
  const zh = buildInstructions(h, msgs, '/x/handoff-1.md', 'zh', undefined, ['voice'])
  expect(zh).toContain('voice')
  expect(zh).toContain('工作集')
  expect(buildInstructions(HANDOFF, [], '/x/h.md', 'en')).not.toContain('Skills in use')
  expect(buildInstructions(HANDOFF, [], '/x/h.md', 'en', undefined, [])).not.toContain('Skills in use')
})

test('validateHandoff: keep_skills and drop_skills are optional, malformed ones are ignored', () => {
  const ok = validateHandoff({ ...HANDOFF, keep_skills: [' voice ', ''], drop_skills: ['pdf'] })
  expect(ok.ok && ok.h.keep_skills).toEqual(['voice'])
  expect(ok.ok && ok.h.drop_skills).toEqual(['pdf'])
  const none = validateHandoff(HANDOFF)
  expect(none.ok && none.h.keep_skills).toBeUndefined()
  for (const bad of ['voice', 7, null, [1, 2], { a: 1 }]) {
    const v = validateHandoff({ ...HANDOFF, keep_skills: bad, drop_skills: bad })
    expect(v.ok).toBe(true)
    expect(v.ok && v.h.keep_skills).toBeUndefined()
    expect(v.ok && v.h.drop_skills).toBeUndefined()
  }
})

test('configFrom: hotWindow, refInlineK and skillBudgetK default and validate', () => {
  expect([DEFAULTS.hotWindow, DEFAULTS.refInlineK, DEFAULTS.skillBudgetK]).toEqual([20, 2, 6])
  expect(configFrom({ hotWindow: 5, refInlineK: 1, skillBudgetK: 3 })).toMatchObject({ hotWindow: 5, refInlineK: 1, skillBudgetK: 3 })
  expect(configFrom({ hotWindow: 'x', refInlineK: undefined, skillBudgetK: '' })).toMatchObject({ hotWindow: 20, refInlineK: 2, skillBudgetK: 6 })
  expect(configFrom({ hotWindow: 0 }).hotWindow).toBe(1)
  expect(configFrom({ refInlineK: -3, skillBudgetK: -1 })).toMatchObject({ refInlineK: 0, skillBudgetK: 0 })
})

test('compact_now: the schema describes keep_skills and drop_skills in both languages', async ($, on) => {
  const w = engine(on)
  await start($)
  const schema = (w.registered[0] as unknown as { inputSchema: { required: string[]; properties: Record<string, { description: string; type: string }> } }).inputSchema
  expect(schema.properties.keep_skills.description).toBe(STRINGS.en.keep_skills)
  expect(schema.properties.drop_skills.description).toBe(STRINGS.en.drop_skills)
  expect(schema.required).not.toContain('keep_skills')
  expect(STRINGS.zh.keep_skills).not.toBe(STRINGS.en.keep_skills)
  expect(STRINGS.zh.drop_skills).not.toBe(STRINGS.en.drop_skills)
})

const skillCall = ($: Dollar, skill: string) => $.tool.call({ tool: 'Skill', skill } as never)
const readFile = ($: Dollar, file_path: string, extra: Record<string, unknown> = {}) => $.tool.call({ tool: 'Read', file_path, ...extra } as never)

/** Loads the skill `voice` with two refs (one small, one big), then compacts. */
async function skillSession($: Dollar, on: On, handoff: Record<string, unknown> = langHandoff(), cfg?: { reqs?: number }) {
  const w = engine(on)
  w.files.set(`${SKS}/voice/SKILL.md`, '# voice')
  w.files.set(`${SKS}/voice/references/small.md`, 'SMALL_REF_BODY')
  w.files.set(`${SKS}/voice/references/big.md`, 'B'.repeat(9_000))
  await start($)
  await modelStep($, w, 65_000)
  await skillCall($, 'plug:voice')
  await readFile($, `${SKS}/voice/references/big.md`)
  await readFile($, `${SKS}/voice/references/small.md`)
  for (let i = 0; i < (cfg?.reqs ?? 0); i++) await modelStep($, w, 65_000)
  await turnStart($, 't1')
  await call($, handoff)
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  return w
}

test('skills: the resume message carries the working set after the language line and next', async ($, on) => {
  const w = await skillSession($, on)
  const text = w.submits[0].text
  expect(text.split('\n')[0]).toContain('Chat:')
  const iNext = text.indexOf('Next step')
  const iSkill = text.indexOf('Skill working set')
  expect(iSkill).toBeGreaterThan(iNext)
  expect(text).toContain('plug:voice: still in use')
  expect(text).toContain('SMALL_REF_BODY')
  expect(text).toContain(`${SKS}/voice/references/big.md`)
  expect(text).not.toContain('BBBBBBBB')
  expect(w.compactCalls[0]).toContain('plug:voice')
  const done = w.log().find(l => l.result === 'done') as unknown as { skills: { hot: string[]; done: string[]; inlinedK: number; listed: number } }
  expect(done.skills).toEqual({ hot: ['plug:voice'], done: [], inlinedK: 0, listed: 1 })
})

test('skills: no skills loaded means no section and no skills log field', async ($, on) => {
  const w = await compacted($, on)
  expect(w.submits[0].text).not.toContain('Skill working set')
  expect(w.log().find(l => l.result === 'done')).not.toHaveProperty('skills')
  expect(w.compactCalls[0]).not.toContain('Skills in use')
})

test('skills: keep_skills revives an old skill', async ($, on) => {
  const w = await skillSession($, on, { ...langHandoff(), keep_skills: ['voice'] }, { reqs: 30 })
  expect(w.submits[0].text).toContain('plug:voice: still in use')
  expect(w.compactCalls[0]).toContain('plug:voice')
})

test('skills: drop_skills ends a skill with a finished line', async ($, on) => {
  const w = await skillSession($, on, { ...langHandoff(), drop_skills: ['plug:voice'] })
  expect(w.submits[0].text).toContain('plug:voice')
  expect(w.submits[0].text).toContain('finished')
  expect(w.submits[0].text).not.toContain('still in use')
  expect(w.compactCalls[0]).not.toContain('Skills in use')
})

test('skills: an unused skill older than hotWindow is left out entirely', async ($, on) => {
  const w = await skillSession($, on, langHandoff(), { reqs: 25 })
  expect(w.submits[0].text).not.toContain('Skill working set')
})

test('skills: subagent calls are ignored and a new conversation clears the set', async ($, on) => {
  const w = engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'voice', agentId: 'sub1' } as never)
  await call($, langHandoff())
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.submits[0].text).not.toContain('Skill working set')
  await skillCall($, 'voice')
  await $.session.end({ sessionId: 'sess1' } as never)
  await start($)
  w.usage.tokens = 200_000
  await call($, langHandoff())
  await turnComplete($, 't2')
  await w.clock.advance(1_500)
  expect(w.submits.at(-1)?.text).not.toContain('Skill working set')
})

const profileSkills = (w: W) => (JSON.parse(w.files.get(`${ROOT}/profile.json`) ?? '{}') as { skills?: Record<string, { compactions: number; refMisses: number }> }).skills

test('skills: a compaction counts per loaded skill in profile.json', async ($, on) => {
  const w = await skillSession($, on)
  expect(profileSkills(w)).toEqual({ 'plug:voice': { compactions: 1, refMisses: 0 } })
})

test('skills learning: a non-inlined ref read within 30 requests is a miss, an inlined one only a reread', async ($, on) => {
  const w = await skillSession($, on)
  for (let i = 0; i < 5; i++) await modelStep($, w, 65_000)
  await readFile($, `${SKS}/voice/references/small.md`)
  expect(w.log().filter(l => l.result === 'skill-ref-reread').length).toBe(1)
  expect(w.log().filter(l => l.result === 'skill-ref-miss').length).toBe(0)
  await readFile($, `${SKS}/voice/references/big.md`)
  const miss = w.log().filter(l => l.result === 'skill-ref-miss')
  expect(miss.length).toBe(1)
  expect(miss[0]).toMatchObject({ skill: 'plug:voice', path: `${SKS}/voice/references/big.md` })
  expect(profileSkills(w)?.['plug:voice']).toEqual({ compactions: 1, refMisses: 1 })
  // The same ref again within the window is not a second miss.
  await readFile($, `${SKS}/voice/references/big.md`)
  expect(profileSkills(w)?.['plug:voice']?.refMisses).toBe(1)
})

test('skills learning: a read after 30 requests is neither a miss nor a reread', async ($, on) => {
  const w = await skillSession($, on)
  for (let i = 0; i < 31; i++) await modelStep($, w, 65_000)
  await readFile($, `${SKS}/voice/references/big.md`)
  await readFile($, `${SKS}/voice/references/small.md`)
  expect(w.log().filter(l => l.result.startsWith('skill-ref')).length).toBe(0)
  expect(profileSkills(w)?.['plug:voice']?.refMisses).toBe(0)
})

test('skills learning: a subagent read is not a miss', async ($, on) => {
  const w = await skillSession($, on)
  await readFile($, `${SKS}/voice/references/big.md`, { agentId: 'sub1' })
  expect(w.log().filter(l => l.result.startsWith('skill-ref')).length).toBe(0)
})

test('skills: a prior miss rate from profile.json makes an idle skill hot at the next compaction', async ($, on) => {
  const w = engine(on)
  w.files.set(`${ROOT}/profile.json`, JSON.stringify({ byProject: {}, skills: { voice: { compactions: 4, refMisses: 2 } } }))
  await start($)
  await skillCall($, 'voice')
  for (let i = 0; i < 30; i++) await modelStep($, w, 65_000)
  await turnStart($, 't1')
  await call($, langHandoff())
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.submits[0].text).toContain('voice: still in use')
  expect(profileSkills(w)?.voice).toEqual({ compactions: 5, refMisses: 2 })
})

test('skills: an unreadable ref is listed, not inlined', async ($, on) => {
  const w = engine(on)
  w.files.set(`${SKS}/voice/SKILL.md`, '# voice')
  await start($)
  await skillCall($, 'voice')
  await readFile($, `${SKS}/voice/references/gone.md`)
  await turnStart($, 't1')
  await call($, langHandoff())
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  const text = w.submits[0]?.text ?? ''
  expect(text).toContain(`${SKS}/voice/references/gone.md`)
  expect(text).toContain('re-read when needed')
})

test('skills: hotWindow comes from settings', { options: { hotWindow: 1 } }, async ($, on) => {
  const w = await skillSession($, on, langHandoff(), { reqs: 3 })
  expect(w.submits[0].text).not.toContain('Skill working set')
})

test('skills: refInlineK=0 lists every ref, skillBudgetK caps the total', { options: { refInlineK: 0 } }, async ($, on) => {
  const w = await skillSession($, on)
  expect(w.submits[0].text).toContain(`${SKS}/voice/references/small.md`)
  expect(w.submits[0].text).not.toContain('SMALL_REF_BODY')
})

test('skills learning: an auto or manual compaction counts too, and every ref is a miss then', async ($, on) => {
  const w = engine(on)
  w.files.set(`${SKS}/voice/SKILL.md`, '# voice')
  w.files.set(`${SKS}/voice/references/small.md`, 'SMALL_REF_BODY')
  await start($)
  await skillCall($, 'voice')
  await readFile($, `${SKS}/voice/references/small.md`)
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never)
  expect(profileSkills(w)).toEqual({ voice: { compactions: 1, refMisses: 0 } })
  await readFile($, `${SKS}/voice/references/small.md`)
  expect(profileSkills(w)).toEqual({ voice: { compactions: 1, refMisses: 1 } })
})

// ---- skill working set: bounded reads, traversal, anchoring ----

/** One loaded skill `voice` with the given ref files (path under the skill dir to text), compacted. */
async function refSession($: Dollar, on: On, refs: Record<string, string>, setup?: (w: W) => void) {
  const w = engine(on)
  w.files.set(`${SKS}/voice/SKILL.md`, '# voice')
  for (const [p, t] of Object.entries(refs)) w.files.set(`${SKS}/voice/${p}`, t)
  setup?.(w)
  await start($)
  await skillCall($, 'voice')
  for (const p of Object.keys(refs)) await readFile($, `${SKS}/voice/${p}`)
  w.reads.length = 0
  await turnStart($, 't1')
  await call($, langHandoff())
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  return w
}

test('skills: a ref bigger than refInlineK is listed from its stat size and never read', async ($, on) => {
  const w = engine(on)
  w.files.set(`${SKS}/voice/SKILL.md`, '# voice')
  w.files.set(`${SKS}/voice/big.md`, 'B'.repeat(9_000))
  w.files.set(`${SKS}/voice/small.md`, 'SMALL_REF_BODY')
  await start($)
  await skillCall($, 'voice')
  await readFile($, `${SKS}/voice/big.md`)
  await readFile($, `${SKS}/voice/small.md`)
  w.reads.length = 0
  await turnStart($, 't1')
  await call($, langHandoff())
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.reads).toEqual([`${SKS}/voice/small.md`])
  expect(w.submits[0].text).toContain(`${SKS}/voice/big.md`)
  expect(w.submits[0].text).toContain('SMALL_REF_BODY')
})

test('skills: reads stop once the skill budget is spent; the rest are listed unread', async ($, on) => {
  const refs = Object.fromEntries([1, 2, 3, 4].map(i => [`r${i}.md`, `R${i}`.padEnd(7_000, 'x')]))
  const w = await refSession($, on, refs)
  // Newest first: r4, r3, r2 fit 3 x 1.75k <= 6k; r1 would reach 7k.
  expect(w.reads).toEqual([`${SKS}/voice/r4.md`, `${SKS}/voice/r3.md`, `${SKS}/voice/r2.md`])
  expect(w.submits[0].text).toContain(`${SKS}/voice/r1.md`)
  expect(w.submits[0].text).not.toContain('R1xx')
})

test('skills: a ref symlinked out of the skill dir is listed, not read', async ($, on) => {
  const w = await refSession($, on, { 'ok.md': 'OK_BODY', 'evil.md': 'x' }, w => {
    w.files.set('/etc/secret', 'SECRET_BODY')
    w.links.set(`${SKS}/voice/evil.md`, '/etc/secret')
  })
  expect(w.reads).toEqual([`${SKS}/voice/ok.md`])
  expect(w.submits[0].text).toContain(`${SKS}/voice/evil.md`)
  expect(w.submits[0].text).not.toContain('SECRET_BODY')
})

test('skills: a symlinked skill dir still inlines its refs', async ($, on) => {
  const w = await refSession($, on, { 'ok.md': 'OK_BODY' }, w => {
    w.files.set('/repo/skills/voice/ok.md', 'OK_BODY')
    w.files.set('/repo/skills/voice/SKILL.md', '# voice')
    w.links.set(`${SKS}/voice`, '/repo/skills/voice')
    w.links.set(`${SKS}/voice/ok.md`, '/repo/skills/voice/ok.md')
  })
  expect(w.submits[0].text).toContain('OK_BODY')
})

test('skills: a path that climbs out of the skill dir is neither tracked nor read', async ($, on) => {
  const w = engine(on)
  w.files.set(`${SKS}/voice/SKILL.md`, '# voice')
  w.files.set('/etc/passwd', 'ROOT_BODY')
  await start($)
  await skillCall($, 'voice')
  await readFile($, `${SKS}/voice/../../../../etc/passwd`)
  await $.tool.call({ tool: 'Bash', command: `cat ${SKS}/voice/../../../../etc/passwd` } as never)
  w.reads.length = 0
  await turnStart($, 't1')
  await call($, langHandoff())
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.reads).not.toContain('/etc/passwd')
  expect(w.submits[0].text).not.toContain('passwd')
  expect(w.submits[0].text).not.toContain('ROOT_BODY')
})

test('skills: a skills/<short>/ dir without SKILL.md is not the skill', async ($, on) => {
  const w = engine(on)
  w.files.set(`${SKS}/voice/SKILL.md`, '# voice')
  w.files.set('/other/skills/voice/notes.md', 'NOTES_BODY')
  await start($)
  await skillCall($, 'voice')
  await readFile($, '/other/skills/voice/notes.md')
  await readFile($, `${SKS}/voice/real.md`)
  await turnStart($, 't1')
  await call($, langHandoff())
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  expect(w.submits[0].text).not.toContain('/other/skills/voice/notes.md')
  expect(w.submits[0].text).not.toContain('NOTES_BODY')
})

test('skills: a Read written with ~ or ./ still counts against the tracked ref after a compaction', async ($, on) => {
  const w = await refSession($, on, { 'big.md': 'B'.repeat(9_000) })
  await readFile($, '~/.claude/skills/voice/big.md')
  expect(w.log().filter(l => l.result === 'skill-ref-miss').length).toBe(1)
})

test('skills: a ref linked into another skills/<short>/ dir is listed, not read', async ($, on) => {
  const w = await refSession($, on, { 'evil.md': 'x' }, w => {
    w.files.set('/other/skills/voice/x.md', 'OTHER_BODY')
    w.links.set(`${SKS}/voice/evil.md`, '/other/skills/voice/x.md')
  })
  expect(w.reads).toEqual([])
  expect(w.submits[0].text).not.toContain('OTHER_BODY')
  expect(w.submits[0].text).toContain(`${SKS}/voice/evil.md`)
})

// ---- step-away: compact while the prompt cache is warm ----

const HOUR = 3_600_000
const AWAY_USAGE = { tokens: 310_000, window: 1_000_000 }
const testAway = (name: string, body: TestBody, options: Record<string, unknown> = {}) =>
  test(name, { options: { language: 'en', turnEndCheck: false, ...options } }, body)
const awayRows = (w: W) => w.log().filter(l => l.result.startsWith('step-away'))

/** A request at 310k; the first one of a session is a small one, which the plugin takes as the empty-context baseline. */
async function bigStep($: Dollar, w: W) {
  if (w.step.index === 0) await modelStep($, w, 65_000)
  await modelStep($, w, 310_000)
}

/** A main turn whose last request reports a cache write of the given lifetime. */
async function awayTurn($: Dollar, w: W, ttl: '5m' | '1h' | null = '1h', id = 't1') {
  w.step.ephemeral = ttl === '1h' ? { ephemeral_1h_input_tokens: 5_000 } : ttl === '5m' ? { ephemeral_5m_input_tokens: 5_000 } : {}
  await turnStart($, id)
  await bigStep($, w)
  await turnComplete($, id)
}

test('step-away: pure helpers', () => {
  expect(ttlFromUsage({ ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 10 })).toBe('5m')
  expect(ttlFromUsage({ ephemeral_1h_input_tokens: 10 })).toBe('1h')
  expect(ttlFromUsage({})).toBeUndefined()
  expect(stepAwayDelay(1_000, '1h', 1_000)).toBe(HOUR - 600_000)
  expect(stepAwayDelay(1_000, '5m', 1_000)).toBe(300_000 - 90_000)
  expect(stepAwayDelay(0, '5m', 300_000 - 29_999)).toBeUndefined()
  expect(stepAwayDelay(0, '5m', 300_000 - 30_000)).toBe(0)
  expect(configFrom({}).stepAwayCompact).toBe(true)
  expect(configFrom({ stepAwayCompact: false }).stepAwayCompact).toBe(false)
})

test('step-away: strings carry the criteria and the skip reply in both languages', () => {
  const en = STRINGS.en.selfCheckAway(31, 9)
  expectEnCriteria(en)
  expect(en).toContain('expires in about 9 min')
  expect(en).toContain('skip: <one-line reason>')
  const zh = STRINGS.zh.selfCheckAway(31, 9)
  expectZhCriteria(zh)
  expect(zh).toContain('9 分钟')
  expect(zh).toContain('skip: <一句理由>')
})

testAway('step-away: a 1h cache arms at turn end and fires 10 min before expiry', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  await awayTurn($, w, '1h')
  await w.clock.advance(HOUR - 600_000 - 1)
  expect(w.submits).toEqual([])
  await w.clock.advance(1)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('stepped away')
  expect(w.submits[0].text).toContain('expires in about 10 min')
  expect(w.submits[0].text).toContain('31%')
  expect(awayRows(w).map(l => l.result)).toEqual(['step-away'])
})

testAway('step-away: a 5m cache fires 90 s before expiry', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  await awayTurn($, w, '5m')
  await w.clock.advance(210_000 - 1)
  expect(w.submits).toEqual([])
  await w.clock.advance(1)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0].text).toContain('expires in about 2 min')
})

testAway('step-away: the delay counts from the request start, not the turn end', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  w.step.ephemeral = { ephemeral_5m_input_tokens: 5_000 }
  await turnStart($, 't1')
  await bigStep($, w)
  await w.clock.advance(60_000) // the turn goes on after its last request
  await turnComplete($, 't1')
  await w.clock.advance(150_000 - 1)
  expect(w.submits).toEqual([])
  await w.clock.advance(1)
  expect(w.submits.length).toBe(1)
})

testAway('step-away: a user prompt cancels the timer', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  await awayTurn($, w, '1h')
  await w.clock.advance(HOUR - 700_000)
  await userPrompt($, 'back')
  await w.clock.advance(HOUR)
  expect(w.submits.filter(s => s.text.includes('stepped away'))).toEqual([])
})

testAway('step-away: a new turn cancels the timer and the next turn end re-arms it', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  await awayTurn($, w, '1h')
  await w.clock.advance(HOUR - 700_000)
  await turnStart($, 't2')
  await bigStep($, w)
  await w.clock.advance(200_000) // past the first timer's fire time
  expect(w.submits).toEqual([])
  await turnComplete($, 't2')
  await w.clock.advance(HOUR - 600_000 - 200_000)
  expect(w.submits.length).toBe(1)
})

testAway('step-away: no fire under the node tier', async ($, on) => {
  const w = engine(on, { tokens: 150_000, window: 1_000_000 })
  await start($)
  await awayTurn($, w, '1h')
  await w.clock.advance(2 * HOUR)
  expect(w.submits).toEqual([])
})

testAway('step-away: no fire when the cache lifetime is unknown', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  await awayTurn($, w, null)
  await w.clock.advance(2 * HOUR)
  expect(w.submits).toEqual([])
})

testAway('step-away: a subscription with room left in every window implies a 1h cache', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  w.limits.push({ kind: 'five_hour', percentUsed: 10 }, { kind: 'seven_day', percentUsed: 50 })
  await start($)
  await awayTurn($, w, null)
  await w.clock.advance(HOUR - 600_000)
  expect(w.submits.length).toBe(1)
})

testAway('step-away: a full rate-limit window drops the 1h assumption', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  w.limits.push({ kind: 'five_hour', percentUsed: 100 })
  await start($)
  await awayTurn($, w, null)
  await w.clock.advance(2 * HOUR)
  expect(w.submits).toEqual([])
})

testAway('step-away: fires once per idle stretch, again after the next typed prompt', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  await awayTurn($, w, '1h')
  await w.clock.advance(HOUR - 600_000)
  expect(w.submits.length).toBe(1)
  // The check turn declines; the stretch is still the same one.
  await turnStart($, 't2')
  await turnComplete($, 't2', false, 'skip: mid-review')
  await w.clock.advance(3 * HOUR)
  expect(w.submits.length).toBe(1)
  // The user returns and leaves again.
  await userPrompt($, 'back')
  await awayTurn($, w, '1h', 't3')
  await w.clock.advance(HOUR - 600_000)
  expect(w.submits.filter(s => s.text.includes('stepped away')).length).toBe(2)
})

testAway('step-away: logs compacted and declined with the reason', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  await awayTurn($, w, '1h')
  await w.clock.advance(HOUR - 600_000)
  await turnStart($, 't2')
  await turnComplete($, 't2', false, 'skip: half-done diff review')
  const declined = w.log().find(l => l.result === 'step-away:declined')
  expect(declined?.reason).toBe('half-done diff review')
  expect(w.log().some(l => l.result.startsWith('self-check'))).toBe(false)

  await userPrompt($, 'back')
  await awayTurn($, w, '1h', 't3')
  await w.clock.advance(HOUR - 600_000)
  await turnStart($, 't4')
  await call($, HANDOFF)
  await turnComplete($, 't4')
  expect(awayRows(w).map(l => l.result)).toEqual(['step-away', 'step-away:declined', 'step-away', 'step-away:compacted'])
})

testAway('step-away: not armed while a compaction is queued', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  w.wait.afterTokens = 300_000 // still above the node tier once it ran
  await start($)
  w.step.ephemeral = { ephemeral_1h_input_tokens: 5_000 }
  await turnStart($, 't1')
  await bigStep($, w)
  await call($, HANDOFF)
  await turnComplete($, 't1')
  await w.clock.advance(2 * HOUR)
  expect(awayRows(w)).toEqual([])
})

testAway('step-away: skipped after AskUserQuestion', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  w.step.ephemeral = { ephemeral_1h_input_tokens: 5_000 }
  await turnStart($, 't1')
  await bigStep($, w)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await turnComplete($, 't1')
  await w.clock.advance(2 * HOUR)
  expect(w.submits).toEqual([])
})

testAway('step-away: skipped for an aborted turn', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  w.step.ephemeral = { ephemeral_1h_input_tokens: 5_000 }
  await turnStart($, 't1')
  await bigStep($, w)
  await turnComplete($, 't1', true)
  await w.clock.advance(2 * HOUR)
  expect(w.submits).toEqual([])
})

testAway('step-away: a compaction that shrank the context below the tier skips the fire', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  await awayTurn($, w, '1h')
  w.usage.tokens = 100_000 // auto-compact while idle
  await w.clock.advance(2 * HOUR)
  expect(w.submits).toEqual([])
})

testAway('step-away: stepAwayCompact=false disables it', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  await awayTurn($, w, '1h')
  await w.clock.advance(2 * HOUR)
  expect(w.submits).toEqual([])
}, { stepAwayCompact: false })

testAway('step-away: a non-interactive session never fires', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($, false)
  await awayTurn($, w, '1h')
  await w.clock.advance(2 * HOUR)
  expect(w.submits).toEqual([])
})

testAway('step-away: the debug env var replaces the computed delay', async ($, on) => {
  const w = engine(on, AWAY_USAGE, { SELF_COMPACT_STEPAWAY_MS: '60000' })
  await start($)
  await awayTurn($, w, null) // no cache lifetime needed
  await w.clock.advance(59_999)
  expect(w.submits).toEqual([])
  await w.clock.advance(1)
  expect(w.submits.length).toBe(1)
})

testAway('step-away: the self-check turn is a turn of its own, so its end does not re-fire', async ($, on) => {
  const w = engine(on, AWAY_USAGE)
  await start($)
  await awayTurn($, w, '1h')
  await w.clock.advance(HOUR - 600_000)
  await turnStart($, 't2')
  await bigStep($, w)
  await turnComplete($, 't2', false, 'skip: busy')
  await w.clock.advance(5 * HOUR)
  expect(w.submits.length).toBe(1)
})
