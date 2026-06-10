# codex-loop 企业级 Loop 架构映射

当前结构不是最终结构。现阶段优先保证真实 loop 能稳定运行，所以不会为了目录好看而搬家。后续优化项目结构时，每次只迁移一条已测试的能力边界，迁移前后都必须保留行为测试。

## 结构目标

`codex-loop` 的企业级架构围绕 6 个边界演进：

- Loop 内核：状态机、等待策略、预算、停止、恢复、错误分类。
- Codex 联动层：线程绑定、原生发送、聊天镜像、完成状态识别。
- NPC 决策层：Ollama 接入、项目规则读取、用户自定义监督员、下一轮指令生成。
- 验证层：测试命令、构建命令、截图验收、日志检查、结果回写。
- 产品界面层：简洁中文状态、Codex 风格对话、移动端查看、用户补充引导。
- 运行治理层：本地日志、可读错误、启动关闭、长期健康检查。

## 当前文件映射

当前代码仍集中在 `app/server/lib` 和 `app/web/src`。这是历史实现形态，不代表最终边界。

- `app/server/lib/runtime-store.mjs`：当前承载最多运行状态、loop 轮次、NPC 调度、验证回写和聊天镜像编排。后续应逐步拆出 Loop 内核、NPC 决策、验证层和运行治理层。
- `app/server/lib/runtime-store.mjs#sendPendingGuidanceOnce`：当前承载监控模式的一次性手动派发；它复用 NPC 合并和 Codex 发送链路，但不会启动自动循环控制器。桌面端和已配对移动端都通过这条链路推进一次。
- `app/server/lib/loop-controller.mjs`：当前承载自动循环控制、开始停止和调度执行。后续应继续瘦身为 Loop 内核的编排入口。
- `app/server/lib/loop-core/controller-gates.mjs`：自动循环闸门已经迁入 Loop 内核，负责判断是否等待 Codex、是否进入监督复盘、是否到达预算停止条件、是否允许发送下一轮。
- `app/server/lib/codex-dispatcher.mjs`：当前承载 Codex 线程发送与可见性校验。后续应归入 Codex 联动层，并继续禁止不可见兜底链路假装成功。
- `app/server/lib/codex-session-reader.mjs`：当前承载 Codex 历史读取和聊天镜像。后续应与 dispatcher 一起收束为 Codex 联动层。
- `app/server/lib/codex-link/thread-resolver.mjs`：目标模块，后续承载项目路径 + Codex 窗口名的自动匹配，只有匹配失败或存在歧义时才回退手动线程 ID。
- `app/server/lib/ollama-prompt-generator.mjs`：当前承载本地模型生成、Codex 摘要和里程碑复盘。后续应归入 NPC 决策层。
- `app/server/lib/ollama-loop-planner.mjs`：当前承载创建任务时的规划增强。后续应与 NPC 决策层共享项目记忆和用户规则。
- `app/server/lib/npc/confirmation-policy.mjs`：NPC 普通确认策略已经迁入决策层，用于区分普通产品偏好和高风险人工确认。
- `app/server/lib/verification/supervisor-verification.mjs`：监督独立验收已经迁入验证层，负责安全命令过滤、验收冷却、结果摘要和失败/跳过证据注入下一轮指令。
- `app/server/lib/runtime-governance/failure-classifier.mjs`：续跑失败分类已经迁入运行治理层，负责把 Codex 发送、本地模型、文档规则、工作区、重复发送、预算停止等异常转成中文原因和恢复动作。
- `app/server/lib/launcher-status.mjs`、`remote-access.mjs`、`paths.mjs`：当前承载启动、远程访问、路径解析等治理能力。后续应归入运行治理层。
- `app/server/lib/runtime-governance/device-pairing.mjs`：承载移动端 App 的扫码配对、长期绑定、令牌校验和服务重启后的自动重连基础。
- `app/web/src/App.jsx`、`app/web/src/runtime-events.mjs`、`app/web/src/styles.css`：当前承载桌面产品界面层。这里应该只展示用户需要的状态、对话和操作，不暴露内部模块名；其中 `/mobile` 仍作为轻量移动端任务入口，专注历史对话、当前状态和发送引导。移动端发送引导会先保存补充，安全时触发一次监控模式派发；Codex 正在处理或本地模型复盘时只显示等待原因。待合并引导在真正合并前可从手机端编辑或撤回。
- `app/mobile`：已建立独立移动端 App/PWA 壳，复用 `/mobile` 已验证的数据和交互，只呈现历史对话、当前状态、待合并引导和发送引导，不复制桌面端全部设置。后续原生封装只在这个壳上补扫码体验、长期登录和系统级能力。

## 迁移规则

