import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import {
  DEFAULTS,
  buildInstructions,
  continuationText,
  configFrom,
  gate,
  nudgeLevel,
  detectNode,
  realUserMessages,
  renderHandoff,
  TOOL_FULL,
  validateHandoff,
} from '../hooks/register'
import type { Handoff } from '../hooks/register'

test('gate: below 15% of 1M denies', () => {
  const g = gate({ tokens: 140_000, window: 1_000_000 }, 65_000, DEFAULTS)
  expect(g.ok).toBe(false)
  if (!g.ok) {
    expect(g.reason).toContain('14')
    expect(g.reason).toContain('15')
  }
})

test('gate: post ratio binds', () => {
  expect(gate({ tokens: 150_000, window: 1_000_000 }, 65_000, DEFAULTS).ok).toBe(false)
  expect(gate({ tokens: 160_000, window: 1_000_000 }, 65_000, DEFAULTS)).toEqual({ ok: true, pct: 16 })
})

test('gate: missing baseline uses 65k', () => {
  expect(gate({ tokens: 150_000, window: 1_000_000 }, undefined, DEFAULTS).ok).toBe(false)
  expect(gate({ tokens: 160_000, window: 1_000_000 }, undefined, DEFAULTS)).toEqual({ ok: true, pct: 16 })
})

test('gate: missing usage denies', () => {
  const g = gate({}, 65_000, DEFAULTS)
  expect(g.ok).toBe(false)
  expect(gate({ tokens: 160_000 }, 65_000, DEFAULTS).ok).toBe(false)
})

test('gate: 200k window effectively closed', () => {
  expect(gate({ tokens: 150_000, window: 200_000 }, 65_000, DEFAULTS).ok).toBe(false)
})

test('nudgeLevel: 29 none, 30 soft, 32 after 30 none, 35 after 30 soft, 41 urgent', () => {
  expect(nudgeLevel(29, undefined, 15, DEFAULTS)).toBe('none')
  expect(nudgeLevel(30, undefined, 15, DEFAULTS)).toBe('soft')
  expect(nudgeLevel(32, 30, 15, DEFAULTS)).toBe('none')
  expect(nudgeLevel(35, 30, 15, DEFAULTS)).toBe('soft')
  expect(nudgeLevel(41, undefined, 15, DEFAULTS)).toBe('urgent')
})

