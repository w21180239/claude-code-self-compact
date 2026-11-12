import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import {
  DEFAULTS,
  buildInstructions,
  continuationText,
  gate,
  nudgeLevel,
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
  const md = renderHandoff(HANDOFF, [msg, '另一条'])
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
  })
  expect(t).toContain('已压缩，按用户最新指令继续')
  expect(t).toContain('31% → 9%')
  expect(t).toContain('/x/h.md')
  expect(t).toContain('不要 push')
  expect(t).toContain('等 MR')
  const t2 = continuationText({ node: 'N', beforePct: 31, handoffPath: '/x/h.md', next: '做 X', standing_orders: [], pending: [] })
  expect(t2).toContain('做 X')
  expect(t2).not.toContain('已压缩，按用户最新指令继续')
})

// ---- compact_now tool and queue ----
// The module under test is loaded fresh by the harness, so its state is read through
// effects (files, status line, tool results), never through an imported binding.

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
  on('fs.read', (_, e) => (files.has(e.path) ? { value: files.get(e.path) as string } : { deny: 'ENOENT' }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  // Scripted outcomes of session.compact, one per call; the last one repeats.
  const compactPlan: ('ok' | 'busy' | 'throw')[] = ['ok']
  const compactCalls: string[] = []
  const toasts: string[] = []
  const submits: { text: string; context?: readonly string[] }[] = []
  const wait = { compactMs: 0, afterTokens: 80_000 }
  on('session.compact', async (_, e) => {
    compactCalls.push(e.instructions ?? '')
    const step = compactPlan.length > 1 ? (compactPlan.shift() as string) : compactPlan[0]
    if (wait.compactMs > 0) await clock.sleep(wait.compactMs)
    if (step === 'throw') throw new Error('turn running')
    if (step === 'busy') return { skip: 'busy' }
    usage.tokens = wait.afterTokens
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
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
  return { clock, files, registered, statuses, handoffs, log, usage, compactPlan, compactCalls, toasts, submits, wait, step, stopAnswer }
}

const start = ($: Dollar, isInteractive = true) =>
  $.session.start({ cwd: '/', surface: 'terminal', isInteractive } as never)

type Out = { deny?: string; result?: unknown; context?: string[] }

const call = ($: Dollar, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: TOOL_FULL, ...input, ...extra } as never) as Promise<Out>

const bash = ($: Dollar) => $.tool.call({ tool: 'Bash', command: 'ls' } as never) as Promise<Out>

test('tool: registered undeferred on start', async ($, on) => {
  const w = engine(on)
  await start($)
  expect(w.registered.length).toBe(1)
  expect(w.registered[0].name).toBe('compact_now')
  expect(w.registered[0].isDeferred).toBe(false)
  expect(w.registered[0].description.length > 100).toBe(true)
})

test('tool: subagent call denied', async ($, on) => {
  const w = engine(on)
  await start($)
  const r = await call($, HANDOFF, { agentId: 'sub1' })
  expect(r.deny).toContain('主会话')
  expect(w.handoffs()).toEqual([])
  expect(w.log().at(-1)?.result).toBe('denied:subagent')
})

test('tool: non-interactive denied', async ($, on) => {
  const w = engine(on)
  await start($, false)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('非交互')
  expect(w.handoffs()).toEqual([])
})

test('tool: below floor denied with pct', async ($, on) => {
  const w = engine(on, { tokens: 140_000, window: 1_000_000 })
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('14%')
  expect(r.deny).toContain('15')
  expect(w.handoffs()).toEqual([])
  expect(w.statuses).toEqual([])
  expect(w.log().at(-1)?.result).toBe('denied:gate')
})

test('tool: missing usage denies without throwing', async ($, on) => {
  engine(on, {})
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('不可用')
})

test('tool: missing fields denied', async ($, on) => {
  const w = engine(on)
  await start($)
  const { next: _n, objective: _o, ...rest } = HANDOFF
  const r = await call($, rest)
  expect(r.deny).toContain('next')
  expect(r.deny).toContain('objective')
  expect(w.handoffs()).toEqual([])
})

test('tool: after AskUserQuestion denied', async ($, on) => {
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

test('tool: disabled by DISABLE_COMPACT', async ($, on) => {
  engine(on, undefined, { DISABLE_COMPACT: '1' })
  await start($)
  const r = await call($, HANDOFF)
  expect(r.deny).toContain('禁用')
})

test('tool: valid call queues and writes handoff', async ($, on) => {
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

test('second call replaces queued', async ($, on) => {
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

test('stale after 4 tool calls drops request', async ($, on) => {
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
const turnComplete = ($: Dollar, turnId: string, isAborted = false) =>
  $.turn.complete({
    answer: '',
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

test('executor: compacts after turn and submits continuation with next', async ($, on) => {
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

test('executor: not during a running turn', async ($, on) => {
  const w = await queued($, on)
  await w.clock.advance(1_000)
  await turnStart($, 't2')
  await w.clock.advance(5_000)
  expect(w.compactCalls.length).toBe(0)
  await turnComplete($, 't2')
  await w.clock.advance(1_500)
  expect(w.compactCalls.length).toBe(1)
})

test('executor: retries 5 times then waits for next turn', async ($, on) => {
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

test('executor: gives up and toasts', async ($, on) => {
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
  expect(w.submits.at(-1)?.context).toBeUndefined()
})

test('executor: a thrown compact error is retried like a skip', async ($, on) => {
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

test('auto-compact preempts', async ($, on) => {
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

test('new user turn drops next', async ($, on) => {
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

test('aborted turn drops request', async ($, on) => {
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

test('log line written on done', async ($, on) => {
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

test('nudge: none below 30%', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 290_000)
  expect(await ctxOf($)).toBe('')
})

test('nudge: soft at 30 then every 5', async ($, on) => {
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

test('nudge: urgent at 40', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 410_000)
  const note = await ctxOf($)
  expect(note).toContain('41%')
  expect(note).toContain('下一个安全步骤')
})

test('nudge: rides next text tool result', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  expect(w.submits).toEqual([])
  expect(await ctxOf($)).toContain('30%')
  // Taken by the tool result, so the prompt carries nothing.
  await userPrompt($, '继续')
  expect(w.submits.at(-1)?.context).toBeUndefined()
})

test('nudge: falls back to the next prompt context', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  await userPrompt($, '继续')
  expect(w.submits.at(-1)?.context?.join(' ')).toContain('30%')
  expect(await ctxOf($)).toBe('')
})

test('nudge: silent while queued', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await call($, HANDOFF)
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toBe('')
})

test('nudge: silent when disabled by DISABLE_COMPACT', async ($, on) => {
  const w = engine(on, undefined, { DISABLE_COMPACT: '1' })
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toBe('') // disabled by DISABLE_COMPACT
})

test('nudge: silent for subagent steps', async ($, on) => {
  const w = engine(on)
  await start($)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000, 'sub1')
  expect(await ctxOf($)).toBe('')
})

test('nudge: silent when non-interactive', async ($, on) => {
  const w = engine(on)
  await start($, false)
  await modelStep($, w, 65_000)
  await modelStep($, w, 300_000)
  expect(await ctxOf($)).toBe('')
})

test('nudge: counts afresh after a compaction', async ($, on) => {
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

test('baseline: first main step sets the floor', async ($, on) => {
  // A 120k baseline needs (120k + 20k) / 0.55 = 255k before compact_now is accepted.
  const w = engine(on, { tokens: 240_000, window: 1_000_000 })
  await start($)
  await modelStep($, w, 120_000)
  expect((await call($, HANDOFF)).deny).toContain('24%')
  w.usage.tokens = 260_000
  expect((await call($, HANDOFF)).deny).toBeUndefined()
})

test('stop: queued compaction ends a blocked turn', async ($, on) => {
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

test('stop: no forcing loop after a failed forced end', async ($, on) => {
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
