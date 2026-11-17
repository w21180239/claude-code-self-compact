import type { EngineInterface, Register, Timer } from 'claude-code'

export type Config = {
  floorPct: number
  floorCalls: number
  nodeCalls: number
  workCalls: number
  nudgeStepPct: number
  urgentK: number
  compactCostK: number
  enabled: boolean
  releaseStopHooks: boolean
  autoNodes: boolean
  turnEndCheck: boolean
  language: Lang
  hotWindow: number
  refInlineK: number
  skillBudgetK: number
}

export const DEFAULTS: Config = {
  floorPct: 0,
  floorCalls: 20,
  nodeCalls: 10,
  workCalls: 8,
  nudgeStepPct: 5,
  urgentK: 350,
  compactCostK: 105,
  enabled: true,
  releaseStopHooks: false,
  autoNodes: true,
  turnEndCheck: true,
  language: 'en',
  hotWindow: 20,
  refInlineK: 2,
  skillBudgetK: 6,
}

// Empty session context, measured on the first main request when unavailable.
export const DEFAULT_BASELINE = 65_000

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
  hLanguage: string
  langChatLabel: string
  langSep: string
  langName: Record<'zh' | 'en', string>
  langInstruction: (chat: string | undefined) => string
  langReinforce: (line: string) => string
  language: string
  keep_skills: string
  drop_skills: string
  skillInstruction: (names: string) => string
  skillMore: (n: number) => string
  contSkills: string
  skillHot: (name: string) => string
  skillRefListed: (path: string) => string
  skillDone: (name: string) => string
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
  description: (cfg: Config, t?: Thresholds) => string
  heavyHarness: (pK: string) => string
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
// The three criteria that decide a compaction once the thresholds are passed (design section 10).
const CRIT = {
  en:
    'Compact only if all three hold: (1) the current block is closed (no unfinished step, no open question; finished work saved to disk and handed over for review counts as closed: list it in pending); ' +
    '(2) the next work does not depend on large raw text in this context (a diff being compared line by line, a long file just read, an error text still to be quoted); ' +
    '(3) enough work remains to repay a compaction (more than a few calls), a session about to end is not compacted.',
  zh:
    '是否压缩由你按三条判断，三条都满足才压：（1）当前块已收尾（没有未完成的步骤、没有开着的提问；成果已落盘、交给用户审阅也算收尾，写进 pending）；' +
    '（2）接下来的工作不依赖当前上下文里的大段原文（正在逐行对照的 diff、刚读的长文件、还要引用的报错原文）；' +
    '（3）剩余工作还够长，值得压一次（预计不止几次调用），马上要结束的会话不压。',
}

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
    nudgeSoft: pct => `[self-compact] Context ${pct}%, past the break-even line (necessary, not sufficient). Watch for the next node; ${CRIT.en} Call compact_now only if all three hold.`,
    nudgeUrgent: pct =>
      `[self-compact] Context ${pct}%, auto-compaction is close. Unless (1) fails (the current block is unfinished or a question is open; finished work saved to disk and handed over for review counts as closed: list it in pending), call compact_now at the next safe step, no need to wait for a perfect node.`,
    heavyHarness: pK =>
      `[self-compact] Context after compaction is still ${pK} (plugins, skills, memory), so a compaction saves little: compact at big phase handoffs or near the urgent tier, not at every small node.`,
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
      `[self-compact] The ${STRINGS.en.nodeNames[kind]} just now looks like a node (context ${pct}%, past the break-even line: necessary, not sufficient). ${CRIT.en} ` +
      `Compacting does not stop or interrupt the task: work resumes automatically right after, so "don't stop" instructions are no reason to skip. ` +
      `If all three hold, call compact_now before this turn ends.`,
    selfCheck: (kind, pct) =>
      `[self-compact self-check] The last turn showed a node signal (${kind}), context ${pct}%, past the break-even line: necessary, not sufficient. ${CRIT.en} ` +
      `Compacting does not stop or interrupt the task: work resumes automatically right after, so "don't stop" instructions are no reason to skip. ` +
      `If all three hold, call compact_now now (next: what to do next, or how to answer the user's latest message if nothing remains); otherwise reply with just "skip: <one-line reason>" and end.`,
    selfCheckWork: pct =>
      `[self-compact self-check] The last turn finished a block of work, context ${pct}%, past the break-even line: necessary, not sufficient. ${CRIT.en} ` +
      `Compacting does not stop or interrupt the task: work resumes automatically right after, so "don't stop" instructions are no reason to skip. ` +
      `If all three hold, call compact_now now (next: what to do next, or how to answer the user's latest message if nothing remains); otherwise reply with just "skip: <one-line reason>" and end.`,
    selfCheckLong: pct =>
      `[self-compact self-check] Context is ${pct}% and has not been compacted; it is past the break-even line: necessary, not sufficient. ${CRIT.en} ` +
      `Compacting does not stop or interrupt the task: work resumes automatically right after, so "don't stop" instructions are no reason to skip. ` +
      `If all three hold, call compact_now now (next: what to do next, or how to answer the user's latest message if nothing remains); otherwise reply with just "skip: <one-line reason>" and end.`,
    topicSwitch: pct =>
      `[self-compact] Context ${pct}%, past the break-even line: necessary, not sufficient. ${CRIT.en} ` +
      `If this message opens a new block of work (a different topic, or picking the work up again after a pause) and all three hold, call compact_now first (next: the gist of this request, in its own words) and end the turn; compacting does not stop the task, work resumes automatically right after.`,
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
    hLanguage: 'Language rules',
    langChatLabel: 'Chat: ',
    langSep: ' | ',
    langName: { zh: 'Chinese', en: 'English' },
    langInstruction: chat =>
      chat === undefined
        ? "The summary's first section is 'Language rules', copying each rule verbatim."
        : `Language: write the summary in ${chat}; its first section is 'Language rules', copying each outputs rule verbatim.`,
    langReinforce: line => `[self-compact] Language rules still apply: ${line}`,
    language: 'Fill in the language rules this session actually uses, not global defaults: chat = the conversation language as the user set it, outputs = one rule per channel (code, commit, PR, spec, outgoing text) in the user\'s words.',
    keep_skills: 'Skills (names) whose work continues after this compaction (optional)',
    drop_skills: 'Skills (names) whose work is finished and no longer applies (optional)',
    skillMore: n => `+${n} more`,
    skillInstruction: names => `Skills in use: ${names}. For each, record in the summary which step of its procedure you reached and what remains.`,
    contSkills: 'Skill working set:',
    skillHot: name => `${name}: still in use`,
    skillRefListed: path => `${path} (re-read when needed)`,
    skillDone: name => `${name}: finished; its re-injected instructions no longer apply.`,
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
    description: (cfg, t) => `Compact your own context at a task node. The call queues: the plugin compacts after the turn ends, then resumes you at \`next\`.

Tiers (enforced; compaction leaves ~${k(tiers(cfg, t).p)}): <${tierText(cfg, tiers(cfg, t), "floor")} denied; ${tierText(cfg, tiers(cfg, t), "floor")}-${tierText(cfg, tiers(cfg, t), "node")} only at a big phase handoff; >=${tierText(cfg, tiers(cfg, t), "node")} any clean node, nudged; >=${tierText(cfg, tiers(cfg, t), "urgent")} compact at the next safe step, no perfect node needed.

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
    nudgeSoft: pct => `[self-compact] 上下文 ${pct}%，已过回本线（必要条件）。留意下一个节点；${CRIT.zh}三条都满足再调用 compact_now。`,
    nudgeUrgent: pct =>
      `[self-compact] 上下文 ${pct}%，很快会触发自动压缩。除非（1）不满足（当前块未收尾或有开着的提问；成果已落盘、交给用户审阅算收尾，写进 pending），否则在下一个安全步骤调用 compact_now，不必等完美节点。`,
    heavyHarness: pK =>
      `[self-compact] 压缩后上下文仍有 ${pK}（插件、技能、记忆占用大），压一次省得不多：只在大阶段交接或接近紧急档时压，别每个小节点都压。`,
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
      `[self-compact] 刚才的 ${STRINGS.zh.nodeNames[kind]} 像是一个节点（上下文 ${pct}%，已过回本线，这是压缩的必要条件而非充分条件）。${CRIT.zh}` +
      `压缩不会打断任务，压完会自动接着做；三条都满足就在本轮结束前调用 compact_now。`,
    selfCheck: (kind, pct) =>
      `[self-compact 自检] 上一轮出现了节点信号（${kind}），上下文 ${pct}%，已过回本线，这是压缩的必要条件而非充分条件。${CRIT.zh}` +
      `压缩不会打断任务，压完会自动接着做。` +
      `三条都满足就现在调用 compact_now（next 写接下来要做的事；没有就写怎么回应用户最新的消息）；否则只回复 skip: <一句理由> 并结束。`,
    selfCheckWork: pct =>
      `[self-compact 自检] 上一轮做完了一整块工作，上下文 ${pct}%，已过回本线，这是压缩的必要条件而非充分条件。${CRIT.zh}` +
      `压缩不会打断任务，压完会自动接着做。` +
      `三条都满足就现在调用 compact_now（next 写接下来要做的事；没有就写怎么回应用户最新的消息）；否则只回复 skip: <一句理由> 并结束。`,
    selfCheckLong: pct =>
      `[self-compact 自检] 上下文已到 ${pct}%，一直没有压缩，已过回本线，这是压缩的必要条件而非充分条件。${CRIT.zh}` +
      `压缩不会打断任务，压完会自动接着做。` +
      `三条都满足就现在调用 compact_now（next 写接下来要做的事；没有就写怎么回应用户最新的消息）；否则只回复 skip: <一句理由> 并结束。`,
    topicSwitch: pct =>
      `[self-compact] 上下文 ${pct}%，已过回本线，这是压缩的必要条件而非充分条件。${CRIT.zh}` +
      `如果这条消息开启一个新工作块（换了话题，或隔了一阵重新接着做）且三条都满足，先调用 compact_now（next 写这条需求的原文要点）再结束本轮；压缩不会打断任务，压完会自动接着做。`,
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
    hLanguage: '语言约定',
    langChatLabel: '对话：',
    langSep: '｜',
    langName: { zh: '中文', en: '英文' },
    langInstruction: chat =>
      chat === undefined
        ? '摘要的第一节是「语言约定」，各条规则原样照抄。'
        : `用「${chat}」写摘要；摘要的第一节是「语言约定」，outputs 各条规则原样照抄。`,
    langReinforce: line => `[self-compact] 语言约定仍然有效：${line}`,
    language: '填本会话实际在用的语言约定，不是全局默认：chat 写用户设定的对话语言，outputs 每个渠道（代码、commit、PR、spec、对外文字）一条，用用户的原话。',
    keep_skills: '压缩后仍要继续的 skill 名（可选）',
    drop_skills: '已完成、不再适用的 skill 名（可选）',
    skillMore: n => `等另 ${n} 个`,
    skillInstruction: names => `在用的 skill：${names}。摘要里逐个写明它的工作集：流程走到了哪一步、还剩什么。`,
    contSkills: 'skill 工作集：',
    skillHot: name => `${name}：仍在使用`,
    skillRefListed: path => `${path}（需要时再读）`,
    skillDone: name => `${name}：已完成；重新注入的指令不再适用。`,
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
    description: (cfg, t) => `在任务节点上压缩你自己的上下文。调用只排队：本轮结束后插件自动压缩，并发续接消息让你按 next 继续。

