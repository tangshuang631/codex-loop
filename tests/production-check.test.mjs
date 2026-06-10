import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

async function read(path) {
  return fs.readFile(path, "utf8");
}

test("production readiness check is exposed as one verified command", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const source = await read("scripts/production-check.mjs");

  assert.equal(packageJson.scripts["production:check"], "node scripts/production-check.mjs");
  assert.match(source, /loop:check/);
  assert.match(source, /loop:smoke/);
  assert.match(source, /npm test/);
  assert.match(source, /npm run build:web/);
  assert.match(source, /npm run build:mobile/);
  assert.match(source, /git diff --check/);
});

test("long-run smoke check is exposed and uses simulated controller dependencies", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const source = await read("scripts/longrun-smoke.mjs");

  assert.equal(packageJson.scripts["loop:smoke"], "node scripts/longrun-smoke.mjs");
  assert.match(source, /createLoopController/);
  assert.match(source, /readSnapshot/);
  assert.match(source, /runTurn/);
  assert.match(source, /reviewCompletion/);
  assert.match(source, /pendingUserGuidance/);
  assert.match(source, /NPC|监督复盘|generatorSawGuidance/);
  assert.match(source, /产品经理|测试人员|真实用户|PM|QA/);
  assert.match(source, /independentVerification|独立验收/);
  assert.match(source, /cooldown|冷却|不重复/);
  assert.match(source, /runtime[\\/]longrun-smoke/);
  assert.doesNotMatch(source, /codex-dispatcher|sendCodex|native dispatch/i);
});

test("production readiness check writes a Chinese evidence report", async () => {
  const source = await read("scripts/production-check.mjs");

  assert.match(source, /生产就绪检查/);
  assert.match(source, /验证命令/);
  assert.match(source, /前端证据检查/);
  assert.match(source, /frontend-evidence-check\.mjs/);
  assert.match(source, /报告路径/);
  assert.match(source, /runtime[\\/]production-checks/);
  assert.match(source, /status:\s*"passed"/);
  assert.match(source, /status:\s*"failed"/);
});

test("frontend evidence check verifies built desktop and mobile product surfaces", async () => {
  const source = await read("scripts/frontend-evidence-check.mjs");

  assert.match(source, /codex-loop 前端证据检查/);
  assert.match(source, /dist[\\/]web/);
  assert.match(source, /dist[\\/]mobile/);
  assert.match(source, /历史对话/);
  assert.match(source, /发送引导/);
  assert.match(source, /截图证据/);
  assert.match(source, /runtime[\\/]frontend-evidence/);
});

test("production status summarizes recent production evidence for long-running use", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const source = await read("scripts/production-status.mjs");

  assert.equal(packageJson.scripts["production:status"], "node scripts/production-status.mjs");
  assert.match(source, /codex-loop 生产状态摘要/);
  assert.match(source, /runtime[\\/]production-checks/);
  assert.match(source, /runtime[\\/]frontend-evidence/);
  assert.match(source, /runtime[\\/]longrun-smoke/);
  assert.match(source, /最近生产检查/);
  assert.match(source, /前端证据/);
  assert.match(source, /长跑节奏/);
  assert.match(source, /下一步建议/);
});

test("docs make production readiness check the pre-use gate", async () => {
  const readme = await read("README.md");
  const checklist = await read("codex-loop6.7-13-29开发清单.md");
  const architecture = await read("docs/enterprise-loop-architecture.md");

  for (const source of [readme, checklist, architecture]) {
    assert.match(source, /npm run production:check/);
    assert.match(source, /生产就绪检查|投入使用前|生产化检查/);
  }
});