- 不得为了目录好看而搬家。只有当正在修的功能已经有测试，并且拆分能降低风险时，才迁移边界。
- 每次只迁移一条已测试的能力边界。例如先抽出停止条件判断，再抽出验证命令执行，不把 runtime-store 一次性拆空。
- 新模块必须有明确输入输出。调用方不应该需要阅读模块内部才能知道它做什么。
- 迁移后 UI 不得展示工程模块名。结构优化服务于稳定性，不服务于开发者味信息展示。
- 失败治理必须先产出用户能理解的原因和下一步动作，再把原始错误留给日志排查，不能把英文调试信息直接当成产品状态。
- 任何调度、发送、验证、停止相关迁移，都必须跑 `npm run production:check`。它是投入使用前的生产化检查入口，会覆盖环境检查、长跑 smoke 检查、`npm test`、桌面端构建、移动端构建、前端证据检查和 git 差异检查，并写入可追溯报告。前端证据检查会确认桌面端和移动端构建产物仍包含历史对话、发送引导、截图证据、生产阶段、验证目标和启动预检，并把结果写入 `runtime/frontend-evidence/`。
- 真实任务运行后要用 `npm run production:observe` 补齐真实运行观测报告。它只读 `runtime/<runId>/logs/events.jsonl`，整理发送、等待、Codex 完成、NPC 复盘、失败和停止时间线，写入 `runtime/production-observations/`，不启动循环也不向 Codex 发送消息。
- 真实运行观测至少 2 轮连续闭环才算长期运行基本证据：发送下一轮指令 -> Codex 完成 -> NPC 复盘。单轮闭环只能证明可试用，不能证明适合提高自动化时长。
- `npm run production:status` 输出生产状态摘要，统一汇总最近生产检查、前端证据、长跑节奏、真实运行观测和下一步建议。摘要必须区分 `readiness.stage`：`trial` 只能说明代码闸门通过且适合短时试用，`observing` 说明正在等待真实任务形成证据，`production` 才说明已经具备真实 2 轮闭环证据，`blocked` 则必须先修复失败项。默认超过 12 小时的报告会被视为已过期，需要重新运行 npm run production:check 后再判断是否适合长期运行。
- 当真实状态显示 Codex 已完成但缺少 NPC 监督复盘时，用 `npm run production:recover` 补齐复盘。它是安全恢复入口，只做监督复盘 backfill，不启动循环，也不发送下一轮指令。
- `npm run loop:smoke` 是 Loop 内核的本地模拟长跑检查，不触碰真实 Codex 线程。它必须证明控制器会在发送后等待 Codex、不会在 Codex 未完成时追发、用户补充会等 Codex 完成后交给 NPC 合并、会先做监督复盘再进入下一轮，能按产品经理 / 测试人员 / 真实用户视角做独立验收并遵守冷却防重复，并在预算到达后停止自动发送。

## 近期拆分优先级

1. 继续扩展 `app/server/lib/loop-core/controller-gates.mjs`，把更多停止条件、失败分类和恢复策略收束为可单测的 Loop 内核判断模块。
2. 继续扩展 `app/server/lib/verification/supervisor-verification.mjs`，把更多测试、构建、日志、截图验收能力收束进验证层。
3. 把 NPC 复盘、用户补充合并、项目规则读取收束到 NPC 决策层。
4. 把 Codex 发送、历史读取、可见性校验收束为 Codex 联动层统一接口，并补上项目路径 + 窗口名的 thread-resolver 自动绑定。
5. 继续把启动残留状态、日志可读化、关闭服务、远程访问收束为运行治理层，并扩展扫码长期绑定的撤销、轮换和审计能力。
6. 继续完善 `app/mobile` 独立移动端 App/PWA 壳；后续原生 App 封装只补系统级能力，让手机端继续专注监控模式、历史对话和发送引导。

## 产品化绑定边界

绑定能力要服务用户，而不是要求用户理解内部线程号。

- 新建任务时优先收集项目路径和 Codex 窗口名，系统根据 Codex 历史、窗口标题、工作区路径和最近活动时间自动匹配线程。
- 匹配结果唯一时直接保存绑定；匹配结果不唯一时让用户选择；匹配失败时才显示手动线程 ID 入口。
- 不开始循环时，任务进入监控模式，仍然可以同步历史、显示 Codex 状态并发送引导。
- 移动端发送引导必须遵守同一条不打断规则：安全可发送时只推进一次；Codex 正在处理或本地模型复盘时排队等待；真实发送失败要显示错误。
- 移动端编辑或撤回待合并引导也必须经过长期设备令牌校验，防止未授权设备篡改或清空用户补充。
- 移动端 App 首次连接通过扫码建立长期绑定；当前入口包括 `/mobile` 轻量页和 `app/mobile` 独立移动端 App/PWA 壳。扫码绑定的是这台电脑上的 codex-loop 服务身份，不是某一次端口或进程。
- codex-loop 服务重启后，已授权手机应通过长期绑定自动重连；用户主动撤销、密钥轮换或机器身份变化时才需要重新扫码。

## 完成判断

当一个能力迁移完成时，必须同时满足：

- 行为测试覆盖原有能力和关键异常路径。
- 真实运行日志仍能解释失败原因。
- 前端仍保持中文、简洁、用户视角。
- loop 不会因为模块拆分而在 Codex 未完成时追发消息。
- 停止条件、预算、用户补充和验证失败仍然能阻止下一轮派发。