门槛（插件强制，压缩后约 ${k(tiers(cfg, t).p)}，不够会被拒）：<${tierText(cfg, tiers(cfg, t), "floor")} 拒绝；${tierText(cfg, tiers(cfg, t), "floor")}-${tierText(cfg, tiers(cfg, t), "node")} 只在大阶段交接压（spec→plan、plan→实现、MR 创建→review）且下一阶段明显够长；>=${tierText(cfg, tiers(cfg, t), "node")} 任何干净节点可压，插件从此提醒；>=${tierText(cfg, tiers(cfg, t), "urgent")} 在下一个安全步骤就压，不必等完美节点。

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

export const SKIP_REASON_CAP = 200

/** Reason from a `skip: <reason>` self-check reply; undefined for a bare skip or any other text. */
export function parseSkipReason(answer: string | undefined): string | undefined {
  const m = /^\s*skip\s*[:：]\s*([\s\S]*)$/i.exec(answer ?? '')
  const reason = m?.[1]?.trim().slice(0, SKIP_REASON_CAP)
  return reason === undefined || reason === '' ? undefined : reason
}

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

// ---- thresholds ----

export const DEPRECATED_KEYS = ['minSavingK', 'nudgeStartPct', 'urgentPct'] as const

/** Old option keys that are still set; accepted but ignored. */
export function deprecatedKeys(options: Record<string, unknown> | undefined): string[] {
  const o = options ?? {}
  return DEPRECATED_KEYS.filter((key) => o[key] !== undefined)
}

/** Average context per call over n calls when each compaction costs `fixedCost` and leaves `p`: (10*fixedCost + n*p) / (n-1). */
export function callsToTokens(n: number, p: number, fixedCost: number): number {
  return (10 * fixedCost + n * p) / (n - 1)
}

export type Thresholds = { p: number; window: number; floor: number; node: number; work: number; urgent: number; heavy: boolean }

// A compaction must free at least this much, so no tier sits at or below the post-compact size.
const MIN_GAIN_K = 25

/** Tier sizes in tokens from the post-compact size p: capped at urgent (80% of the window at most), then raised to p + MIN_GAIN_K. */
export function thresholds(p: number, window: number, cfg: Config): Thresholds {
  const cost = cfg.compactCostK * 1_000
  const c = (n: number) => callsToTokens(n, p, cost)
  const minTier = p + MIN_GAIN_K * 1_000
  const urgent = Math.min(cfg.urgentK * 1_000, 0.8 * window)
  const tier = (v: number) => Math.max(Math.min(v, urgent), minTier)
  return {
    p,
    window,
    floor: tier(Math.max(c(cfg.floorCalls), (cfg.floorPct / 100) * window)),
    node: tier(c(cfg.nodeCalls)),
    work: tier(c(cfg.workCalls)),
    urgent: tier(urgent),
    heavy: c(cfg.workCalls) >= cfg.urgentK * 1_000,
  }
}

/** Tiers for the current post-compact size p: this session's sample, else the learned profile, else baseline + 25k. */
export function currentThresholds(window: number): Thresholds {
  return thresholds(pickP(state.profile, state.cwd ?? '', state.sessionP, state.baseline), window, state.cfg)
}

// Window assumed where the engine has not reported one (the tool description at session start).
const REF_WINDOW = 1_000_000
const tiers = (cfg: Config, t?: Thresholds): Thresholds => t ?? thresholds(pickP(state.profile, state.cwd ?? '', state.sessionP, state.baseline), REF_WINDOW, cfg)