test('nudgeLevel: start raised to floor', () => {
  expect(nudgeLevel(31, undefined, 35, DEFAULTS)).toBe('none')
  expect(nudgeLevel(35, undefined, 35, DEFAULTS)).toBe('soft')
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
  const registered: { name: string; description: string; isDeferred?: boolean }[] = []
  const statuses: (string | undefined)[] = []
  const messages = [{ role: 'user', text: '请继续做 Task 3', toolUses: [] }]
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: usage, rateLimits: [] } }))
  on('session.messages', () => ({ value: messages }))
  on('tool.register', (_, e) => {
    registered.push(e as never)
    return { value: { tool: TOOL_FULL } }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  const fsFlags = { failRead: false }
  on('fs.read', (_, e) => {
    if (fsFlags.failRead) return { deny: 'EIO' }
    return files.has(e.path) ? { value: files.get(e.path) as string } : { deny: 'ENOENT' }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
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
  return { clock, files, registered, statuses, handoffs, log, usage, compactPlan, compactCalls, toasts, submits, wait, step, stopAnswer, fsFlags }
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
  const w = engine(on, { tokens: 140_000, window: 1_000_000 })
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('14%')
  expect(r.deny).toContain('15')
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

testZh('nudge: none below 30%', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 290_000)
  expect(await ctxOf($)).toBe('')
})

testZh('nudge: soft at 30 then every 5', async ($, on) => {
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

testZh('nudge: urgent at 40', async ($, on) => {
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
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toContain('30%')
})

testZh('baseline: first main step sets the floor', async ($, on) => {
  // A 120k baseline needs (120k + 20k) / 0.55 = 255k before compact_now is accepted.
  const w = engine(on, { tokens: 240_000, window: 1_000_000 })
  await start($)
  await modelStep($, w, 120_000)
  expect((await call($, HANDOFF)).deny).toContain('24%')
  w.usage.tokens = 260_000
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
  // Same 30% again in the new session nudges again, and a 120k first step is the new baseline.
  await modelStep($, w, 120_000)
  w.usage.tokens = 240_000
  expect((await call($, HANDOFF)).deny).toContain('24%')
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
  expect(w.log().length).toBe(3)
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
  expect(d.length <= 640).toBe(true)
  for (const s of ['15%', '20%', '30%', '40%', '好节点', '反节点', '标出节点', '不要再调用']) expect(d).toContain(s)
})

test('configFrom: defaults, strings and booleans', () => {
  expect(configFrom(undefined)).toEqual(DEFAULTS)
  const c = configFrom({ floorPct: '20', maxPostRatio: 0.4, nudgeStartPct: '', enabled: 'false' })
  expect(c.floorPct).toBe(20)
  expect(c.maxPostRatio).toBe(0.4)
  expect(c.nudgeStartPct).toBe(30)
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
  const w = engine(on, { tokens: 140_000, window: 1_000_000 })
  await start($)
  const denied = await call($, HANDOFF)
  expect(denied.deny).toContain('14%')
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
  const w = engine(on, { tokens: 140_000, window: 1_000_000 })
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
  const w = engine(on, { tokens: 140_000, window: 1_000_000 })
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('below the compaction threshold')
  expect(w.registered[0].description).toContain('Good nodes')
})

test('tool description (en): short with tiers, nodes, anti-nodes and end-the-turn', async ($, on) => {
  const w = engine(on)
  await start($)
  const d = w.registered[0].description
  expect(d.length <= 700).toBe(true)
  for (const s of ['15%', '20%', '30%', '40%', 'Good nodes', 'Anti-nodes', 'flags nodes', 'end the turn now', 'call no more tools']) {
    expect(d).toContain(s)
  }
  expect(d.replace(/[→·]/g, '')).not.toMatch(NON_ASCII)
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
  strong('Bash', { command: 'git tag v1.0.0' }, 'tag')
  strong('Write', { file_path: '/g/docs/specs/2026-11-12-x-design.md' }, 'spec-plan')
  strong('Edit', { file_path: '/g/docs/superpowers/plans/p.md' }, 'spec-plan')
  strong('MultiEdit', { file_path: 'docs/spec/x.md' }, 'spec-plan')
  strong('Write', { file_path: '/g/HANDOFF.md' }, 'handoff')
  strong('Write', { file_path: '/g/notes/handoff-2.md' }, 'handoff')
  strong('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] }, 'todos-done')
  weak('Bash', { command: 'git commit -m "x"' }, 'commit')
  weak('Write', { file_path: '/g/notes/readme.md' }, 'doc-written', 'File created successfully at: /g/notes/readme.md')
  weak('Agent', { run_in_background: true, prompt: 'p' }, 'delegated')
  weak('Task', { run_in_background: true }, 'delegated')
  // A commit that also pushes is the stronger node.
  strong('Bash', { command: 'git commit -m x && git push' }, 'push')
  // No signal.
  expect(detectNode('Bash', { command: 'ls -la' })).toBeUndefined()
  expect(detectNode('Bash', { command: 'git status' })).toBeUndefined()
  expect(detectNode('Write', { file_path: '/g/src/a.ts' })).toBeUndefined()
  expect(detectNode('Write', { file_path: '/g/notes/readme.md' }, 'The file /g/notes/readme.md has been updated')).toBeUndefined()
  expect(detectNode('Edit', { file_path: '/g/notes/readme.md' })).toBeUndefined()
  expect(detectNode('TodoWrite', { todos: [{ status: 'completed' }, { status: 'in_progress' }] })).toBeUndefined()
  expect(detectNode('TodoWrite', { todos: [] })).toBeUndefined()
  expect(detectNode('Agent', { prompt: 'p' })).toBeUndefined()
  expect(detectNode('Agent', { run_in_background: false })).toBeUndefined()
})

test('detectNode: ignores errors and subagents', () => {
  expect(detectNode('Bash', { command: 'git push' }, { isError: true })).toBeUndefined()
  expect(detectNode('Bash', { command: 'git push' }, { error: 'rejected' })).toBeUndefined()
  expect(detectNode('Bash', { command: 'git push' }, { exitCode: 1 })).toBeUndefined()
  expect(detectNode('Bash', { command: 'git push' }, { result: 'ok' })).toEqual({ kind: 'push', strength: 'strong' })
})

testZh('detectNode: ignores subagent tool calls in the hook', async ($, on) => {
  const w = engine(on)
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
  expect(r.context?.join('\n')).toBe(
    '[self-compact] 刚才的 git push 像是一个节点（上下文 20%，插件已确认现在压缩划算，不用再判断大小）。' +
      '压缩不会打断任务，压完会自动接着做；只要这一步已收尾、没有在等用户回答，就在本轮结束前调用 compact_now。',
  )
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
  const w = engine(on, { tokens: 140_000, window: 1_000_000 })
  await start($)
  await turnStart($, 't1')
  expect((await gitPush($)).context).toBeUndefined()
  // Gate open but a weak signal needs floor + 5 = 20%.
  w.usage.tokens = 170_000
  expect((await gitCommit($)).context).toBeUndefined()
  // A strong one does not.
  await turnComplete($, 't1')
  await turnStart($, 't2')
  expect((await gitPush($)).context?.join(' ')).toContain('17%')
  await turnComplete($, 't2')
  await turnStart($, 't3')
  w.usage.tokens = 200_000
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
  expect(w.submits[0].text).toBe(
    '[self-compact 自检] 上一轮出现了节点信号（push），上下文 20%，插件已确认现在压缩划算。' +
      '压缩不会打断任务，压完会自动接着做。' +
      '只要当前步骤已收尾、没有在等用户回答，现在就调用 compact_now（next 写接下来要做的事；没有就写怎么回应用户最新的消息）；否则只回复「不压」并结束。',
  )
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

testZh('self-check: logs compacted and declined on the following turn', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  await gitPush($)
  await turnComplete($, 't1')
  await w.clock.advance(1_500)
  await turnStart($, 't2')
  await turnComplete($, 't2', false, '不压')
  expect(w.log().at(-1)?.result).toBe('self-check:declined')
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
  // Below nudgeStartPct and no node: nothing.
  const before = w.submits.length
  w.usage.tokens = 200_000
  await turnStart($, 't2')
  await bash($)
  await turnComplete($, 't2')
  await w.clock.advance(5_000)
  expect(w.submits.length).toBe(before)
})

testZh('self-check: skipped when the turn ends with a question', async ($, on) => {
  const w = engine(on)
  await start($)
  await turnStart($, 't1')
  await gitPush($)
  await turnComplete($, 't1', false, '要不要现在合并？')
  await w.clock.advance(5_000)
  expect(w.submits).toEqual([])
  await turnStart($, 't2')
  await gitPush($)
  await turnComplete($, 't2', false, 'Merge it now?')
  await w.clock.advance(5_000)
  expect(w.submits).toEqual([])
  await turnStart($, 't3')
  await gitPush($)
  await turnComplete($, 't3', false, '合并了 ')
  await w.clock.advance(1_500)
  expect(w.submits.length).toBe(1)
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
  await turnComplete($, 't2', false, '不压')
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

testZh('topic switch: hint added above floor+5', async ($, on) => {
  const w = engine(on, { tokens: 170_000, window: 1_000_000 })
  await start($)
  await userPrompt($, '换个需求')
  expect(w.submits.at(-1)?.context).toBeUndefined()
  w.usage.tokens = 200_000
  await userPrompt($, '换个需求')
  expect(w.submits.at(-1)?.context?.join('\n')).toBe(
    '[self-compact] 上下文 20%，插件已确认现在压缩划算。如果这条新需求和之前的工作无关，先调用 compact_now（next 写这条需求的原文要点）再结束本轮；压缩不会打断任务，压完会自动接着做。',
  )
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

test('tool description: tiers come from config', { options: { floorPct: 1 } }, async ($, on) => {
  const w = engine(on)
  await start($)
  const d = w.registered[0].description
  expect(d).toContain('<1% denied')
  expect(d).toContain('1-6%')
  expect(d).toContain('>=6%')
  expect(d).not.toContain('15%')
  expect(d.length <= 700).toBe(true)
})

test('tool description (zh): tiers come from config', { options: { language: 'zh', floorPct: 1, urgentPct: 50 } }, async ($, on) => {
  const w = engine(on)
  await start($)
  const d = w.registered[0].description
  expect(d).toContain('<1% 拒绝')
  expect(d).toContain('1-6%')
  expect(d).toContain('>=50%')
  expect(d).not.toContain('15%')
  expect(d.length <= 640).toBe(true)
})

test('nudge text: says the gate passed and compaction does not stop the task', async ($, on) => {
  engine(on)
  await start($)
  await turnStart($, 't1')
  const r = await gitPush($)
  const t = r.context?.join('\n') ?? ''
  expect(t).toContain('already checked')
  expect(t).toContain('do not judge the size again')
  expect(t).toContain('does not stop or interrupt the task')
})

testZh('nudge text (zh): says the gate passed and compaction does not stop the task', async ($, on) => {
  engine(on)
  await start($)
  await turnStart($, 't1')
  const r = await gitPush($)
  const t = r.context?.join('\n') ?? ''
  expect(t).toContain('插件已确认现在压缩划算')
  expect(t).toContain('不用再判断大小')
  expect(t).toContain('压缩不会打断任务')
})
