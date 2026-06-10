import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readProductionStatusSummary } from "../scripts/production-status.mjs";

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
  assert.equal(packageJson.scripts["production:observe"], "node scripts/production-observer.mjs");
  assert.match(source, /codex-loop 生产状态摘要/);
  assert.match(source, /runtime[\\/]production-checks/);
  assert.match(source, /runtime[\\/]frontend-evidence/);
  assert.match(source, /runtime[\\/]longrun-smoke/);
  assert.match(source, /runtime[\\/]production-observations/);
  assert.match(source, /最近生产检查/);
  assert.match(source, /前端证据/);
  assert.match(source, /长跑节奏/);
  assert.match(source, /真实运行观测/);
  assert.match(source, /下一步建议/);
});

test("production status treats stale reports as attention instead of current health", async () => {
  const source = await read("scripts/production-status.mjs");

  assert.match(source, /MAX_REPORT_AGE_HOURS/);
  assert.match(source, /isStale/);
  assert.match(source, /已过期/);
  assert.match(source, /重新运行 npm run production:check/);
});

test("production status surfaces observation diagnosis as the actionable next step", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-status-"));
  const writeReport = async (dirLabel, fileName, report) => {
    const dir = path.join(tempRoot, ...dirLabel.split("/"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  const now = new Date().toISOString();
  await writeReport("runtime/production-checks", "latest-production-check.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/frontend-evidence", "latest-frontend-evidence.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    results: [{ status: "passed" }],
  });
  await writeReport("runtime/longrun-smoke", "latest-longrun-smoke.json", {
    status: "passed",
    finishedAt: now,
    durationMs: 1,
    checks: [{ status: "passed" }],
  });
  await writeReport("runtime/production-observations", "latest-production-observation.json", {
    status: "attention",
    finishedAt: now,
    durationMs: 1,
    summary: "发现 1 条失败记录，需要先排查后再长时间运行。",
    diagnosis: {
      category: "codex_timeout_after_delivery",
      userMessage: "指令已经送达 Codex，但这一轮没有在等待时间内返回完成结果。",
      nextAction: "不要立即连续补发；先确认 Codex 是否仍在处理。",
    },
    counters: {
      dispatches: 1,
      completions: 0,
      supervisorReviews: 0,
    },
  });

  const previousCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const status = await readProductionStatusSummary();
    const observation = status.sections.find((section) => section.label === "真实运行观测");

    assert.equal(status.status, "attention");
    assert.match(observation.summary, /指令已经送达 Codex/);
    assert.match(status.nextAction, /不要立即连续补发/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("docs make production readiness check the pre-use gate", async () => {
  const readme = await read("README.md");
  const checklist = await read("codex-loop6.7-13-29开发清单.md");
  const architecture = await read("docs/enterprise-loop-architecture.md");

  for (const source of [readme, checklist, architecture]) {
    assert.match(source, /npm run production:check/);
    assert.match(source, /npm run production:observe/);
    assert.match(source, /生产就绪检查|投入使用前|生产化检查/);
  }
});
