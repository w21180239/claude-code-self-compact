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

`tokens < floor` 时插件拒绝调用。各档都由 P（学到的压后大小）和下文成本模型的回本公式推出：

- floor = `max(C(floorCalls), floorPct x window)`，默认 `floorCalls` 20、`floorPct` 0
- node = `C(nodeCalls)`，`nodeCalls` 10
- work = `C(workCalls)`，`workCalls` 8
- urgent = `min(urgentK x 1k, 0.8 x limit)`，`urgentK` 350；limit 是引擎的自动压缩点（`autoCompactWindow`，未设则为窗口）。显示的百分比都按模型窗口算，与状态栏一致

floor、node、work 都被 urgent 截顶，所以小窗口里各档向紧急档收拢，工具仍能打开。截顶之后每一档再抬到至少 `P + 25k`（`MIN_GAIN_K`），保证一次压缩至少释放 25k，压完不会立刻再触发某一档。低于下限拒绝；下限到节点档只放行大阶段交接；节点档起任何干净节点都可压；紧急档起提醒要求在下一个安全步骤压。

`tokens` 取引擎对本会话上下文的读数（`$.session.usage()`），即最新一条 assistant 消息上的 usage。Anthropic API 在流开头的 `message_start` 事件里就给出输入 token 数；部分 Anthropic 兼容网关在那里给 0，真实数字只放在结尾的 `message_delta` 里，经 OpenCode Go 接入的 DeepSeek 就是如此。引擎收到 `message_delta` 时会把修正后的 usage 写回，所以 transcript 和之后的轮次都正确；但响应仍在流式输出时发起的工具调用读到的是全 0 的快照，引擎因此不给 tokens。这时门槛退回用最近一次主轮请求的 usage 总量，插件本来就在每个 `turn.step` 读这份数据。这个总量比实时上下文落后一次请求（它的输出和工具结果），所以兜底只会偏向拒绝。usage 全为 0 的 step 不更新兜底值。主会话的任何压缩（插件自己的、auto-compact、`/compact`）都会把兜底值换成压缩结果报告的大小，没有报告就清空；会话边界也会清空，避免压缩前的旧尺寸混过门槛。

### 成本模型

相对输入单价：cache read 0.1 倍、1 小时 cache write 2 倍、output 5 倍。一次压缩约 `F + 0.1 x C`（输入 token 当量），`F` 即 `compactCostK`（默认 105k，生成摘要加重新缓存的保守固定估计），`0.1 x C` 是读被压缩上下文的 cache read。不压缩则之后每次调用多花 `0.1 x (C - P)`，`C` 是当前上下文，`P` 是压后大小。`N` 次调用内回本的条件是 `N x 0.1 x (C - P) >= F + 0.1 x C`：

`C(N) = (10 x F + N x P) / (N - 1)`

| P | C(8) | C(10) | C(20) |
| --- | --- | --- | --- |
| 65k | 224k | 189k | 124k |
| 87k | 249k | 213k | 147k |
| 120k | 287k | 250k | 182k |

**学习 P。** 每次压缩后的第一个主轮请求测得真实压后大小（`log.jsonl` 的 `pSample`；`afterPct` 是压缩上报的摘要大小，不是下一个请求的大小）。`~/.claude/self-compact/profile.json` 按项目和全局各存一份指数加权平均（alpha 0.3）。与均值相差超过 50% 的样本是离群点，以 alpha 0.1 更新；同方向连续 3 个离群点把均值重置为它们的平均（n = 3）。n >= 3 才被信任。回退顺序：本会话样本、项目估计、全局估计、会话基线 + 25k（基线未知取 65k，即 90k）。工具只在会话开始时注册一次；`tool.describe` 钩子按当前 P 渲染描述，分层以 tokens 表示，每学到一个样本就让缓存的描述失效。引擎在下一次压缩时发送新文本，所以描述比 P 滞后一次压缩，prompt cache 得以保留（不设 `breakPromptCache`）。

**重型环境。** 截顶前 `C(workCalls)` 不低于 `urgentK` 时，说明环境（MCP、skill）很重，压缩收益很小。插件每个会话提示 Claude 一次，建议精简 MCP 服务或 skill。

在测量的环境里，一次压缩 30-55 秒。模型是估计值，`log.jsonl` 记录各项大小，可以用自己的会话核对。

## 分层

