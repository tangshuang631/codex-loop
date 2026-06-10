import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultRunSupervisorVerificationCommand,
  injectVerificationIntoInstruction,
  runSupervisorIndependentVerification,
} from "../app/server/lib/verification/supervisor-verification.mjs";

test("supervisor verification skips dangerous commands instead of executing them", async () => {
  const result = await defaultRunSupervisorVerificationCommand({
    command: "rm -rf runtime",
    workspaceRoot: process.cwd(),
  });

  assert.equal(result.skipped, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /高风险命令|跳过/);
});

test("supervisor verification returns failed summaries for failed checks", async () => {
  const snapshot = {
    paths: { workspaceRoot: process.cwd() },
    thread: {},
  };
  const review = {
    shouldContinue: true,
    needsIndependentVerification: true,
    verificationCommands: ["npm run test:mobile-flow"],
  };
  const executedCommands = [];

  const result = await runSupervisorIndependentVerification(snapshot, review, {
    runVerificationCommand: async ({ command }) => {
      executedCommands.push(command);
      return {
        command,
        ok: false,
        exitCode: 1,
        output: "mobile transcript missing loop prompt bubble",
      };
    },
  });

  assert.deepEqual(executedCommands, ["npm run test:mobile-flow"]);
  assert.equal(result.status, "failed");
  assert.match(result.summary, /mobile transcript missing loop prompt bubble/);
  assert.equal(result.results[0].status, "failed");
});

test("supervisor verification extracts screenshot evidence paths from command output", async () => {
  const snapshot = {
    paths: { workspaceRoot: process.cwd() },
    thread: {},
  };
  const review = {
    shouldContinue: true,
    needsIndependentVerification: true,
    verificationCommands: ["npm run visual:mobile"],
  };

  const result = await runSupervisorIndependentVerification(snapshot, review, {
    runVerificationCommand: async ({ command }) => ({
      command,
      ok: true,
      exitCode: 0,
      output:
        "移动端截图已保存: runtime/screenshots/mobile-home-2026-06-10.png\n桌面截图: E:\\2026\\codex-loop\\runtime\\screenshots\\dashboard-home.png",
    }),
  });

  assert.equal(result.status, "passed");
  assert.equal(result.evidence.screenshots.length, 2);
  assert.match(result.evidence.screenshots[0], /mobile-home-2026-06-10\.png/);
  assert.match(result.summary, /截图证据/);
  assert.equal(result.results[0].evidence.screenshots.length, 2);
});

test("supervisor verification skips repeated passed commands inside the cooldown window", async () => {
  const snapshot = {
    paths: { workspaceRoot: process.cwd() },
    thread: {
      lastSupervisorVerificationStatus: "passed",
      lastSupervisorVerificationAt: new Date().toISOString(),
      lastSupervisorVerificationCommands: ["node --test tests/runtime-store.test.mjs"],
    },
  };
  const review = {
    shouldContinue: true,
    needsIndependentVerification: true,
    verificationCommands: ["node --test tests/runtime-store.test.mjs"],
  };

  const result = await runSupervisorIndependentVerification(snapshot, review, {
    runVerificationCommand: async () => {
      throw new Error("should not run during cooldown");
    },
  });

  assert.equal(result.status, "skipped");
  assert.match(result.summary, /冷却期|近期已完成/);
});

test("supervisor verification does not repeat the same commands for an already verified Codex completion", async () => {
  const completionAt = "2026-06-10T10:00:00.000Z";
  const verifiedAt = "2026-06-10T10:05:00.000Z";
  const snapshot = {
    paths: { workspaceRoot: process.cwd() },
    thread: {
      lastCompletionAt: completionAt,
      lastSupervisorVerificationStatus: "failed",
      lastSupervisorVerificationAt: verifiedAt,
      lastSupervisorVerificationCommands: ["npm run test:mobile-flow"],
    },
  };
  const review = {
    shouldContinue: true,
    needsIndependentVerification: true,
    verificationCommands: ["npm run test:mobile-flow"],
  };

  const result = await runSupervisorIndependentVerification(snapshot, review, {
    runVerificationCommand: async () => {
      throw new Error("should not rerun verification for the same completion");
    },
  });

  assert.equal(result.status, "skipped");
  assert.match(result.summary, /已经做过独立验收|等待新的 Codex 完成/);
  assert.equal(result.ranAt, verifiedAt);
});

test("verification injection keeps Codex focused on failed or skipped evidence", () => {
  const failedInstruction = injectVerificationIntoInstruction("继续优化移动端状态。", {
    status: "failed",
    summary: "独立验收失败：npm test：history repeated",
  });
  const skippedInstruction = injectVerificationIntoInstruction("继续优化移动端状态。", {
    status: "skipped",
    summary: "监督复盘建议独立验收，但没有可执行命令。",
  });

  assert.match(failedInstruction, /优先修复独立验收失败/);
  assert.match(failedInstruction, /history repeated/);
  assert.match(skippedInstruction, /独立验收未执行/);
  assert.match(skippedInstruction, /没有可执行命令/);
});

test("verification injection does not treat throttled verification as missing evidence", () => {
  const cooldownInstruction = injectVerificationIntoInstruction("继续优化移动端状态。", {
    status: "skipped",
    summary: "近期已完成同一组独立验收，仍在冷却期内，本轮不重复执行。",
  });
  const alreadyVerifiedInstruction = injectVerificationIntoInstruction("继续优化移动端状态。", {
    status: "skipped",
    summary: "当前 Codex 完成结果已经做过独立验收，本轮不重复执行；等待新的 Codex 完成后再验收。",
  });

  assert.doesNotMatch(cooldownInstruction, /独立验收未执行|补齐/);
  assert.match(cooldownInstruction, /不重复执行|冷却期|复用/);
  assert.doesNotMatch(alreadyVerifiedInstruction, /独立验收未执行|补齐/);
  assert.match(alreadyVerifiedInstruction, /已经做过独立验收|等待新的 Codex 完成/);
});