/** "213k (21%)", full-width brackets in Chinese. */
const tierText = (cfg: Config, t: Thresholds, tier: 'floor' | 'node' | 'urgent'): string => {
  const pc = Math.round((t[tier] / t.window) * 100)
  return cfg.language === 'zh' ? `${k(t[tier])}（${pc}%）` : `${k(t[tier])} (${pc}%)`
}

export type GateResult = { ok: true; pct: number } | { ok: false; reason: string; pct?: number }

export function gate(u: Usage, t: Thresholds, lang: Lang): GateResult {
  const pct = pctOf(u)
  if (pct === undefined || u.tokens === undefined || !u.window) {
    return { ok: false, reason: STRINGS[lang].gateNoUsage }
  }
  if (u.tokens < t.floor) {
    const needPct = Math.round((t.floor / u.window) * 1000) / 10
    return {
      ok: false,
      pct,
      reason: STRINGS[lang].gateBelow(pct, k(u.tokens), needPct, k(t.floor)),
    }
  }
  return { ok: true, pct }
}

export type NudgeLevel = 'none' | 'soft' | 'urgent'

/** Nudge from the node tier (never below the floor), again only after each further `stepTokens`; urgent from the urgent tier. */
export function nudgeLevel(tokens: number, lastNudgedTokens: number | undefined, t: Thresholds, stepTokens: number): NudgeLevel {
  if (tokens < Math.max(t.node, t.floor)) return 'none'
  const isUrgent = tokens >= t.urgent
  if (lastNudgedTokens !== undefined && tokens < lastNudgedTokens + stepTokens) {
    // Crossing into urgent territory escalates at once.
    if (!(isUrgent && lastNudgedTokens < t.urgent)) return 'none'
  }
  return isUrgent ? 'urgent' : 'soft'
}

const num = (v: unknown, d: number): number => {
  const n = Number(v)
  return v === undefined || v === '' || !Number.isFinite(n) ? d : n
}

// Lower bounds that keep the tier arithmetic sane.
const MIN_URGENT_K = 50
const MIN_COST_K = 1

const calls = (v: unknown, d: number): number => Math.max(2, num(v, d))

/** Booleans default on; "false" and "0" turn them off. */
const flag = (v: unknown): boolean => v === undefined || !(v === false || v === 'false' || v === '0')

export function configFrom(options: Record<string, unknown> | undefined): Config {
  const o = options ?? {}
  const en = o.enabled
  const rs = o.releaseStopHooks
  return {
    floorPct: num(o.floorPct, DEFAULTS.floorPct),
    floorCalls: calls(o.floorCalls, DEFAULTS.floorCalls),
    nodeCalls: calls(o.nodeCalls, DEFAULTS.nodeCalls),
    workCalls: calls(o.workCalls, DEFAULTS.workCalls),
    nudgeStepPct: num(o.nudgeStepPct, DEFAULTS.nudgeStepPct),
    urgentK: Math.max(MIN_URGENT_K, num(o.urgentK, DEFAULTS.urgentK)),
    compactCostK: Math.max(MIN_COST_K, num(o.compactCostK, DEFAULTS.compactCostK)),
    enabled: en === undefined ? true : !(en === false || en === 'false' || en === '0'),
    releaseStopHooks: rs === true || rs === 'true' || rs === '1',
    autoNodes: flag(o.autoNodes),
    turnEndCheck: flag(o.turnEndCheck),
    language: o.language === 'zh' ? 'zh' : 'en',
    hotWindow: Math.max(1, Math.round(num(o.hotWindow, DEFAULTS.hotWindow))),
    refInlineK: Math.max(0, num(o.refInlineK, DEFAULTS.refInlineK)),
    skillBudgetK: Math.max(0, num(o.skillBudgetK, DEFAULTS.skillBudgetK)),
  }
}

// ---- Handoff ----

/** Per-channel language rules: `chat` is the conversation language, each `outputs` entry one rule in the user's words. */
export type LangRules = { chat: string; outputs: string[] }

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
  language?: LangRules
  keep_skills?: string[]
  drop_skills?: string[]
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText)

export type HandoffCheck = { ok: true; h: Handoff } | { ok: false; missing: string[] }

/** A malformed `language` counts as absent; it never blocks a compaction. */
function parseLanguage(v: unknown): LangRules | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.chat !== 'string' || !Array.isArray(o.outputs) || !o.outputs.every(x => typeof x === 'string')) return undefined
  return { chat: o.chat.trim(), outputs: (o.outputs as string[]).map(s => s.trim()).filter(s => s !== '') }
}

/** Skill names to keep or drop; anything but an array of strings counts as absent, and never blocks a compaction. */
function parseNames(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) return undefined
  const names = (v as string[]).map(s => s.trim()).filter(s => s !== '')
  return names.length > 0 ? names : undefined
}

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
  const language = parseLanguage(o.language)
  if (language !== undefined) h.language = language
  const keep = parseNames(o.keep_skills)
  if (keep !== undefined) h.keep_skills = keep
  const dropped = parseNames(o.drop_skills)
  if (dropped !== undefined) h.drop_skills = dropped
  return { ok: true, h }
}

const bullets = (items: readonly string[]): string => items.map(s => `- ${s}`).join('\n')