| 大小 | 行为 |
| --- | --- |
| 低于下限 `C(floorCalls)` | 插件拒绝 |
| 下限到节点档 `C(nodeCalls)` | 只在大阶段交接时压，且下一阶段明显够长 |
| 节点档及以上 | 任何干净节点 |
| 节点档及以上，之后每涨 `nudgeStepPct` | 提醒 |
| 紧急档及以上 | 提醒措辞升级：在下一个安全步骤压 |

分层写在工具描述里，Claude 每轮都看得到。只有下限由机制强制。提醒起点取 `max(node, floor)`，避免在下限以下提醒。

## 节点与反节点

好节点，按 214 次压缩中的频次：

1. 一整块工作收尾：最后的工具是 commit+push 验证、合并确认、测试通过、消息已发或 ticket 更新；有完成总结；没有在跑的 agent。即使没有这些工具信号，主会话一轮里有 2 次以上工具调用也算——历史里的工作块大多是这个形状。
2. 状态刚落盘（交接文件、memory、skill）并已 push。
3. 换话题：用户提出不相关的新需求，或隔了一阵重新接着做。
4. 阶段交接：spec 或 plan 已写完、下一步已点名、MR 已创建。
5. 子代理返回，或委派出去进入等待，前提是 `pending` 里列出每个在跑的任务和它的回报方式。
6. 成果已落盘、交给用户审阅或确认，`pending` 写明在等用户看什么。
7. 用户说压缩、继续或下一个。

反节点，压了损失最大：

- 有个问题等用户回答，而且答案决定下一步怎么做。
- 外发草稿在等用户说"发"。
- 用户刚纠正或给了新权限，还没写进交接单。
- 轮询、重试、编辑、调试循环中间。
- API 刚报错。
- 在等手动登录或弹窗。
- 后台 agent 的结果已到但还没读。

插件只机械检查一个反节点：最后一次工具调用是 `AskUserQuestion`。其余靠 Claude 判断，依据是工具描述。

## 交接单

`compact_now` 接收 `node`、`objective`、`standing_orders`（用户的规则，原话）、`decisions`（含原因）、`artifacts`、`pending`（每个在跑的任务及回报方式）、`done`、`next`，以及可选的 `drop` 和 `lessons`（试过不行的做法及原因，免得重试）。缺必填字段则拒绝并指出缺哪项。

插件把交接单渲染成 markdown，附上本会话用户最初的需求和最近 5 条真实消息（过滤命令、系统提醒、任务通知），写入 `handoff-<n>.md`，再加一段固定前言作为压缩指令发出。前言要求 summarizer 原样保留常驻规则、列全待处理项、以 `next` 收尾；并点名哪些要原样照抄（带行号的文件路径、函数签名和关键代码行、报错原文、数值和 ID、最初的需求及目标的变化），哪些可以丢（结论已写明的日志、重复读取、得出结论的逐步过程、走不通的路只留教训）。

最初的需求取第一条真实用户消息，上限 1,500 字符，在首次 `compact_now` 时存进 `<session-id>/intent.md`，之后都读这份存档：压缩过后引擎返回的 transcript 从摘要开始，每压一代，摘要都会把原意再转述走样一点。它仍在最近 5 条里时不重复附。

指令上限 8,000 字符。截断顺序：`done`，再是最早的用户消息，再是 `drop`、`lessons`、最初的需求、`decisions`、`artifacts`（从末尾）。`standing_orders`、`pending`、`next`、语言约定和热 skill 那一句永不截。

## 语言约定

用户用一种语言聊天，却要求代码、commit、PR、spec 和对外文字用别的语言，压缩时这个划分会丢：摘要用英文写，规则只是众多条目里的一条。所以 `compact_now` 有 `language` 字段，`{ chat, outputs[] }`：schema 里必填，校验时可选（格式不对按缺失处理，缺失永不阻止压缩）。

`mergeLanguage(prev, given, detected)` 逐字段合并：本次给的非空值优先，其次是上一次压缩的，`chat` 最后回落到 `detectChatLang`，即最近 5 条真实用户消息里 CJK 字符占非空白字符 >= 30% 记 `zh`，否则 `en`，空输入返回 undefined，并按配置的界面语言写成语言名。`source` 记录 `chat` 的来源（`tool`、`inherited`、`detected`、`none`），在 `queued` 和 `done` 行里记为 `langSource`。插件自己提交的提示（续接消息、自检、提醒）不参与检测，也不进“最近消息”；续接消息前面多了语言行时仍能识别。合并后的约定存在会话状态里，每次压缩都保留；`resetConversation` 与其他按会话的状态一起清除（新会话、`/clear`、`/resume`）。

