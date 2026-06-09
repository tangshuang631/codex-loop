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