// A fence longer than any backtick run inside, so the text stays verbatim.
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(m => m.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

const hasLang = (l: LangRules | undefined): l is LangRules => l !== undefined && (l.chat !== '' || l.outputs.length > 0)

function langBullets(l: LangRules | undefined, lang: Lang): string[] {
  if (!hasLang(l)) return []
  return [...(l.chat !== '' ? [`${STRINGS[lang].langChatLabel}${l.chat}`] : []), ...l.outputs]
}

/** One line: the chat language, then each output rule; the first line of the resume message. */
export function langLine(l: LangRules | undefined, lang: Lang): string | undefined {
  const parts = langBullets(l, lang).map(s => s.replace(/\s+/g, ' '))
  return parts.length === 0 ? undefined : parts.join(STRINGS[lang].langSep)
}

export function renderHandoff(h: Handoff, userMsgs: readonly string[], lang: Lang = 'en', intent?: string): string {
  const t = STRINGS[lang]
  const sec = (title: string): string => `## ${title}`
  const out = [t.hTitle(h.node)]
  const rules = langBullets(h.language, lang)
  if (rules.length > 0) out.push(sec(t.hLanguage), bullets(rules))
  out.push(sec(t.hObjective), h.objective)
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
  // Everything the plugin submits itself: self-check, nudges.
  '[self-compact',
  '[Request interrupted',
  'This session is being continued',
  // Our own continuation prompt (see continuationText).
  ...Object.values(STRINGS).map(t => t.contMarker),
]

const startsInjected = (s: string): boolean => NOT_REAL_USER.some(p => s.trimStart().startsWith(p))

/** Text the person typed: not a tool notice, our own prompt, or the resume message (whose first line may be the language line). */
const isRealText = (text: string): boolean => {
  if (text.trim() === '' || startsInjected(text)) return false
  const i = text.indexOf('\n\n')
  return !(i > 0 && startsInjected(text.slice(i + 2)))
}

const isRealUser = (m: { role: string; text: string }): boolean => m.role === 'user' && isRealText(m.text)

/** The last `n` user messages typed by the person, oldest first. */
export function realUserMessages(msgs: readonly { role: string; text: string }[], n = 5): string[] {
  const real = msgs.filter(isRealUser).map(m => m.text)
  return n > 0 ? real.slice(-n) : []
}

export type ChatLang = 'zh' | 'en'

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g
export const CJK_RATIO = 0.3

/** 'zh' when CJK characters are at least CJK_RATIO of the non-space characters, else 'en'; undefined for empty text. */
export function dominantLang(text: string): ChatLang | undefined {
  const chars = text.replace(/\s/g, '')
  if (chars === '') return undefined
  return (chars.match(CJK)?.length ?? 0) / chars.length >= CJK_RATIO ? 'zh' : 'en'
}

/** Language of the person's last 5 typed messages; plugin-injected prompts do not count. */
export function detectChatLang(msgs: readonly string[]): ChatLang | undefined {
  return dominantLang(msgs.filter(isRealText).slice(-5).join(' '))
}

/** zh/en class of a free-text chat rule such as "Chinese, English terms OK": the first language named; undefined when none is. */
export function chatClass(chat: string): ChatLang | undefined {
  const zh = chat.search(/chinese|mandarin|cantonese|\u4e2d\u6587|\u6c49\u8bed|\u6f22\u8a9e|\u666e\u901a\u8bdd|\u56fd\u8bed|\u7ca4\u8bed/i)
  const en = chat.search(/english|\u82f1\u6587|\u82f1\u8bed/i)
  if (zh >= 0 && (en < 0 || zh < en)) return 'zh'
  if (en >= 0) return 'en'
  return dominantLang(chat) === 'zh' ? 'zh' : undefined
}

export type MergedLang = LangRules & { source: 'tool' | 'inherited' | 'detected' | 'none' }

/** Per sub-field the given value wins, then the previous one; `chat` finally falls back to the detected language's name. */
export function mergeLanguage(
  prev: LangRules | undefined,
  given: Partial<LangRules> | undefined,
  detected: ChatLang | undefined,
  lang: Lang = state.cfg.language,
): MergedLang {
  const gChat = given?.chat?.trim() ?? ''
  const gOut = given?.outputs ?? []
  const outputs = gOut.length > 0 ? gOut : (prev?.outputs ?? [])
  if (gChat !== '') return { chat: gChat, outputs, source: 'tool' }
  if (prev !== undefined && prev.chat !== '') return { chat: prev.chat, outputs, source: 'inherited' }
  if (detected !== undefined) return { chat: STRINGS[lang].langName[detected], outputs, source: 'detected' }
  return { chat: '', outputs, source: 'none' }
}

export const INTENT_CAP = 1_500

/** The first message the person typed, capped at INTENT_CAP: the task intent that later compactions would otherwise paraphrase away. */
export function firstUserMessage(msgs: readonly { role: string; text: string }[]): string | undefined {
  const m = msgs.find(isRealUser)
  if (m === undefined) return undefined
  return m.text.length > INTENT_CAP ? `${m.text.slice(0, INTENT_CAP)}\n[...]` : m.text
}

export const INSTRUCTIONS_CAP = 8_000

// The hot-skill line names at most this many skills.
const MAX_HOT_NAMES = 8

/** Compact instructions within INSTRUCTIONS_CAP: drops `done`, then the oldest user messages, then (last resort) `drop`, `lessons`, the original request, `decisions`, `artifacts`. standing_orders, pending, next, the language rules and the hot-skill line are never trimmed. */
export function buildInstructions(
  h: Handoff,
  userMsgs: readonly string[],
  handoffPath: string,
  lang: Lang = 'en',
  intent?: string,
  hotSkills: readonly string[] = [],
): string {
  const t = STRINGS[lang]
  // Never trimmed: it is what keeps the rules alive through the summariser.
  const langInstruction = hasLang(h.language) ? `${t.langInstruction(h.language.chat === '' ? undefined : h.language.chat)}\n\n` : ''
  const shown = hotSkills.slice(0, MAX_HOT_NAMES).join(', ')
  const listed = hotSkills.length > MAX_HOT_NAMES ? `${shown} ${t.skillMore(hotSkills.length - MAX_HOT_NAMES)}` : shown
  const skillInstruction = hotSkills.length > 0 ? `${t.skillInstruction(listed)}\n\n` : ''
  const build = (hh: Handoff, msgs: readonly string[], it: string | undefined): string =>
    `${t.preamble}\n\n${langInstruction}${skillInstruction}${renderHandoff(hh, msgs, lang, it)}\n\n${t.tail(handoffPath)}`
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
  language?: LangRules
  /** Rendered skill working set (see renderSkillSection). */
  skills?: string
}

export function continuationText(p: Continuation, lang: Lang = 'en'): string {
  const t = STRINGS[lang]
  const after = p.afterPct === undefined ? t.contUnknown : `${p.afterPct}%`
  const rules = langLine(p.language, lang)
  const lines = [
    ...(rules !== undefined ? [rules] : []),
    t.contHead(p.node, p.beforePct, after, p.handoffPath),
    t.contNext(p.next ?? t.contNextFallback),
    ...(p.skills !== undefined ? [p.skills] : []),
    `${t.contStanding}\n${p.standing_orders.length > 0 ? bullets(p.standing_orders) : t.none}`,
    `${t.contPending}\n${p.pending.length > 0 ? bullets(p.pending) : t.none}`,
    t.contClosing,
  ]
  // Models do not look back on their own; the pointer has to be explicit.
  if (p.sessionId) lines.push(t.contRecall(p.sessionId))
  return lines.join('\n\n')
}

// ---- skill working set ----
// The engine re-injects every invoked skill's body after a compaction; mods cannot see or change that.
// What the compaction loses is the working set: the reference files read under the skill dir and the step the work reached.

export type SkillUse = { name: string; short: string; lastUse: number; refs: string[] }
export type SkillPrior = { compactions: number; refMisses: number }
export const MAX_REFS = 8
// A ref read this many main requests after a compaction is a miss.
export const MISS_WINDOW = 30
const MIN_PRIOR_COMPACTIONS = 3
const PRIOR_MISS_RATE = 0.3
const CHARS_PER_TOKEN = 4

const shortName = (name: string): string => name.slice(name.lastIndexOf(':') + 1)

export type PathEnv = { cwd?: string; home?: string }

/** Lexically collapses `.`, `..` and `//`, resolving `~` and relative paths against `env`; undefined when the path climbs above its root or `~` has no home. */
export function normalizePath(path: string, env: PathEnv = {}): string | undefined {
  let p = path.replace(/\\/g, '/')
  if (p === '~' || p.startsWith('~/')) {
    if (!env.home) return undefined
    p = env.home.replace(/\\/g, '/').replace(/\/+$/, '') + p.slice(1)
  } else if (!/^([A-Za-z]:)?\//.test(p) && env.cwd) {
    p = `${env.cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${p}`
  }
  const root = /^([A-Za-z]:)?\//.exec(p)?.[0] ?? ''
  const segs = p.slice(root.length).split('/')
  const out: string[] = []
  for (const s of segs) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      if (out.length === 0) return undefined
      out.pop()
    } else out.push(s)
  }
  const last = segs[segs.length - 1]
  const dirLike = last === '' || last === '.' || last === '..'
  return root + out.join('/') + (dirLike && out.length > 0 ? '/' : '')
}

type SkillPath = { kind: 'main' | 'dir' | 'ref'; prefix: string }

/** `prefix` is the path up to and including `/skills/<short>/`; kind: 'main' = the skill's SKILL.md, 'dir' = the dir itself, 'ref' = any other file under it. Undefined when the path is elsewhere. */
function skillPathKind(norm: string, short: string): SkillPath | undefined {
  const marker = `/skills/${short}/`
  const i = norm.indexOf(marker)
  if (i < 0) return undefined
  const prefix = norm.slice(0, i + marker.length)
  const rest = norm.slice(prefix.length)
  return { prefix, kind: rest === '' ? 'dir' : rest === 'SKILL.md' ? 'main' : 'ref' }
}

