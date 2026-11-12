# 设计

## 问题

长会话一定会 compact。auto-compact 在任意时刻触发，常压在任务中间，summarizer 要猜哪些内容重要。手动 `/compact` 更好，因为由人选时机、写指令，但需要人在场。

设计问题是：能否让 Claude 替人做这件事，即发现合适的时机、写好指令、压完继续。self-compact 的回答是一个工具、一道门槛和一条续接消息，对应功能请求 [anthropics/claude-code#19877](https://github.com/anthropics/claude-code/issues/19877) 与 [#96713](https://github.com/anthropics/claude-code/issues/96713)。

节点与反节点清单来自作者自己的 214 次手动压缩（1M 窗口，压缩前上下文中位数 318k）。约三分之一发生在窗口用到 32-72% 时、任务中途，当时上下文已大到不得不压，任务离边界还远。Claude 要做的是更早、在更干净的点抓住这种情况。

## 目标与非目标

目标：

1. Claude 通过工具请求压缩，指令由 Claude 自己写。
2. 插件提供真实的上下文占比，执行下限，并提醒 Claude 找节点。
3. 压缩在本轮结束后执行，Claude 不需要用户推动就拿回下一步。
4. 常驻规则、带原因的决定、未完成的委派、用户最近的原话，压后不丢。
5. 每次请求都记日志，用来调门槛。

非目标：

- 替换 summarizer 或改写历史。插件用原生压缩加 Claude 写的指令。
- subagent。它们保持短小、超了就拆；只有主会话可以压缩。
- 其他 agent CLI、外部触发、跨会话压缩。

算插件失败的情形：总 token 开销变大（压得太早或太频繁）、任务质量下降（压在反节点上，或交接单漏了规则）、打断用户、压完卡住。

## 流程

```text
Claude 判断到了节点
  -> mcp__self-compact__compact_now(handoff)
       门槛不过：返回拒绝，含当前占比和下限
       门槛通过：写 handoff-<n>.md，排队，返回"已排队"
主轮结束（未中断）
  -> 防抖 1.5 秒，再读用量，仍高于下限
  -> $.session.compact({ instructions })
       跳过或出错：每 2 秒重试，最多 5 次，下一个主轮结束再试一次，仍失败则放弃
       完成：记日志，toast，$.prompt.submit(续接消息)
```

每个会话只保留一个排队请求，新的 `compact_now` 覆盖旧的。

## 门槛

两个条件同时满足插件才放行：

1. `tokens >= floorPct% x window`
2. `(baseline + 20k) / tokens <= maxPostRatio`。`baseline` 是本会话首个主轮请求的上下文大小，仅当对话不超过 3 条消息时采用，避免恢复的会话把它撑大（拿不到时 65k），20k 是摘要和重新注入文件的余量。

两者合成一个阈值：`need = max(floorPct x window, (baseline + 20k) / maxPostRatio)`。

默认值、基线 65k 时，`(65k + 20k) / 0.55 = 154.5k`。1M 窗口下是 15.5%，和 15% 的下限基本一致；200k 窗口下是 77%，所以小窗口里工具基本关闭，由 auto-compact 负责。插件不按窗口缩放门槛。

压后比例规则的原因：压缩后实际剩余约 80k（实测中位数），压一个 100k 的上下文几乎省不了什么，还要付摘要的钱。

### 成本模型

相对输入单价：cache read 0.1 倍、1 小时 cache write 2 倍、output 5 倍。一次压缩约 `0.1 x C + 105k` 输入当量，`C` 是上下文大小，105k 是生成摘要加重新缓存剩余约 80k 的估计值。之后每次调用节省 `0.1 x (C - 80k)`。

| 压缩前 | 压缩成本 | 每次调用节省 | 回本 |
| --- | --- | --- | --- |
| 150k | 120k | 7k | 约 17 次 |
| 200k | 125k | 12k | 约 10 次 |
| 300k | 135k | 22k | 约 6 次 |

在测量的环境里，一次压缩 30-55 秒。模型是估计值，`log.jsonl` 记录压缩前后占比，可以用自己的会话核对。

## 分层

| 占比 | 行为 |
| --- | --- |
| 低于下限 | 插件拒绝 |
| 15-20% | 只在大阶段交接时压，且下一阶段明显够长 |
| 20% 及以上 | 任何干净节点 |
| 30% 及以上 | 开始提醒，之后每涨 5% 一次 |
| 40% 及以上 | 提醒措辞升级：在下一个安全步骤压 |

分层写在工具描述里，Claude 每轮都看得到。只有下限由机制强制。提醒起点取 `max(nudgeStartPct, floorPct)`，避免在下限以下提醒。

## 节点与反节点

好节点，按 214 次压缩中的频次：

1. 一个单元收尾、新需求开始：最后的工具是 commit+push 验证、合并确认、消息已发或 ticket 更新；有完成总结；没有在跑的 agent。
2. 状态刚落盘（交接文件、memory、skill）并已 push。
3. 换话题：用户提出不相关的新需求。
4. 阶段交接：spec 或 plan 已写完、下一步已点名、MR 已创建。
5. 委派出去进入等待，前提是 `pending` 里列出每个在跑的任务和它的回报方式。
6. 用户说压缩、继续或下一个。

反节点，压了损失最大：

- 有问题在等用户回答。
- 草稿在等用户说"发"。
- 用户刚纠正或给了新权限，还没写进交接单。
- 轮询、重试、编辑、调试循环中间。
- API 刚报错。
- 在等手动登录或弹窗。
- 后台 agent 的结果已到但还没读。

插件只机械检查一个反节点：最后一次工具调用是 `AskUserQuestion`。其余靠 Claude 判断，依据是工具描述。

## 交接单

`compact_now` 接收 `node`、`objective`、`standing_orders`（用户的规则，原话）、`decisions`（含原因）、`artifacts`、`pending`（每个在跑的任务及回报方式）、`done`、`next`，以及可选的 `drop`。缺必填字段则拒绝并指出缺哪项。

插件把交接单渲染成 markdown，附上用户最近 5 条真实消息（过滤命令、系统提醒、任务通知），写入 `handoff-<n>.md`，再加一段固定前言作为压缩指令发出：要求 summarizer 原样保留常驻规则、列全待处理项、以 `next` 收尾。

指令上限 8,000 字符。截断顺序：`done`，再是最早的用户消息，再是 `drop`、`decisions`、`artifacts`（从末尾）。`standing_orders`、`pending`、`next` 永不截。

## 竞态

| 情况 | 行为 |
| --- | --- |
| 排队后用户发了新消息 | 压缩仍在该轮结束后执行。丢弃 `next`，续接消息只说明已压缩。 |
| auto-compact 抢先 | 丢弃请求，仍发续接消息。 |
| 本轮或压缩过程中按了 Esc | 丢弃请求，不发续接消息。压缩中的 Esc 靠 abort、interrupt、cancel 这类错误文本识别。 |
| 排队后又调了超过 3 次其他工具 | 交接单过期：丢弃，并告知 Claude 用最新状态重新调用。 |
| `/goal` 这类 Stop hook 让本轮一直开着 | 插件让本轮结束以便执行排队的压缩；一次强制结束失败后停止强制，直到自然结束。 默认关闭该释放，因为 Team/Enterprise 登录和托管机器上 Claude Code 内置 guard（`cc-plugin-sec-default`）会跳过用户 mod 的 Stop hook；`releaseStopHooks` 仅在个人环境有效。 || 压缩被跳过或抛错 | 每 2 秒重试，最多 5 次，下一个主轮结束再试一次，仍失败则放弃，弹 toast，并在 Claude 的下一个工具结果或 prompt 里附上说明。 |
| 压缩被跳过或抛错 | 每 2 秒重试，最多 5 次，下一个主轮结束再试一次，仍失败则放弃，弹 toast，并在 Claude 的下一个工具结果或 prompt 里附上说明。 |
| subagent、`-p`、SDK、定时任务 | 拒绝，不提醒。 |

`compact_now` 不等待压缩完成。引擎拒绝在轮次进行中调用 compact，所以 handler 只做门槛检查、落盘、排队、返回。

## 为什么用原生 summarizer

缩小上下文有两条路：让内置 summarizer 带着更好的指令来做，或者自己用别处写好的摘要替换历史。self-compact 走第一条。

- 原生路径保留 Claude Code 在压缩周围已有的一切：重新注入的文件、hooks、会话记账。
- Claude 的交接单作为指令输入，摘要由能看到整段对话的模型来写。
- 不需要 API key、第二个模型或网络请求。

代价是时间：每次 30-55 秒。如果这成为瓶颈，替换历史是下一步要评估的方向，0.1 版不做。

压缩后的上下文由续接消息承载（常驻规则和待处理项原文）。曾考虑 `source: compact` 的 `SessionStart` 注入，最后没有采用：续接消息已经带了这两项，第二份只会多耗 token。

## 提醒

主会话每一步读用量。用量越过提醒起点后，每再涨 `nudgeStepPct` 提醒一次：一行带当前占比的话，附在下一个文本工具结果上，若先来的是 prompt，则附在该 prompt 的上下文里。越过 `urgentPct` 立即升级。有请求排队或正在压缩时、subagent 中、非交互会话中、插件关闭时都不提醒。漏掉提醒可以接受：40% 以上仍有 auto-compact 兜底。

## 自主触发

实测表明，只靠工具描述，压缩从不会被触发：Claude 做完两阶段任务的第一阶段就继续往下走了。用户的要求是再也不用提压缩，所以触发由插件负责，判断仍交给 Claude。三个触发点都受 `autoNodes` 控制，沿用同一道门槛，且在 subagent、非交互会话、请求排队或压缩中、插件关闭时都不触发。

**节点信号。** `detectNode(tool, input, result)` 是纯函数，输入是主会话里一次已完成且无错误的工具调用。强信号：`git push`、PR/MR 创建或合并、`git tag`、写入 `specs/` 或 `plans/` 下的 markdown、写入名为 `HANDOFF*`/`handoff*` 的文件、待办全部完成。弱信号：`git commit`、新建 `.md`、后台 agent 启动。

**回合中标记。** 门槛通过、无排队请求，且信号为强或上下文不低于 `floorPct + 5` 时，在该工具的文本结果上附一行（否则附在下一个 prompt 的上下文里）：点明节点、给出上下文占比，并告诉 Claude 若阶段已收尾且没有在等用户回答，就在本轮结束前调用 `compact_now`。每回合一条。

**回合末自检。** 让整个流程全自动的兜底。主会话 `turn.complete` 时（未中止、交互式、门槛通过、无排队请求），检查本轮是否出现节点信号而没调用 `compact_now`，或上下文已到 `nudgeStartPct` 以上仍未压缩。以 `AskUserQuestion` 或末尾问号结束的回合跳过。每种节点每涨 5 个百分点最多自检一次，两次自检之间没有工具活动则不连续自检。经过常规 1.5 秒防抖并空闲后，插件提交一条 prompt：阶段已收尾就调用 `compact_now`（若之后没有可自动继续的工作，`next` 写怎么处理用户最新一条消息，或一句收尾小结），否则回复「不压」。日志记录 `self-check`，下一个回合再记 `self-check:compacted` 或 `self-check:declined`。`turnEndCheck=false` 只关闭这一项。

**换话题提示。** 人工输入（composer 或 bridge）的 prompt，门槛通过、无排队请求且上下文不低于 `floorPct + 5` 时，给模型加一行：若新需求无关，先调用 `compact_now`，`next` 写这条需求的要点。

每次成功压缩都以续接 prompt 收尾，无论是在阶段结束时请求，还是在对话中途请求，工作总会继续。

## 数据

`~/.claude/self-compact/<session-id>/handoff-<n>.md` 和 `~/.claude/self-compact/log.jsonl`。mods 不能 import `node:fs`，文件通过引擎的 `$.fs` 读写。数据不离开本机，插件不发起网络请求。

超过约 2 MB 时，`log.jsonl` 会移到 `log.1.jsonl`，另起新文件；读不出来的日志原样保留，不会被覆盖。

`log.jsonl` 每次请求一行 JSON：`ts`、`session`、`node`、`pct`（请求时占比）、`result`（`queued`、`denied:<原因>`、`done`、`preempted`、`aborted`、`stale`、`failed`、`error`）、可选的 `reason`、`beforePct`、`afterPct`、`durationMs`。

## 语言

用户和模型会读到的所有文字都来自 `register.ts` 里的一张表，由 `language` 选项选择：`en`（默认）或 `zh`，其他值按 `en` 处理。范围包括工具描述及字段说明、拒绝原因、排队结果、过期提示、提醒、状态栏、toast、失败说明、压缩指令前言、交接单小节标题和续接消息。用户提供的交接单内容不翻译。

## 致谢

设计借鉴了社区已有方案的思想，没有复制代码：门槛加判断的两层结构、轮末执行、压缩前复查、Stop hook 放行（StevenLi-phoenix 的 self-compact）；固定的交接分段、用户原话原样保留、提醒附在工具结果上（rezzminator 的 forward-compaction）；每条线只问一次（dtinth 的 polite-compaction）。实现是净室重写。
