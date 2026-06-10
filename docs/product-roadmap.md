# codex_loop Product Roadmap

## Current priority

The current top priority is the core local loop business:

- stable runtime state
- Codex thread continuity
- strict project adapters
- user-tunable loop details
- graceful stop and finalize
- concise local console
- strong error handling without UI lockup

## 企业级 loop 软件目标

`codex_loop` 的目标不是更强模型的包装层，而是把 AI 编程任务变成可执行、可验证、可停止、可追溯的工程闭环。详细原则见 `docs/loop-engineering-principles.md`。

后续路线图按这个顺序判断优先级：

- loop 内核稳定：状态机、等待策略、预算、停止、恢复和错误分类必须可靠。
- Codex 联动真实：绑定线程、发送指令、聊天镜像和完成状态识别必须可验证。
- NPC 决策可信：Ollama / 本地模型必须基于项目文档、用户规则和 Codex 最新回复生成下一步。
- 验证反馈闭环：测试、构建、日志、截图或人工验收结果必须回到 loop 状态。
- 用户界面减噪：首页只展示状态、对话和必要操作，解释性内容进入帮助页或文档。
- 长期运行治理：失败要可读、可恢复、可停止，不允许假装发送成功或盲目续跑。

## 企业级成熟度里程碑

后续进度不按“prompt 写得更聪明”判断，而按 loop 是否更可靠判断。优先建设 loop，而不是堆 prompt。

- P0 可运行闭环：用户能新建任务、绑定线程、开始循环、停止收尾，并在控制台看到 Codex 回复和 codex-loop 指令。
- P1 可控闭环：系统能识别 Codex 是否仍在工作，用户补充会排队等待当前轮完成，停止条件和预算会阻止下一轮派发。
- P2 可验证闭环：NPC 会结合项目文档、用户规则和 Codex 最新回复生成下一步；测试、构建、日志或截图验收能写回状态。
- P3 可长期监控闭环：运行日志可读，失败可恢复，移动端可查看当前状态和历史，用户能远程补充下一轮引导。
- P4 企业级治理闭环：多项目多 loop 稳定运行，角色规则可定制，权限边界可审计，长期任务有成本、失败率和质量趋势。

## Task-first product model

The product language should move from "create a loop" to "新建任务". A task can run an automatic loop, but it can also stay in 监控模式. In 监控模式, the user can bind a Codex window, watch the mirrored conversation, and 发送引导 without starting automation.

Required behavior:

- 新建任务 must first describe the user goal and target project, then optionally configure loop behavior.
- 不开始循环 must not make the task useless; it should still monitor Codex and allow guidance messages.
- 发送引导 while Codex is working must wait until Codex can accept the next turn, then merge the guidance through the NPC workflow.
- Binding should prefer 项目路径 + Codex 窗口名. Manual thread ID is only a fallback when automatic matching is unclear.

Current implementation progress:

- local runtime state is in place
- thread mirror and summary export are in place
- strict adapter model is in place
- manual heartbeat and thread sync inputs are in place
- project scaffolding is being added to speed up reuse
- quick thread binding helpers are being added to speed up real-project setup
- template-driven loop setup is being formalized
- loop renaming support is being added
- monitor-mode manual guidance sending is in place: a stopped bound task can send the queued guidance once without starting automatic looping.
- paired mobile guidance now uses the same monitor-mode one-shot path when it is safe to send; if Codex is still working or the local supervisor is reviewing, the guidance stays queued and the mobile UI shows the wait reason.
- queued mobile guidance can be edited or recalled before it is merged, so remote guidance remains reversible when the user mistypes or changes direction.

## Near-term roadmap

1. strengthen Codex thread linkage and transcript mirror
2. improve adapter-driven strict defaults for different repositories
3. keep the local console fast, simple, and reliable
4. improve startup resilience and recovery messaging
5. formalize template-driven project loop setup
6. evaluate optional ccswitch-assisted telemetry enrichments
7. keep loop differentiation clearly stronger than native Codex automations

## Later roadmap

Later enhancements can broaden adoption, but they should not distract from the core loop:

- mobile-readable status page
- summarized Codex history viewing from phone
- optional remote read-only access
- richer adapter management

Current foundation for that direction:

- local summary export payload
- thread mirror metadata
- transcript mirror for fuller local recovery

## Template-driven setup direction

An important product direction is:

- provide a detailed loop template
- provide a clear usage guide
- let the developer hand both to an AI
- let the AI fill the template from the actual repository context
- turn that filled template into one concrete loop

This should make `codex_loop` more reusable and easier to adopt across different repositories.

## Mobile direction

Mobile support is valuable because it helps users check progress away from the desk.

Mobile is now part of the production monitoring target. It should be treated as a 移动端 App experience, not just a small responsive web page.

The correct ordering is:

1. make the core loop trustworthy
2. make Codex linkage feel seamless
3. add lightweight phone access for status and summaries

The first mobile App capability should be:

- history conversation
- current task state
- send-guidance composer
- safe by default
- consistent with the web task detail content

Not:

- destructive actions
- replacing the desktop Codex workflow

Phone pairing requirement:

- First connection should use 扫码 from the desktop console.
- The scan creates a 长期绑定 between the mobile App and that workstation's codex-loop service identity.
- After codex-loop restarts on the same computer, the same mobile App should reconnect without requiring another scan.
- If the token is revoked or the machine identity changes, the App must ask the user to scan again.

Current mobile boundary:

- 扫码长期绑定基础已接入：桌面控制台可以生成配对会话，后端可以确认配对并校验长期设备令牌。
- 受保护移动端任务视图已接入：已绑定设备携带长期设备令牌才能读取任务状态和历史对话，令牌失效或设备未绑定时必须重新扫码。
- `/mobile` 轻量移动端任务界面已接入：手机可以查看当前任务、历史对话，并发送引导；安全可发送时会复用监控模式手动派发链路推进一次，Codex 正在处理或本地模型复盘时只排队等待。待合并引导在真正合并前可从手机端编辑或撤回。
- 监控模式手动发送引导已接入：桌面端可以先保存补充，再从待发送气泡手动派发一次；移动端已绑定设备也可触发同一条一次性派发链路，二者都不会启动自动循环。
- 自动窗口绑定基础已接入：绑定时可优先填写项目路径和 Codex 窗口名，系统会从本机 Codex 历史里自动匹配线程；匹配不唯一或失败时再手动填写线程 ID。
- 独立 `app/mobile` 移动端 App/PWA 壳已接入：它复用 `/mobile` 的任务详情数据和交互，只保留历史对话、当前状态、待合并引导和发送引导入口。
- 原生 App 封装仍是后续阶段：后续重点是扫码体验、系统级壳、后台重连提示和设备授权管理，而不是复制桌面端后台。

## Current implementation note

The product is now moving toward a stronger middle ground:

- phone-friendly read and light control for one loop
- still local-first
- still centered on the Codex desktop thread

The preferred no-server remote path is:

- install Tailscale on the workstation
- install Tailscale on the phone
- open the local `codex_loop` web UI through the Tailnet

Why this is the current recommendation:

- no custom cloud server is required
- works outside the local LAN
- keeps the tool attached to the user's own machine
- simpler and safer than exposing raw public ports