const FILE_LIKE = /^[^*?{}[\]]+\.[A-Za-z0-9]+$/
const PATH_SPLIT = /[\s'"`<>|;&()=]+/

/** A Bash token without trailing punctuation or a `:<line>[:<col>]` suffix. */
function cleanToken(t: string): string {
  let cur = t
  for (;;) {
    const next = cur.replace(/[,.;:)'"]+$/, '').replace(/:\d+(:\d+)?$/, '')
    if (next === cur) return cur
    cur = next
  }
}

/** Paths a main-session tool call touches, with whether each is known to be a file. */
function touchedPaths(tool: string, args: Record<string, unknown>): { path: string; file: boolean }[] {
  const str = (v: unknown): string[] => (typeof v === 'string' && v !== '' ? [v] : [])
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    return [...str(args.file_path), ...str(args.notebook_path), ...str(args.path)].map(path => ({ path, file: true }))
  }
  if (tool === 'Grep' || tool === 'Glob') {
    return [...str(args.path), ...(tool === 'Glob' ? str(args.pattern) : [])].map(path => ({ path, file: FILE_LIKE.test(path) }))
  }
  if (tool === 'Bash') {
    return str(args.command)
      .flatMap(c => c.split(PATH_SPLIT))
      .filter(t => t.includes('skills/'))
      .map(cleanToken)
      .map(path => ({ path, file: FILE_LIKE.test(path) }))
  }
  return []
}

/** `true` = the prefix holds a SKILL.md, `false` = it does not, `undefined` = not probed yet. */
export type RootCheck = (prefix: string) => boolean | undefined
/** A use whose skill dir has not been probed: apply it once `prefix` is confirmed. */
export type Deferred = { prefix: string; apply: () => void }

/** The loaded skill a path belongs to among those sharing its short name: the one whose plugin segment is in the path, else the latest loaded (Map order). */
function ownerOf(skills: Map<string, SkillUse>, short: string, prefix: string): SkillUse | undefined {
  const same = [...skills.values()].filter(s => s.short === short)
  if (same.length <= 1) return same[0]
  const segs = prefix.split('/')
  const byPlugin = same.filter(s => s.name !== s.short && segs.includes(s.name.slice(0, s.name.lastIndexOf(':'))))
  return (byPlugin.length > 0 ? byPlugin : same).at(-1)
}

/** Records a main-session Skill load, and any later use of a loaded skill's dir; `skills` is updated in place. A path counts only under a dir `isRoot` confirms; uses under an unprobed dir come back deferred. */
export function trackSkillCall(
  skills: Map<string, SkillUse>,
  tool: string,
  input: unknown,
  nowReq: number,
  isRoot: RootCheck,
  env: PathEnv = {},
): Deferred[] {
  const flat = asObj(input) ?? {}
  const args = asObj(flat.input) ?? flat
  if (tool === 'Skill') {
    const raw = args.skill ?? args.name
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name === '') return []
    const prev = skills.get(name)
    if (prev !== undefined) {
      prev.lastUse = nowReq
      // Re-insert so Map order stays load order: a collision goes to the latest load.
      skills.delete(name)
      skills.set(name, prev)
    } else skills.set(name, { name, short: shortName(name), lastUse: nowReq, refs: [] })
    return []
  }
  if (skills.size === 0) return []
  const deferred: Deferred[] = []
  for (const { path, file } of touchedPaths(tool, args)) {
    const norm = normalizePath(path, env)
    if (norm === undefined) continue
    for (const short of new Set([...skills.values()].map(s => s.short))) {
      const hit = skillPathKind(norm, short)
      if (hit === undefined) continue
      const s = ownerOf(skills, short, hit.prefix)
      if (s === undefined) continue
      const apply = (): void => {
        s.lastUse = nowReq
        if (hit.kind === 'ref' && file) s.refs = [norm, ...s.refs.filter(r => r !== norm)].slice(0, MAX_REFS)
      }
      const root = isRoot(hit.prefix)
      if (root === true) apply()
      else if (root === undefined) deferred.push({ prefix: hit.prefix, apply })
    }
  }
  return deferred
}

const named = (list: readonly string[], s: SkillUse): boolean => list.some(x => x === s.name || x === s.short)

function priorHot(p: SkillPrior | undefined): boolean {
  return p !== undefined && p.compactions >= MIN_PRIOR_COMPACTIONS && p.refMisses / p.compactions >= PRIOR_MISS_RATE
}

export type Tiers = { hot: SkillUse[]; done: SkillUse[] }

/** keep_skills wins over drop_skills, which wins over activity: the model saying a skill is finished outranks a recent last use. Hot skills come newest first. */
export function tierSkills(
  skills: readonly SkillUse[],
  keep: readonly string[],
  drop: readonly string[],
  nowReq: number,
  hotWindow: number,
  priors: Record<string, SkillPrior>,
): Tiers {
  const hot: SkillUse[] = []
  const done: SkillUse[] = []
  for (const s of skills) {
    if (named(keep, s)) hot.push(s)
    else if (named(drop, s)) done.push(s)
    else if (nowReq - s.lastUse <= hotWindow || priorHot(Object.hasOwn(priors, s.name) ? priors[s.name] : undefined)) hot.push(s)
  }
  hot.sort((a, b) => b.lastUse - a.lastUse)
  return { hot, done }
}

export type HotSkill = { name: string; refs: { path: string; content?: string }[] }
export type SkillSection = { text: string; inlined: string[]; listed: number; inlinedK: number }

/** The resume-message section. A ref is inlined when its text is known, is at most refInlineK, and the running total stays within budgetK; the rest are listed by path. */
export function renderSkillSection(
  hot: readonly HotSkill[],
  done: readonly string[],
  lang: Lang,
  refInlineK: number,
  budgetK: number,
): SkillSection | undefined {
  if (hot.length === 0 && done.length === 0) return undefined
  const t = STRINGS[lang]
  const inlined: string[] = []
  let listed = 0
  let used = 0
  const lines: string[] = []
  for (const s of hot) {
    lines.push(`- ${t.skillHot(s.name)}`)
    for (const r of s.refs) {
      const sizeK = r.content === undefined ? Infinity : r.content.length / CHARS_PER_TOKEN / 1000
      if (r.content !== undefined && sizeK <= refInlineK && used + sizeK <= budgetK) {
        used += sizeK
        inlined.push(r.path)
        lines.push(`  - ${r.path}:`, fenced(r.content))
      } else {
        listed++
        lines.push(`  - ${t.skillRefListed(r.path)}`)
      }
    }
  }
  for (const name of done) lines.push(`- ${t.skillDone(name)}`)
  return { text: `${t.contSkills}\n${lines.join('\n')}`, inlined, listed, inlinedK: Math.round(used * 10) / 10 }
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
  langSource: string
  tiers: Tiers
}

/** What the last compaction left of each skill's refs: all of them, which the resume message inlined; a ref leaves `refs` once its miss is counted. */
type PostCompact = { at: number; refs: Map<string, Set<string>>; inlined: Set<string> }

type State = {
  cfg: Config
  interactive: boolean
  pending?: Pending
  baseline?: number
  cwd?: string
  profile: Profile
  // This session's latest post-compact size, and whether the next main step is to be sampled for it.
  sessionP?: number
  awaitingPSample: boolean
  heavyNoted: boolean
  /** Last window read by usageOf; the describe hook cannot read usage itself (breakdown re-enters it). Survives resets: the window is not per-conversation. */
  window?: number
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
  lastNudgedTokens?: number
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
  // Language rules of the last compaction request: kept across compactions, cleared with the conversation.
  lang?: LangRules
  // Real user turns still owed the rule line after a compaction.
  langTurns: number
  // Chat language class the first assistant reply after a compaction is checked against.
  driftExpect?: ChatLang
  // Skills loaded this session by name, the main-request counter, and the last compaction's snapshot for ref-miss learning.
  skills: Map<string, SkillUse>
  reqs: number
  // Skill dirs probed for a SKILL.md (prefix -> found), the tracking queue while a probe runs, and the home dir for `~` paths.
  roots: Map<string, boolean>
  trackQueue: Promise<void>
  trackPending: number
  home?: string
  post?: PostCompact
}

