# codex-loop

`codex-loop` 是一个本地优先的 Codex 长任务循环控制台。

它不替代真实的 Codex 对话线程，而是把“开始循环、持续续发、健康检查、停止收尾、聊天镜像、手机查看”这些能力补齐，让长时间开发任务更像有人在稳定值守。

## 适合解决什么问题

- 运行循环后不知道有没有真的开始
- 长任务期间看不到持续状态，容易误以为卡死
- 想把续发记录留在真实的 Codex 桌面线程里
- 想同时管理多个项目、多个 loop，而不是所有东西堆在首页
- 想在手机上随时查看某个 loop 的最近进度和聊天镜像
- 想在默认模板之外，再用本地大模型把下一条续发变得更像真人接话

## 当前优势

- 真实线程优先：续发消息进入绑定的 Codex 线程，而不是隐藏在后台
- 多 loop 管理：左侧按项目分组管理 loop，右侧只聚焦当前 loop
- 中文优先：默认续发模板与前端状态都是中文优先
- 可恢复：本地保留 runtime、thread mirror、summary、events 日志
- 可控停止：支持停止后进入收尾，而不是粗暴中断
- 健康检查：能发现心跳过久未更新、续发卡住、聊天镜像过旧等问题
- 移动端友好：提供移动端查看所需的摘要与聊天记录接口
- 本地增强可选：不开启 Ollama 也能工作，开启后可提升续发质量

## 当前能力边界

- 不直接接管 Codex 官方产品内部 API
- 不承诺完全无人值守开发
- 不绕过 Git、验证、权限、人工确认这些真实开发约束
- 本地大模型增强目前优先支持 Ollama

## 运行依赖

最低要求：

- Windows
- Node.js 18 或更高版本
- npm
- 已安装并可用的 Codex CLI / Codex 桌面端工作环境

建议准备：

- Git
- 一个真实项目仓库
- 一个专门绑定给该 loop 的 Codex 对话线程

可选增强：

- [Ollama](https://ollama.com/)：用于“下一条续发消息”的本地生成增强

## 安装

1. 克隆仓库
2. 进入仓库根目录
3. 执行 `npm install`

## 启动前需要知道

仓库里的默认配置是通用模板，不绑定任何用户私有项目。

- 通用默认配置放在 `config.json`
- 机器本地配置请写入 `config.local.json`
- `config.local.json` 已被 git 忽略，不会污染开源仓库

如果你要驱动别的项目，请把本地 `workspaceRoot` 指向你自己的项目目录，而不是修改仓库内默认模板。

## 快速开始

1. 执行 `npm install`
2. 复制 `config.local.example.json` 为 `config.local.json`
3. 在 `config.local.json` 里填你自己的 `workspaceRoot`
4. 执行 `npm run loop:check`
5. 执行 `npm test`
6. 执行 `npm run build:web`
7. 执行 `start-codex-loop.bat` 或 `npm run loop:start`
8. 打开本地前端，把当前 loop 绑定到一个真实 Codex 线程
9. 在左侧创建或选择 loop，然后开始循环

## 默认模式与大模型增强

### 默认模式

不开启任何本地大模型时，`codex-loop` 仍然可以正常工作：

- 默认中文续发模板
- 根据当前 loop 设置、上一轮摘要、线程状态继续续发
- 开始 / 停止 / 手动续跑 / 健康检查 / 聊天镜像都可用

这意味着：

- 不装 Ollama 也能直接使用
- 默认模板足够支撑大多数日常开发循环

### Ollama 增强模式

如果你希望自动续发更像真人接话，可以安装 Ollama 并在前端高级设置中开启。

启用后，下一条续发消息会基于：

- 当前 loop 设置
- 已发现的项目规则与开发文档
- 上一轮 Codex 摘要
- 最近一次用户意图摘要

来生成更自然、更贴上下文的下一条消息。

### 安装 Ollama

1. 安装 [Ollama](https://ollama.com/)
2. 启动 Ollama 服务
3. 拉取至少一个本地模型，例如：

```bash
ollama pull qwen2.5:7b
```

4. 打开 `codex-loop` 前端
5. 在“当前设置 -> 高级设置：动态续发生成”中：
   - 开启动态续发生成
   - 选择本地模型
   - 确认 `Ollama Base URL`，默认是 `http://127.0.0.1:11434`

如果没有安装 Ollama：

- 相关功能默认关闭
- 不影响 `codex-loop` 基础能力使用

## 前端结构

当前前端是白色极简工作台：

- 左侧边栏
  - 项目分组
  - loop 列表
  - 对话式创建 loop
  - 线程绑定
- 右侧主区
  - 当前 loop 状态
  - 最近续发与聊天记录
  - 当前设置
  - 策略卡片
  - 手机查看摘要
  - 健康检查

同时已加入：

- 首屏骨架屏
- “思考中”动态三点动画
- 轮询同步状态提示
- 页面失焦后自动降频轮询

这些都是为了避免长任务时用户误以为界面卡死。

## 手机查看

当前已经支持移动端查看当前 loop 的关键数据：

- 当前状态
- 最近摘要
- 最近续发消息
- 聊天镜像
- 健康状态

当前方向是：

- 保持最简单的本地部署方式
- 优先利用本地网络 / Tailscale 这类轻量远程入口
- 尽量不要求单独部署云服务器

## 主要命令

- `npm run loop:check`
- `npm run loop:init`
- `npm run loop:heartbeat`
- `npm run loop:finalize`
- `npm run loop:summary`
- `npm run loop:scaffold`
- `npm run loop:bind-thread`
- `npm run loop:start`
- `npm run dev`
- `npm run build:web`
- `npm test`

## 目录说明

```text
app/
  server/        本地 API、loop 控制、健康检查、Ollama 接口
  web/           本地控制台前端
docs/            设计文档、产品说明、开发清单
projects/        通用 adapter 模板
scripts/         启动、检查、初始化、绑定线程等脚本
templates/       loop / thread / runbook 模板
tests/           核心测试
runtime/         本地运行产物（git 忽略）
settings/        本地 loop registry 与用户状态（关键本地产物已忽略）
dist/            前端构建产物（git 忽略）
```

## 开源使用注意事项

- 仓库不应包含任何用户私有项目配置
- 机器本地路径只应写入 `config.local.json`
- 运行中产生的本地状态应保留在 `runtime/` 与 `settings/`
- 这些本地状态不应提交到云端

## 验证建议

在新机器上建议按这个顺序验证：

1. `npm install`
2. `npm run loop:check`
3. `npm test`
4. `npm run build:web`
5. `start-codex-loop.bat`

如果这 5 步都通过，再开始绑定真实 Codex 线程与创建 loop。

## 后续方向

- 继续拉开与原生自动化的差异化
  - 更像真人的上下文卡片
  - 更细的节奏策略
  - 暂停 / 收尾条件
  - Git 守护提醒
- 移动端从“查看”为主逐步扩展到“基础操作”
- 扩展本地大模型与后续云模型接入层
- 继续提升长时间运行稳定性和日志健康诊断能力

## License

MIT
