import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import {
  DEFAULTS,
  STRINGS,
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
} from '../hooks/register'
import type { Handoff, PEst } from '../hooks/register'

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
  on('session.usage', () => {
    if (fail.usage) throw new Error('usage unsupported')
    return { value: { startedAt: 0, context: usage, rateLimits: [] } }
  })
  on('session.messages', () => ({ value: messages }))
  on('tool.register', (_, e) => {
    registered.push(e as never)
    return { value: { tool: TOOL_FULL } }
  })
  on('tool.describe', (_, e) => ({ description: e.description }))
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
  on('fs.read', (_, e) => {
    if (fsFlags.failRead) return { deny: 'EIO' }
    return files.has(key(e.path)) ? { value: files.get(key(e.path)) as string } : { deny: 'ENOENT' }
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
  const step = { total: 65_000, index: 0 }
  const stopAnswer: { block?: string } = {}
  on('turn.step', async function* (_, e) {
    step.index++
    const usage = {
      input_tokens: 1_000,
      output_tokens: 10,
      cache_read_input_tokens: step.total - 1_000,
      cache_creation_input_tokens: 0,
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
  return { clock, files, registered, invalidated, statuses, handoffs, log, usage, compactPlan, compactCalls, toasts, submits, wait, step, stopAnswer, fsFlags, messages, fail }
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

test('tool description: tiers use the real compaction window', async ($, on) => {
  const w = engine(on, { window: 1_000_000, breakdown: { maxTokens: 200_000 } } as never)
  withProject(w, 87_000)
  await start($)
  expect(w.registered[0].description).toContain('160k (80%)')
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
