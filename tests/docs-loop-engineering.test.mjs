import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("loop engineering principles are documented as the product target", async () => {
  const docSource = await fs.readFile("docs/loop-engineering-principles.md", "utf8");

  assert.match(docSource, /# codex-loop Loop 工程原则/);
  assert.match(docSource, /企业级 loop 软件/);
  assert.match(docSource, /目标 -> 计划 -> 执行 -> 观察 -> 验证 -> 反馈 -> 下一步/);
  assert.match(docSource, /模型外层内核/);
  assert.match(docSource, /工具系统/);
  assert.match(docSource, /项目记忆/);
  assert.match(docSource, /验证流程/);
  assert.match(docSource, /权限边界/);
  assert.match(docSource, /停止条件/);
  assert.match(docSource, /坏 loop 比坏 prompt 更危险/);
});

test("entry docs point developers to the enterprise loop target", async () => {
  const readmeSource = await fs.readFile("README.md", "utf8");
  const roadmapSource = await fs.readFile("docs/product-roadmap.md", "utf8");
  const checklistSource = await fs.readFile("2026.6.11交接清单.md", "utf8");

  assert.match(readmeSource, /\[Loop 工程原则\]\(docs\/loop-engineering-principles\.md\)/);
  assert.match(roadmapSource, /企业级 loop 软件目标/);
  assert.match(roadmapSource, /不是更强模型的包装层/);
  assert.match(checklistSource, /真实运行证据|短时真实试用|长期生产化稳定运行/);
  assert.match(checklistSource, /真实闭环|用户补充.*合并.*下一条指令/);
});

test("README presents the enterprise loop architecture layers", async () => {
  const readmeSource = await fs.readFile("README.md", "utf8");

  assert.match(readmeSource, /企业级结构/);
  assert.match(readmeSource, /Loop 内核/);
  assert.match(readmeSource, /Codex 联动层/);
  assert.match(readmeSource, /NPC 决策层/);
  assert.match(readmeSource, /验证层/);
  assert.match(readmeSource, /产品界面层/);
  assert.match(readmeSource, /运行治理层/);
});

test("loop engineering principles map enterprise layers to project structure", async () => {
  const docSource = await fs.readFile("docs/loop-engineering-principles.md", "utf8");

  assert.match(docSource, /项目结构收口路线/);
  assert.match(docSource, /app\/server\/lib/);
  assert.match(docSource, /loop-core/);
  assert.match(docSource, /codex-link/);
  assert.match(docSource, /npc/);
  assert.match(docSource, /verification/);
  assert.match(docSource, /runtime-governance/);
});

test("loop engineering principles define a productized operating contract", async () => {
  const docSource = await fs.readFile("docs/loop-engineering-principles.md", "utf8");

  assert.match(docSource, /产品化 Loop 工作契约/);
  assert.match(docSource, /模型只负责生成，Agent 内核负责推进/);
  assert.match(docSource, /每一轮必须沉淀一组证据/);
  assert.match(docSource, /预算不是建议值，而是下一轮发送闸门/);
  assert.match(docSource, /用户补充不是立即打断 Codex/);
  assert.match(docSource, /没有验证信号时必须降级为人工确认或只读观察/);
});

test("roadmap names enterprise maturity milestones instead of vague prompt work", async () => {
  const roadmapSource = await fs.readFile("docs/product-roadmap.md", "utf8");
  const checklistSource = await fs.readFile("2026.6.11交接清单.md", "utf8");

  assert.match(roadmapSource, /企业级成熟度里程碑/);
  assert.match(roadmapSource, /P0 可运行闭环/);
  assert.match(roadmapSource, /P1 可控闭环/);
  assert.match(roadmapSource, /P2 可验证闭环/);
  assert.match(roadmapSource, /P3 可长期监控闭环/);
  assert.match(checklistSource, /短时真实试用|真实长跑证据/);
  assert.match(checklistSource, /真实闭环达到 `2\/2`|还差 `1` 轮真实闭环/);
});

test("docs make mobile remote control and Codex-like history rendering P0", async () => {
  const readmeSource = await fs.readFile("README.md", "utf8");
  const roadmapSource = await fs.readFile("docs/product-roadmap.md", "utf8");
  const architectureSource = await fs.readFile("docs/enterprise-loop-architecture.md", "utf8");
  const checklistSource = await fs.readFile("2026.6.11交接清单.md", "utf8");

  const combinedSource = [readmeSource, roadmapSource, architectureSource, checklistSource].join("\n");
  assert.match(combinedSource, /P0/);
  assert.match(combinedSource, /安卓 App|App \/ PWA|App\/PWA|移动端 App/);
  assert.match(combinedSource, /远程.*发送引导|发送引导.*远程|远程操控/);
  assert.match(combinedSource, /Codex.*历史|历史.*Codex/);
  assert.match(combinedSource, /文件改动|文件路径/);
  assert.match(combinedSource, /命令输出|命令/);
  assert.match(combinedSource, /默认.*折叠|默认.*收纳|默认折叠/);
  assert.match(combinedSource, /展开.*详情|详情.*展开|点击.*展开/);
});

test("architecture map documents current files and target enterprise boundaries", async () => {
  const readmeSource = await fs.readFile("README.md", "utf8");
  const architectureSource = await fs.readFile("docs/enterprise-loop-architecture.md", "utf8");

  assert.match(readmeSource, /\[企业级 Loop 架构映射\]\(docs\/enterprise-loop-architecture\.md\)/);
  assert.match(architectureSource, /当前结构不是最终结构/);
  assert.match(architectureSource, /runtime-store\.mjs/);
  assert.match(architectureSource, /loop-controller\.mjs/);
  assert.match(architectureSource, /loop-core\/controller-gates\.mjs/);
  assert.match(architectureSource, /自动循环闸门已经迁入 Loop 内核/);
  assert.match(architectureSource, /codex-dispatcher\.mjs/);
  assert.match(architectureSource, /ollama-prompt-generator\.mjs/);
  assert.match(architectureSource, /supervisor-verification\.mjs/);
  assert.match(architectureSource, /监督独立验收已经迁入验证层/);
  assert.match(architectureSource, /runtime-governance\/failure-classifier\.mjs/);
  assert.match(architectureSource, /续跑失败分类已经迁入运行治理层/);
  assert.match(architectureSource, /每次只迁移一条已测试的能力边界/);
  assert.match(architectureSource, /不得为了目录好看而搬家/);
});

test("product docs define task-first monitoring, mobile app, and durable phone pairing", async () => {
  const readmeSource = await fs.readFile("README.md", "utf8");
  const roadmapSource = await fs.readFile("docs/product-roadmap.md", "utf8");
  const principlesSource = await fs.readFile("docs/loop-engineering-principles.md", "utf8");
  const checklistSource = await fs.readFile("2026.6.11交接清单.md", "utf8");

  const combinedSource = [readmeSource, roadmapSource, principlesSource, checklistSource].join("\n");
  assert.match(combinedSource, /新建任务|任务模型.*任务/);
  assert.match(combinedSource, /监控模式/);
  assert.match(combinedSource, /不开始循环|不自动循环/);
  assert.match(combinedSource, /发送引导/);
  assert.match(combinedSource, /移动端 App/);
  assert.match(combinedSource, /扫码/);
  assert.match(combinedSource, /长期绑定/);
  assert.match(combinedSource, /项目路径.*窗口名|窗口名.*项目路径|手动线程 ID|手动线程 ID 只作为兜底/);
});

test("architecture map includes productized binding and mobile-app target modules", async () => {
  const architectureSource = await fs.readFile("docs/enterprise-loop-architecture.md", "utf8");

  assert.match(architectureSource, /app\/mobile/);
  assert.match(architectureSource, /remote-access\.mjs/);
  assert.match(architectureSource, /device-pairing/);
  assert.match(architectureSource, /thread-resolver/);
  assert.match(architectureSource, /项目路径.*窗口名|窗口名.*项目路径/);
  assert.match(architectureSource, /扫码.*长期绑定|长期绑定.*扫码/);
});

test("docs distinguish shipped phone-pairing and mobile app shell from the future native wrapper", async () => {
  const readmeSource = await fs.readFile("README.md", "utf8");
  const roadmapSource = await fs.readFile("docs/product-roadmap.md", "utf8");

  for (const source of [readmeSource, roadmapSource]) {
    assert.match(source, /扫码长期绑定基础已接入/);
    assert.match(source, /受保护移动端任务视图|长期设备令牌.*移动端任务视图/);
    assert.match(source, /\/mobile/);
    assert.match(source, /app\/mobile/);
    assert.match(source, /独立.*App\/PWA 壳|App\/PWA 壳.*独立/);
    assert.match(source, /发送引导/);
    assert.match(source, /原生 App.*后续|后续.*原生 App/);
    assert.match(source, /自动窗口绑定基础已接入/);
  }
});

test("docs describe frontend evidence as part of production readiness", async () => {
  const readmeSource = await fs.readFile("README.md", "utf8");
  const checklistSource = await fs.readFile("2026.6.11交接清单.md", "utf8");
  const architectureSource = await fs.readFile("docs/enterprise-loop-architecture.md", "utf8");

  const combinedSource = [readmeSource, checklistSource, architectureSource].join("\n");
  assert.match(combinedSource, /前端证据检查/);
  assert.match(combinedSource, /runtime\/frontend-evidence/);
  assert.match(combinedSource, /历史对话/);
  assert.match(combinedSource, /发送引导/);
  assert.match(combinedSource, /截图证据/);
  assert.match(combinedSource, /启动预检|production:check|生产就绪总检查/);
});

test("docs expose production status summary for long-running operation", async () => {
  const readmeSource = await fs.readFile("README.md", "utf8");
  const checklistSource = await fs.readFile("2026.6.11交接清单.md", "utf8");
  const architectureSource = await fs.readFile("docs/enterprise-loop-architecture.md", "utf8");

  const combinedSource = [readmeSource, checklistSource, architectureSource].join("\n");
  assert.match(combinedSource, /npm run production:status/);
  assert.match(combinedSource, /生产状态摘要|最近生产状态/);
  assert.match(combinedSource, /最近生产检查|最新验证结果/);
  assert.match(combinedSource, /前端证据|frontend-evidence-check/);
  assert.match(combinedSource, /长跑节奏|真实长跑证据/);
  assert.match(combinedSource, /下一步建议|当前缺口|接手建议顺序/);
  assert.match(combinedSource, /12 小时/);
  assert.match(combinedSource, /重新运行 npm run production:check/);
  assert.match(combinedSource, /至少 2 轮|两轮/);
  assert.match(combinedSource, /发送.*Codex 完成.*NPC 复盘|NPC 复盘.*Codex 完成.*发送/);
});