四个载体让约定存活：交接文件（第一节“语言约定”）；压缩指令（一句话要求 summarizer 用对话语言写摘要、第一节是这一节、每条输出规则原样照抄，不受 8,000 字符上限截断）；续接消息的第一行；压缩后前 3 条真实用户提示（composer 或 bridge 来源，不含命令和插件提示）的上下文里各附一行简短约定。

漂移检查：压缩后第一条非空的主会话助手回答（`turn.complete.answer`，该轮最终可见文字）按同样的 CJK 规则分类；与对话语言的类别（对话规则里先提到的中文或英文）不同时记一行 `lang-drift`，带 `expected` 和 `got`，每次压缩只记一次。只调用工具的轮次回答为空，跳过直到出现文字。

## skill 工作集

压缩之后，引擎会自己把每个调用过的 skill 的完整正文重新注入（`invoked_skills` 附件，未见截断）。mod 看不到也改不了：托管登录会跳过用户 mod 的 `prompt.attachment` 和 `skill.prompt` 钩子。所以插件不改写这一步重新注入，只用 `tool.call`。压缩丢掉的是 skill 的工作集：在 skill 目录下读过的参考文件，以及工作做到流程的哪一步。压缩后的重读集中在这些参考文件上。

**记录。** 按 skill 名存会话状态（名字取 `Skill` 调用时的写法；短名是最后一个冒号之后的部分，用来匹配路径）。主会话的 `Skill` 调用记下名字和当前主请求序号（`state.reqs`，每个主 `turn.step` 加一）。主会话 Read、Grep、Glob、Edit、Write 的路径，或 Bash 命令里的路径样 token，含 `/skills/<短名>/` 时更新 `lastUse`；不是该目录的 `SKILL.md` 也不是目录的话，移到 `refs` 最前（最多 8 个，去重）。路径先按词法规范化（`normalizePath`：折叠 `.`、`..`、`//`，`~` 和相对路径按 home、cwd 解析；仍然越出根的丢弃）。只有 `/skills/<短名>/` 之前的前缀下存在 `SKILL.md` 才算：用 `$.fs.stat` 在调用路径之外探测（排队保序；stat 失败即记为非 skill 目录）。两个已加载 skill 短名相同时，路径里出现名字的插件段者胜，否则归最近加载的。Bash token 先去掉末尾标点和 `:<行>[:<列>]` 后缀。带 `agentId` 的调用忽略。状态跨压缩保留，由 `resetConversation` 清除。

**分档**（`tierSkills`）。`keep_skills` 里的为热。否则在 `drop_skills` 里的为已完成：模型说这个 skill 做完了，比最近用过更优先。否则 `nowReq - lastUse <= hotWindow`，或历史 `refMisses / compactions >= 0.3` 且 `compactions >= 3`，为热。其余不处理。`keep_skills` 和 `drop_skills` 是可选的字符串数组（全名或短名都行），格式不对按没给处理。

**载体。** 压缩指令多一句不会被截断的话，点出热 skill，要求 summarizer 为每个写明走到哪一步、还剩什么。续接消息在语言行和 `next` 之后多一节「skill 工作集」（`renderSkillSection`）：每个热 skill 一行 `<名字>：仍在使用` 加它的参考文件，大小不超过 `refInlineK` 千 token（每 token 按 4 字符）且累计不超过 `skillBudgetK` 的用 `$.fs` 读出内联，其余只列路径（读失败也只列路径）。读之前先 `$.fs.stat` 定大小，超过 `refInlineK` 的文件从不读取；按新近顺序依次读，预算用完即停；只有 `realPath` 仍在 skill 目录自身的真实根内、且含 `/skills/<短名>/` 才读，否则只列路径。指令那一句最多点 8 个热 skill（`等另 N 个`）；每个已完成 skill 一行。没有热也没有已完成的 skill 时整节省略。

**学习。** 每次压缩（无论是插件发起还是自动/手动）给 `profile.json` 里每个已加载的 skill 的 `compactions` 加一（`skills: { <名字>: { compactions, refMisses } }`，写法同 P）。之后 30 个主请求内，主会话 Read 了没内联的参考文件，该 skill 的 `refMisses` 加一（每个文件一次）并记 `skill-ref-miss`；Read 已内联的文件记 `skill-ref-reread`。`done` 和 `preempted` 行带 `skills: { hot, done, inlinedK, listed }`。

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

