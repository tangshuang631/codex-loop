import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(path) {
  return fs.readFile(path, "utf8");
}

test("mobile app shell exists as a separate PWA build target", async () => {
  const files = [
    "app/mobile/index.html",
    "app/mobile/manifest.webmanifest",
    "app/mobile/vite.config.mjs",
    "app/mobile/src/main.jsx",
    "app/mobile/src/styles.css",
  ];

  for (const file of files) {
    const stat = await fs.stat(file);
    assert.equal(stat.isFile(), true, `${file} should be a file`);
  }

  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(
    packageJson.scripts["build:mobile"],
    "vite build --config app/mobile/vite.config.mjs",
  );
});

test("mobile app is a lightweight task monitor instead of a desktop console clone", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /\/mobile\/view/);
  assert.match(source, /\/mobile\/guidance/);
  assert.match(source, /\/device-pairing\/confirm/);
  assert.match(source, /历史对话/);
  assert.match(source, /发送引导/);
  assert.match(source, /等 Codex 完成后合并/);
  assert.match(source, /待合并/);
  assert.match(source, /pending\.statusLabel/);
  assert.match(source, /pending\.statusDetail/);
  assert.match(source, /pending\.actionLabel/);
  assert.doesNotMatch(source, /彻底关闭|新建项目|新建任务|Ollama 设置|运行治理/);
  assert.doesNotMatch(source, /app\/web|\\.\\.\/web|MobileTaskApp/);
  assert.match(styleSource, /border-top/);
  assert.match(styleSource, /position:\s*sticky/);
});

test("mobile app uses shared conversation items and collapses Codex-style details", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /mobileView\?\.conversationItems/);
  assert.match(source, /detailBlocks/);
  assert.match(source, /conversation-detail-block/);
  assert.match(source, /collapsedByDefault/);
  assert.match(source, /block\.displayLabel \|\| block\.summary/);
  assert.match(styleSource, /\.conversation-detail-block/);
  assert.match(styleSource, /\.conversation-detail-body/);
});

test("mobile app renders history as Codex-like divider flow instead of heavy chat cards", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /className=\{isLoop \? "message is-loop" : "message is-codex"\}/);
  assert.match(styleSource, /\.message\s*\{/);
  assert.match(styleSource, /\.message\.is-codex/);
  assert.match(styleSource, /\.message\.is-loop/);
  assert.match(styleSource, /border-top:\s*1px solid rgba\(31,\s*33,\s*31,\s*0\.09\)/);
  const loopBubbleRule = styleSource.match(/\.message\.is-loop details\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(loopBubbleRule, /background:\s*#f6f3ed/);
  assert.doesNotMatch(loopBubbleRule, /background:\s*#242620/);
  assert.doesNotMatch(loopBubbleRule, /color:\s*#fff/);
});

test("mobile app surfaces production monitoring signals in one compact status block", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /holdReason/);
  assert.match(source, /pendingGuidancePreview/);
  assert.match(source, /lastMergedGuidanceStatus/);
  assert.match(source, /lastMergedGuidancePreview/);
  assert.match(source, /已合并补充/);
  assert.match(source, /supervisorVerificationLabel/);
  assert.match(source, /supervisorVerificationAction/);
  assert.match(source, /latestInstructionSourceDetail/);
  assert.match(source, /状态细节|等待原因|独立验收|模型来源/);
  assert.match(styleSource, /\.status-detail/);
  assert.match(styleSource, /\.status-detail-grid/);
});

test("mobile app shows production status and stale observation guidance", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /\/production-status/);
  assert.match(source, /\/production-preflight/);
  assert.match(source, /productionStatus/);
  assert.match(source, /productionPreflight/);
  assert.match(source, /productionStatus\?\.target/);
  assert.match(source, /productionPreflight\?\.target/);
  assert.match(source, /验证目标/);
  assert.match(source, /启动预检/);
  assert.match(source, /可以启动|先别启动|等待中/);
  assert.match(source, /shortThreadId/);
  assert.match(source, /readiness\?\.stage/);
  assert.match(source, /生产阶段/);
  assert.match(source, /短时试用|可长跑|观察中|需处理/);
  assert.match(source, /生产观测|生产状态/);
  assert.match(source, /真实运行观测/);
  assert.match(source, /已过期|重新启动一次真实任务|重新运行 npm run production:observe/);
});

test("mobile app shows structured maturity and remaining production gaps", async () => {
  const source = await read("app/mobile/src/main.jsx");

  assert.match(source, /productionStatus\?\.maturity/);
  assert.match(source, /maturity\?\.label/);
  assert.match(source, /maturity\?\.percent/);
  assert.match(source, /maturity\?\.canLongRun/);
  assert.match(source, /生产成熟度/);
  assert.match(source, /剩余缺口/);
});

test("mobile app shows closed-loop evidence progress for remote supervision", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /closedLoopCount/);
  assert.match(source, /closedLoopTarget/);
  assert.match(source, /productionStatus\?\.closedLoopEvidence/);
  assert.match(source, /闭环证据/);
  assert.match(source, /closed-loop-evidence/);
  assert.match(source, /还差.*轮|已达到长期运行基本证据/);
  assert.match(styleSource, /\.closed-loop-evidence/);
  assert.match(styleSource, /\.closed-loop-evidence-bar/);
});

test("mobile app shows supervisor screenshot evidence without adding noisy cards", async () => {
  const source = await read("app/mobile/src/main.jsx");
  const styleSource = await read("app/mobile/src/styles.css");

  assert.match(source, /supervisorVerificationEvidencePreview/);
  assert.match(source, /supervisorVerificationEvidenceCount/);
  assert.match(source, /截图证据/);
  assert.match(source, /status-detail-row/);
  assert.doesNotMatch(source, /screenshot-evidence-card/);
  assert.match(styleSource, /\.status-detail-row/);
});

test("mobile app manifest supports installable Chinese product naming", async () => {
  const manifest = JSON.parse(await read("app/mobile/manifest.webmanifest"));

  assert.equal(manifest.name, "codex-loop 移动监控");
  assert.equal(manifest.short_name, "codex-loop");
  assert.equal(manifest.start_url, "/mobile");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.lang, "zh-CN");
});

test("docs describe the shipped mobile app shell and keep only native wrapper as future work", async () => {
  const readme = await read("README.md");
  const roadmap = await read("docs/product-roadmap.md");
  const architecture = await read("docs/enterprise-loop-architecture.md");

  for (const source of [readme, roadmap, architecture]) {
    assert.match(source, /app\/mobile/);
    assert.match(source, /独立移动端|移动端 App\/PWA|PWA 壳/);
    assert.doesNotMatch(source, /独立 `app\/mobile` 工程仍是后续|完整 `app\/mobile` 仍按下一批开发|原生 App 和独立 `app\/mobile` 工程仍是下一批/);
  }
});