// One state per loaded module; a session start begins afresh.
export const state: State = {
  cfg: { ...DEFAULTS },
  profile: { byProject: {} },
  awaitingPSample: false,
  heavyNoted: false,
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
  langTurns: 0,
  skills: new Map(),
  reqs: 0,
  roots: new Map(),
  trackQueue: Promise.resolve(),
  trackPending: 0,
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
      keep_skills: { ...strs, description: t.keep_skills },
      drop_skills: { ...strs, description: t.drop_skills },
      language: {
        type: 'object',
        description: t.language,
        properties: { chat: str, outputs: strs },
        required: ['chat', 'outputs'],
      },
    },
    required: ['node', 'objective', 'standing_orders', 'decisions', 'artifacts', 'pending', 'done', 'next', 'language'],
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
  pSample?: number
  p?: number
  langSource?: string
  expected?: string
  got?: string
  skill?: string
  path?: string
  skills?: { hot: string[]; done: string[]; inlinedK: number; listed: number }
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

// ---- profile ----

export type PEst = { p: number; n: number; out?: { dir: 1 | -1; samples: number[] } }
export type Profile = { global?: PEst; byProject: Record<string, PEst>; skills?: Record<string, SkillPrior> }

const OUTLIER_FRAC = 0.5
const OUTLIER_RESET = 3

/** Folds one post-compact size into the estimate: EWMA 0.3, outliers at 0.1; three same-direction outliers re-seed it. */
export function learnP(est: PEst | undefined, sample: number): PEst {
  if (est === undefined) return { p: sample, n: 1 }
  const dev = sample - est.p
  if (Math.abs(dev) <= OUTLIER_FRAC * est.p) {
    return { p: Math.round(est.p + 0.3 * dev), n: est.n + 1 }
  }
  const dir: 1 | -1 = dev > 0 ? 1 : -1
  const samples = est.out?.dir === dir ? [...est.out.samples, sample] : [sample]
  if (samples.length >= OUTLIER_RESET) {
    return { p: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length), n: samples.length }
  }
  return { p: Math.round(est.p + 0.1 * dev), n: est.n + 1, out: { dir, samples } }
}

const MIN_N = 3

/** Post-compact size to plan with: this session's sample, else the project's, else the global, else baseline + 25k. */
export function pickP(profile: Profile, cwd: string, sessionSample: number | undefined, baseline: number | undefined): number {
  if (sessionSample !== undefined) return sessionSample
  const proj = profile.byProject[cwd]
  if (proj !== undefined && proj.n >= MIN_N) return proj.p
  if (profile.global !== undefined && profile.global.n >= MIN_N) return profile.global.p
  return (baseline ?? DEFAULT_BASELINE) + 25_000
}

const validEst = (e: unknown): e is PEst =>
  typeof e === 'object' && e !== null && Number.isFinite((e as PEst).p) && (e as PEst).p > 0 && Number.isFinite((e as PEst).n)

const validPrior = (v: unknown): v is SkillPrior => {
  const p = v as SkillPrior
  return typeof v === 'object' && v !== null && Number.isFinite(p.compactions) && p.compactions >= 0 && Number.isFinite(p.refMisses) && p.refMisses >= 0
}

function parseSkillPriors(v: unknown): Record<string, SkillPrior> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, SkillPrior> = {}
  for (const [key, p] of Object.entries(v)) {
    if (key !== '__proto__' && validPrior(p)) out[key] = { compactions: p.compactions, refMisses: p.refMisses }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function parseProfile(text: string | undefined): Profile {
  try {
    const o = JSON.parse(text ?? '') as unknown
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return { byProject: {} }
    const r = o as Partial<Profile>
    const raw = typeof r.byProject === 'object' && r.byProject !== null && !Array.isArray(r.byProject) ? r.byProject : {}
    const byProject: Record<string, PEst> = {}
    for (const [key, est] of Object.entries(raw)) if (key !== '__proto__' && validEst(est)) byProject[key] = est
    const { global: g, skills: rawSkills, ...rest } = r
    const skills = parseSkillPriors(rawSkills)
    const out: Profile = { ...rest, byProject }
    if (validEst(g)) out.global = g
    if (skills !== undefined) out.skills = skills
    return out
  } catch {
    return { byProject: {} }
  }
}

/** The saved profile; an absent or unreadable file reads as empty. */
async function loadProfile($: Dollar): Promise<Profile> {
  try {
    const home = await dataRoot($)
    if (home === undefined) return { byProject: {} }
    const path = `${home}/profile.json`
    const text = (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
    return parseProfile(typeof text === 'string' ? text : undefined)
  } catch {
    return { byProject: {} }
  }
}

/** Re-reads profile.json, applies `mutate`, writes it back; queued behind log writes, never throws. An unreadable file is left alone. */
export function saveProfile($: Dollar, mutate: (p: Profile) => void): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      const home = await dataRoot($)
      if (home === undefined) return
      const path = `${home}/profile.json`
      const prev = (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
      if (prev !== undefined && typeof prev !== 'string') return
      const profile = parseProfile(prev)
      mutate(profile)
      await $.fs.write(path, JSON.stringify(profile))
    } catch {
      // Learning is best effort.
    }
  }
  logTail = logTail.then(run, run)
  return logTail
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
  const usage = await usageOf($)
  const g = gate(usage, currentThresholds(usage.window ?? REF_WINDOW), state.cfg.language)
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
  const merged = mergeLanguage(state.lang, v.h.language, detectChatLang(msgs))
  const h: Handoff = { ...v.h, language: hasLang(merged) ? { chat: merged.chat, outputs: merged.outputs } : undefined }
  try {
    await $.fs.write(path, renderHandoff(h, msgs, state.cfg.language, intent))
  } catch (err) {
    return deny(S().denyWriteFailed(String(err)), 'write-failed', node, g.pct)
  }
  await state.trackQueue
  const tiers = tierSkills([...state.skills.values()], h.keep_skills ?? [], h.drop_skills ?? [], state.reqs, state.cfg.hotWindow, state.profile.skills ?? {})
  state.seq = n
  state.lang = h.language
  state.pending = {
    h,
    instructions: buildInstructions(h, msgs, path, state.cfg.language, intent, tiers.hot.map(s => s.name)),
    handoffPath: path,
    sessionId: sid,
    requestedPct: g.pct,
    toolCallsSince: 0,
    nextValid: true,
    langSource: merged.source,
    tiers,
  }
  state.retries = 0
  state.waitingNextTurn = false
  state.finalTry = false
  $.ui.status(S().statusQueued(v.h.node))
  await logLine($, { node: v.h.node, pct: g.pct, result: 'queued', langSource: merged.source })
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

// Real user turns after a compaction that get the language rule line appended.
export const LANG_REINFORCE_TURNS = 3

function sendContinuation($: Dollar, p: Pending, beforePct: number, afterPct: number | undefined, skills?: string): void {
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
    language: p.h.language,
    skills,
    },
    state.cfg.language,
  )
  state.langTurns = hasLang(p.h.language) ? LANG_REINFORCE_TURNS : 0
  state.driftExpect = p.h.language !== undefined ? chatClass(p.h.language.chat) : undefined
  // Not awaited: submit resolves only once the next turn starts.
  void Promise.resolve($.prompt.submit({ text })).catch(() => {})
}