压缩后的上下文由续接消息承载（常驻规则和待处理项原文）。续接消息最后一行给出本会话 transcript 的位置（`~/.claude/projects/*/<session-id>.jsonl`），要求 Claude 需要报错原文、数值、路径或命令时去 grep，不要猜也不要重做。这句话必须明说：billion-context 的试点发现，模型只有被明确要求时才会回查压缩掉的内容。插件自己从不读 transcript。曾考虑 `source: compact` 的 `SessionStart` 注入，最后没有采用：续接消息已经带了这两项，第二份只会多耗 token。

## 提醒

主会话每一步读用量。用量越过提醒起点后，每再涨 `nudgeStepPct` 提醒一次：一行带当前占比的话，附在下一个文本工具结果上，若先来的是 prompt，则附在该 prompt 的上下文里。越过紧急档立即升级。有请求排队或正在压缩时、subagent 中、非交互会话中、插件关闭时都不提醒。漏掉提醒可以接受：紧急档以上仍有 auto-compact 兜底。

## 自主触发

实测表明，只靠工具描述，压缩从不会被触发：Claude 做完两阶段任务的第一阶段就继续往下走了。用户的要求是再也不用提压缩，所以触发由插件负责，判断仍交给 Claude。三个触发点都受 `autoNodes` 控制，沿用同一道门槛，且在 subagent、非交互会话、请求排队或压缩中、插件关闭时都不触发。

**节点信号。** `detectNode(tool, input, result)` 是纯函数，输入是主会话里一次已完成且无错误的工具调用。强信号：`git push`、`git merge`、PR/MR 创建、评审、评论、关闭或合并、`gh issue comment`/`close`、`git tag`、通过 `gog`、`agent-slack`、`slack`、`outlook` 对外发消息（`send`、`reply`、`post`）、写入 `specs/` 或 `plans/` 下的 markdown、写入名为 `HANDOFF*`/`handoff*` 的文件、待办全部完成。弱信号：`git commit`、测试通过（`npm/pnpm/yarn/bun test`、`pytest`、`go test`、`cargo test`、`dotnet test`、`mvn`、`gradle`、`make test`/`check`）、新建 `.md`、后台 agent 启动、前台子代理返回。

**回合中标记。** 门槛通过、无排队请求，且信号为强，或信号为弱且上下文不低于节点档时，在该工具的文本结果上附一行（否则附在下一个 prompt 的上下文里）：点明节点、给出上下文占比，并告诉 Claude 若阶段已收尾且没有在等用户回答，就在本轮结束前调用 `compact_now`。每回合一条。

**回合末自检。** 让整个流程全自动的兜底。主会话 `turn.complete` 时（未中止、交互式、门槛通过、无排队请求），按顺序检查：本轮是否出现节点信号；这一轮是否做了实活（主会话至少 `WORK_TURN_MIN_CALLS = 2` 次工具调用）且上下文不低于实活档 `C(workCalls)`；或上下文已到节点档以上仍未压缩。强节点信号要求到下限，弱信号要求到节点档。只有 `AskUserQuestion` 会抑制自检，末尾问号不会：收尾总结常常带问句，历史里的压缩正落在这些点上。每个触发点每涨 5 个百分点最多自检一次，两次自检之间没有工具活动则不连续自检。经过常规 1.5 秒防抖并空闲后，插件提交一条 prompt：阶段已收尾就调用 `compact_now`（若之后没有可自动继续的工作，`next` 写怎么处理用户最新一条消息，或一句收尾小结），否则回复 `skip: <一句理由>`。阈值只是必要条件：过线后三条都满足才压：（1）当前块已收尾；（2）接下来的工作不依赖上下文里的大段原文（正在逐行对照的 diff、刚读的长文件）；（3）剩余工作还够长，值得压一次。紧急档的提醒只保留第 1 条否决权。日志记录 `self-check`，下一个回合再记 `self-check:compacted` 或 `self-check:declined`；declined 行带 `reason`（`skip:` 之后的文字，截断到 200 字符；单独的 skip 没有 reason）。`turnEndCheck=false` 只关闭这一项。

**新工作块提示。** 人工输入（composer 或 bridge）的 prompt，只要门槛通过且无排队请求，就给模型加一行：若这条消息开启新工作块（换话题，或停顿后重新接着做）且上一块已收尾，先调用 `compact_now`，`next` 写这条需求的要点。只看换话题会漏掉停顿场景：历史里大量 `/compact` 是在一块工作收尾之后、下一条指令之前手动敲的。

