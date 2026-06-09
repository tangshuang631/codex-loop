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
- `app/server/lib/loop-controller.mjs`：当前承载自动循环控制、开始停止和调度执行。后续应继续瘦身为 Loop 内核的编排入口。
- `app/server/lib/loop-core/controller-gates.mjs`：自动循环闸门已经迁入 Loop 内核，负责判断是否等待 Codex、是否进入监督复盘、是否到达预算停止条件、是否允许发送下一轮。
- `app/server/lib/codex-dispatcher.mjs`：当前承载 Codex 线程发送与可见性校验。后续应归入 Codex 联动层，并继续禁止不可见兜底链路假装成功。
- `app/server/lib/codex-session-reader.mjs`：当前承载 Codex 历史读取和聊天镜像。后续应与 dispatcher 一起收束为 Codex 联动层。
- `app/server/lib/ollama-prompt-generator.mjs`：当前承载本地模型生成、Codex 摘要和里程碑复盘。后续应归入 NPC 决策层。
- `app/server/lib/ollama-loop-planner.mjs`：当前承载创建 loop 时的规划增强。后续应与 NPC 决策层共享项目记忆和用户规则。
- `app/server/lib/verification/supervisor-verification.mjs`：监督独立验收已经迁入验证层，负责安全命令过滤、验收冷却、结果摘要和失败/跳过证据注入下一轮指令。
- `app/server/lib/launcher-status.mjs`、`remote-access.mjs`、`paths.mjs`：当前承载启动、远程访问、路径解析等治理能力。后续应归入运行治理层。
- `app/web/src/App.jsx`、`app/web/src/runtime-events.mjs`、`app/web/src/styles.css`：当前承载产品界面层。这里应该只展示用户需要的状态、对话和操作，不暴露内部模块名。

## 迁移规则

- 不得为了目录好看而搬家。只有当正在修的功能已经有测试，并且拆分能降低风险时，才迁移边界。
- 每次只迁移一条已测试的能力边界。例如先抽出停止条件判断，再抽出验证命令执行，不把 runtime-store 一次性拆空。
- 新模块必须有明确输入输出。调用方不应该需要阅读模块内部才能知道它做什么。
- 迁移后 UI 不得展示工程模块名。结构优化服务于稳定性，不服务于开发者味信息展示。
- 任何调度、发送、验证、停止相关迁移，都必须跑 `npm test`，并在涉及前端显示时跑 `npm run build:web`。

## 近期拆分优先级

1. 继续扩展 `app/server/lib/loop-core/controller-gates.mjs`，把更多停止条件、失败分类和恢复策略收束为可单测的 Loop 内核判断模块。
2. 继续扩展 `app/server/lib/verification/supervisor-verification.mjs`，把更多测试、构建、日志、截图验收能力收束进验证层。
3. 把 NPC 复盘、用户补充合并、项目规则读取收束到 NPC 决策层。
4. 把 Codex 发送、历史读取、可见性校验收束为 Codex 联动层统一接口。
5. 把启动残留状态、日志可读化、关闭服务、远程访问收束为运行治理层。

## 完成判断

当一个能力迁移完成时，必须同时满足：

- 行为测试覆盖原有能力和关键异常路径。
- 真实运行日志仍能解释失败原因。
- 前端仍保持中文、简洁、用户视角。
- loop 不会因为模块拆分而在 Codex 未完成时追发消息。
- 停止条件、预算、用户补充和验证失败仍然能阻止下一轮派发。