async function giveUp($: Dollar, p: Pending, reason: string): Promise<void> {
  await dropPending($, p, { result: 'failed', reason })
  $.ui.toast(S().toastFailed(reason))
  state.notes.push(S().noteFailed(reason))
}

/** A compaction happened: count it for every loaded skill and snapshot their refs for miss learning. */
async function noteCompaction($: Dollar): Promise<void> {
  await state.trackQueue
  const loaded = [...state.skills.values()]
  state.post = { at: state.reqs, refs: new Map(loaded.map(s => [s.name, new Set(s.refs)])), inlined: new Set() }
  const names = loaded.map(s => s.name).filter(n => n !== '__proto__')
  if (names.length === 0) return
  const bump = (p: Profile) => {
    const sk = (p.skills ??= {})
    for (const n of names) sk[n] = { compactions: (Object.hasOwn(sk, n) ? sk[n].compactions : 0) + 1, refMisses: Object.hasOwn(sk, n) ? sk[n].refMisses : 0 }
  }
  bump(state.profile)
  await saveProfile($, bump)
}

/** The resume message's skill section for a queued compaction: reads the hot refs, notes which were inlined, and builds the log field. */
async function skillOutcome($: Dollar, p: Pending): Promise<{ text?: string; log?: NonNullable<LogLine['skills']> }> {
  await state.trackQueue
  const { hot, done } = p.tiers
  if (hot.length === 0 && done.length === 0) return {}
  const cfg = state.cfg
  const maxBytes = cfg.refInlineK * 1000 * CHARS_PER_TOKEN
  const budgetBytes = cfg.skillBudgetK * 1000 * CHARS_PER_TOKEN
  let usedBytes = 0
  const realRoots = new Map<string, string | undefined>()
  // The skill dir's real location with a trailing slash; undefined when it cannot be resolved.
  const realRoot = async (prefix: string): Promise<string | undefined> => {
    if (!realRoots.has(prefix)) {
      const st = await $.fs.stat(prefix, { resolve: true }).catch(() => undefined)
      const real = st?.kind === 'dir' && st.realPath !== undefined ? normalizePath(st.realPath) : undefined
      realRoots.set(prefix, real === undefined ? undefined : real.replace(/\/*$/, '/'))
    }
    return realRoots.get(prefix)
  }
  /** Reads a ref only when a stat says it is a file within refInlineK and the budget left, and its real path stays inside the skill dir. */
  const readRef = async (s: SkillUse, path: string): Promise<string | undefined> => {
    if (maxBytes <= 0 || budgetBytes <= 0 || usedBytes >= budgetBytes) return undefined
    try {
      const hit = skillPathKind(path, s.short)
      if (hit?.kind !== 'ref') return undefined
      const st = await $.fs.stat(path, { resolve: true })
      if (st.kind !== 'file' || st.size > maxBytes || usedBytes + st.size > budgetBytes || st.realPath === undefined) return undefined
      const real = normalizePath(st.realPath)
      const root = await realRoot(hit.prefix)
      if (real === undefined || root === undefined || !real.startsWith(root) || skillPathKind(real, s.short) === undefined) return undefined
      const body = await $.fs.read(real, { length: maxBytes })
      if (typeof body !== 'string') return undefined
      usedBytes += st.size
      return body
    } catch {
      return undefined
    }
  }
  const hotRefs: HotSkill[] = []
  for (const s of hot) {
    const refs: HotSkill['refs'] = []
    for (const path of s.refs) refs.push({ path, content: await readRef(s, path) })
    hotRefs.push({ name: s.name, refs })
  }
  const section = renderSkillSection(hotRefs, done.map(s => s.name), cfg.language, cfg.refInlineK, cfg.skillBudgetK)
  if (section === undefined) return {}
  if (state.post !== undefined) state.post.inlined = new Set(section.inlined)
  return { text: section.text, log: { hot: hot.map(s => s.name), done: done.map(s => s.name), inlinedK: section.inlinedK, listed: section.listed } }
}

/** A main Read soon after a compaction: of an inlined ref it is a reread, of a listed one a miss that feeds the skill's prior. */
async function learnRefRead($: Dollar, raw: string, env: PathEnv): Promise<void> {
  const post = state.post
  if (post === undefined || state.reqs - post.at > MISS_WINDOW) return
  const path = normalizePath(raw, env)
  if (path === undefined) return
  for (const [skill, refs] of post.refs) {
    if (!refs.has(path)) continue
    if (post.inlined.has(path)) {
      await logLine($, { result: 'skill-ref-reread', skill, path })
      continue
    }
    refs.delete(path)
    const bump = (p: Profile) => {
      const sk = (p.skills ??= {})
      if (skill === '__proto__') return
      sk[skill] = { compactions: Object.hasOwn(sk, skill) ? sk[skill].compactions : 0, refMisses: (Object.hasOwn(sk, skill) ? sk[skill].refMisses : 0) + 1 }
    }
    bump(state.profile)
    await saveProfile($, bump)
    await logLine($, { result: 'skill-ref-miss', skill, path })
  }
}

async function runCompact($: Dollar): Promise<void> {
  state.timer = undefined
  const p = state.pending
  if (p === undefined || state.compacting || state.busy) return
  state.compacting = true
  try {
    const started = await $.clock.now()
    const ctx = await usageOf($)
    const before = pctOf(ctx)
    // Auto-compact got there first: the request is moot, but work still resumes.
    if (ctx.tokens !== undefined && !gate(ctx, currentThresholds(ctx.window ?? REF_WINDOW), state.cfg.language).ok) {
      const sk = await skillOutcome($, p)
      await dropPending($, p, { result: 'preempted', beforePct: p.requestedPct, afterPct: before , skills: sk.log })
      state.compacting = false
      sendContinuation($, p, p.requestedPct, before, sk.text)
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
    await noteCompaction($)
    const sk = await skillOutcome($, p)
    await dropPending($, p, { result: 'done', beforePct: before, afterPct: after, durationMs, langSource: p.langSource, skills: sk.log })
    state.lastNudgedTokens = undefined
    state.awaitingPSample = true
    // The old step total is stale; the result's count stands in until the next step.
    state.lastStepTokens = tokensAfter
    state.checkedAt.clear()
    $.ui.toast(S().toastDone(String(before ?? '?'), String(after ?? '?')))
    sendContinuation($, p, before ?? p.requestedPct, after, sk.text)
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

/** Context reading against the window the engine compacts at ($.session.usage breakdown.maxTokens, else context.window). */
async function usageOf($: Dollar): Promise<Usage> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const max = context.breakdown?.maxTokens
  const window = typeof max === 'number' && max > 0 ? max : context.window
  if (window) state.window = window
  return contextOf({ tokens: context.tokens, window })
}

/** Registers compact_now; the `tool.describe` hook keeps its text current. */
async function registerTool($: Dollar): Promise<void> {
  await $.tool.register({
    name: TOOL,
    description: S().description(state.cfg, currentThresholds(state.window ?? REF_WINDOW)),
    inputSchema: inputSchema(S()),
    isDeferred: false,
  })
}

/** Folds the first main step after a compaction into the profile and the session's P. */
async function learnSample($: Dollar, total: number): Promise<void> {
  state.awaitingPSample = false
  state.sessionP = total
  const cwd = state.cwd
  const fold = (p: Profile) => {
    p.global = learnP(p.global, total)
    if (cwd !== undefined) p.byProject[cwd] = learnP(p.byProject[cwd], total)
  }
  fold(state.profile)
  await saveProfile($, fold)
  await logLine($, { result: 'p-sample', pSample: total, p: pickP(state.profile, cwd ?? '', state.sessionP, state.baseline) })
  // The cached description is rewritten at the next compaction (prompt cache kept).
  try {
    $.ui.invalidate('tool.describe')
  } catch {
    // The old description stays until the next session.
  }
}

async function onMainStep($: Dollar, u: StepUsage, messageCount: number): Promise<void> {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  // Zero or garbage usage (a failed or empty response) measures nothing; keep the last reading.
  if (!Number.isFinite(total) || total <= 0) return
  state.lastStepTokens = total
  if (state.baseline === undefined && messageCount <= BASELINE_MAX_MESSAGES) state.baseline = total
  if (state.awaitingPSample) await learnSample($, total)
  if (!state.interactive || !state.cfg.enabled || (await $.env.get('DISABLE_COMPACT')) === '1') return
  if (state.pending !== undefined || state.compacting) return
  const window = (await usageOf($)).window
  if (!window) return
  const t = currentThresholds(window)
  if (t.heavy && !state.heavyNoted) {
    state.heavyNoted = true
    state.notes.push(S().heavyHarness(k(t.p)))
  }
  const level = nudgeLevel(total, state.lastNudgedTokens, t, (state.cfg.nudgeStepPct / 100) * window)
  if (level === 'none') {
    // Back under the start line: something compacted, so count afresh.
    if (total < Math.max(t.node, t.floor)) state.lastNudgedTokens = undefined
    return
  }
  state.lastNudgedTokens = total
  const pct = pctOf({ tokens: total, window }) ?? 0
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
  state.lastNudgedTokens = undefined
  state.sessionP = undefined
  state.awaitingPSample = false
  state.heavyNoted = false
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
  state.lang = undefined
  state.langTurns = 0
  state.driftExpect = undefined
  state.skills.clear()
  state.roots.clear()
  state.reqs = 0
  state.post = undefined
}

/** Cwd and home for resolving relative and `~` paths. */
async function pathEnv($: Dollar): Promise<PathEnv> {
  state.home ??= (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || undefined
  return { cwd: state.cwd, home: state.home }
}

/** Probes a skill dir once: it counts only when it holds a SKILL.md (a failed stat is remembered as not a skill). */
async function probeRoot($: Dollar, prefix: string): Promise<void> {
  if (state.roots.has(prefix)) return
  state.roots.set(prefix, await $.fs.stat(`${prefix}SKILL.md`).then(s => s.kind === 'file', () => false))
}

/** Main-session tool call: learn from a ref read after a compaction, then track skill loads and use. A use under an unprobed skill dir settles off the call path; the queue keeps order. */
async function trackSkills($: Dollar, e: Record<string, unknown>): Promise<void> {
  const tool = String(e.tool)
  const env = await pathEnv($)
  if (tool === 'Read') {
    const path = asObj(e.input)?.file_path ?? e.file_path
    if (typeof path === 'string') await learnRefRead($, path, env)
  }
  const nowReq = state.reqs
  const settle = async (deferred: Deferred[]): Promise<void> => {
    for (const d of deferred) {
      await probeRoot($, d.prefix)
      if (state.roots.get(d.prefix) === true) d.apply()
    }
  }
  const run = (): Deferred[] => trackSkillCall(state.skills, tool, e, nowReq, p => state.roots.get(p), env)
  const enqueue = (job: () => Promise<void>): void => {
    state.trackPending++
    state.trackQueue = state.trackQueue.then(job).catch(() => undefined).finally(() => void state.trackPending--)
  }
  if (state.trackPending > 0) enqueue(() => settle(run()))
  else {
    const deferred = run()
    if (deferred.length > 0) enqueue(() => settle(deferred))
  }
}
// ---- autonomous triggers: node nudge, turn-end self-check, topic switch ----

// One self-check per node kind per this much context growth.
export const CHECK_STEP_PCT = 5

/** Context state for the autonomous triggers; undefined while they must stay quiet. */
async function triggerGate($: Dollar): Promise<{ pct: number; tokens: number; t: Thresholds } | undefined> {
  if (!state.cfg.autoNodes || !state.cfg.enabled || !state.interactive) return undefined
  if (state.pending !== undefined || state.compacting) return undefined
  if ((await $.env.get('DISABLE_COMPACT')) === '1') return undefined
  const u = await usageOf($)
  if (u.tokens === undefined || !u.window) return undefined
  const t = currentThresholds(u.window)
  const g = gate(u, t, state.cfg.language)
  if (!g.ok) return undefined
  return { pct: g.pct, tokens: u.tokens, t }
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
  if (sig.strength === 'weak' && g.tokens < g.t.node) return undefined
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
  const weakOk = g.tokens >= g.t.node
  let key: string
  let text: string
  if (sig !== undefined && (sig.strength === 'strong' || weakOk)) {
    key = sig.kind
    text = S().selfCheck(sig.kind, g.pct)
  } else if (state.turnToolCalls >= WORK_TURN_MIN_CALLS && g.tokens >= g.t.work) {
    key = 'work'
    text = S().selfCheckWork(g.pct)
  } else if (g.tokens >= g.t.node) {
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
  const pct = pctOf(await usageOf($))
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
    state.cwd = e.cwd
    state.profile = await loadProfile($)
    const stale = deprecatedKeys(options as Record<string, unknown> | undefined)
    if (stale.length > 0) await logLine($, { result: 'deprecated', reason: stale.join(',') })
    await registerTool($)
    return next(e)
  })

  let describing = false

  // The engine caches the answer until `$.ui.invalidate('tool.describe')`; a changed one reaches the model at the next compaction.
  on('tool.describe', { tool: TOOL_FULL }, async ($, e, next) => {
    // A nested describe (rendering schemas while this one runs) passes through.
    if (describing) return next(e)
    describing = true
    try {
      const t = currentThresholds(state.window ?? REF_WINDOW)
      await logLine($, { result: 'tool-describe', p: t.p })
      return { ...(await next(e)), description: S().description(state.cfg, t) }
    } finally {
      describing = false
    }
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
    if (state.driftExpect !== undefined && !e.isAborted && !state.checkTurn && e.answer.trim() !== '') {
      const expected = state.driftExpect
      state.driftExpect = undefined
      const got = dominantLang(e.answer)
      if (got !== undefined && got !== expected) await logLine($, { result: 'lang-drift', expected, got })
    }
    if (state.checkTurn) {
      state.checkTurn = false
      if (!e.isAborted) {
        if (state.compactCalled) await logLine($, { result: 'self-check:compacted' })
        else {
          const reason = parseSkipReason(e.answer)
          await logLine($, reason === undefined ? { result: 'self-check:declined' } : { result: 'self-check:declined', reason })
        }
      }
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
    if (human && state.langTurns > 0) {
      state.langTurns--
      const line = langLine(state.lang, state.cfg.language)
      if (line !== undefined) lines.push(S().langReinforce(line))
    }
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
        await trackSkills($, e as unknown as Record<string, unknown>)
      } catch {
        // Skill tracking is best effort; never break the call.
      }
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
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && typeof r.skip !== 'string') {
      // Our own compaction is noted by runCompact, after the call returns.
      if (!state.compacting) await noteCompaction($).catch(() => {})
      const after = (r as { tokensAfter?: unknown }).tokensAfter
      state.lastStepTokens = typeof after === 'number' && after > 0 ? after : undefined
      state.awaitingPSample = true
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) state.reqs++
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