每次成功压缩都以续接 prompt 收尾，无论是在阶段结束时请求，还是在对话中途请求，工作总会继续；唯一的例外是退出前的那次压缩。

**退出时压缩。** `/exit` 表示这个会话之后还会 resume；直接关窗口则相反，进程收到 SIGHUP 结束（`session.end` 的 reason 为 `other`）。`session.end` 给所有 hook 合计 1.5 秒，不够做一次压缩，所以插件提前一步：`command.run` 挂在 `exit` 上（别名已解析，`/quit` 也算），来自 composer 或 bridge、会话空闲、无排队请求且门槛通过时，hook 代替命令作答（不退出），并通过定时器提交一条退出自检，要求调用 `compact_now`，写好给 resume 用的交接单。压缩照常执行；本该发续接的地方，改由定时器调用 `$.command.run({ command: 'exit' })`（在回合等待的 hook 里这个调用会被拒绝），插件自己发出的 `/exit` 直接放行。自检文案直接说明 skip 也会压缩：实测中模型把之前的「先别压缩」排在一条自称代表用户的插件消息之前，这样做是对的，所以插件不去争辩。自检被拒绝、调用被 deny 或提交失败时，插件在 1.5 秒防抖后自己调用 `$.session.compact`，用通用的 resume 指令（`exitInstructions` 加语言行），然后退出：`/exit` 是用户本人的操作，和敲 `/compact` 一样。重试耗尽放弃（没有下一回合可等，重试用完即结束）、兜底压缩失败，也都会退出；在自检或压缩期间按 Esc、或输入新消息，则取消退出；再输一次 `/exit` 立即退出。Ctrl+C 和 Ctrl+D 不经过命令就结束会话，所以照常退出。`exitCompact=false` 关闭此功能。

## 数据

`~/.claude/self-compact/<session-id>/handoff-<n>.md`、`~/.claude/self-compact/<session-id>/intent.md`、`~/.claude/self-compact/profile.json` 和 `~/.claude/self-compact/log.jsonl`。`profile.json` 存学到的压后大小 P，按项目（以 cwd 绝对路径为键）和全局各一份，另有 `skills`：按 skill 名记录加载它的压缩次数和漏读次数；`log.jsonl` 的行可带 `pSample` 和 `p`，`result` 还有 `p-sample`、`deprecated`、`tool-describe`。mods 不能 import `node:fs`，文件通过引擎的 `$.fs` 读写。数据不离开本机，插件不发起网络请求。

超过约 2 MB 时，`log.jsonl` 会移到 `log.1.jsonl`，另起新文件；读不出来的日志原样保留，不会被覆盖。

`log.jsonl` 每次请求一行 JSON：`ts`、`session`、`node`、`pct`（请求时占比）、`result`（`queued`、`denied:<原因>`、`done`、`preempted`、`aborted`、`stale`、`failed`、`error`、`p-sample`、`deprecated`、`tool-describe`、`self-check`、`self-check:compacted`、`self-check:declined`、`lang-drift`、`skill-ref-miss`、`skill-ref-reread`）、可选的 `reason`（`self-check:declined` 上是模型给出的跳过原因，最多 200 字符）、可选的 `pSample` 和 `p`、`langSource`（`queued`、`done`）、`expected` 和 `got`（`lang-drift`）、`beforePct`、`afterPct`、`durationMs`。

## 语言

用户和模型会读到的所有文字都来自 `register.ts` 里的一张表，由 `language` 选项选择：`en`（默认）或 `zh`，其他值按 `en` 处理。范围包括工具描述及字段说明、拒绝原因、排队结果、过期提示、提醒、状态栏、toast、失败说明、压缩指令前言、交接单小节标题和续接消息。用户提供的交接单内容不翻译。

## 致谢

设计借鉴了社区已有方案的思想，没有复制代码：门槛加判断的两层结构、轮末执行、压缩前复查、Stop hook 放行（StevenLi-phoenix 的 self-compact）；固定的交接分段、用户原话原样保留、提醒附在工具结果上（rezzminator 的 forward-compaction）；每条线只问一次（dtinth 的 polite-compaction）；摘要的保留与丢弃清单、保护最初的需求、明确的回查指引（ranxianglei 的 billion-context）。实现是净室重写。
