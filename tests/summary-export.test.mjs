import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  ensureLoopArtifacts,
  exportLoopSummary,
  recordHeartbeat,
  saveThreadBinding,
} from "../app/server/lib/runtime-store.mjs";

async function createWorkspace() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-summary-"));
  const configRoot = path.join(tempRoot, "workspace");
  await fs.mkdir(path.join(configRoot, "codex_loop"), { recursive: true });
  await fs.writeFile(
    path.join(configRoot, "codex_loop", "config.json"),
    `${JSON.stringify(
      {
        projectName: "demo",
        branch: "dev",
        currentRunId: "run-summary",
        budgets: {
          maxMinutes: 120,
          maxTokens: 50000,
          finalizeLeadMinutes: 15,
          finalizeLeadTokens: 5000,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return configRoot;
}

test("exportLoopSummary writes mobile-friendly summary json", async () => {
  const configRoot = await createWorkspace();
  await ensureLoopArtifacts(configRoot);
  await saveThreadBinding(configRoot, {
    workspaceName: "opencow",
    threadTitle: "\u8bc4\u4f30\u957f\u65f6\u5f00\u53d1\u65b9\u6848",
    threadId: "thread-123",
    singleThreadMode: true,
  });
  await recordHeartbeat(configRoot, {
    activeTask: "Tighten summary export",
    note: "Focused verification green",
    progressSummary: "Added lightweight summary payload",
    consumedTokens: 4200,
  });

  const exported = await exportLoopSummary(configRoot);

  assert.equal(exported.workspaceName, "opencow");
  assert.equal(exported.threadTitle, "\u8bc4\u4f30\u957f\u65f6\u5f00\u53d1\u65b9\u6848");
  assert.equal(exported.activeTask, "Tighten summary export");
  assert.equal(exported.recentSummary, "Added lightweight summary payload");
  assert.equal(exported.modeLabel, "\u8fd0\u884c\u4e2d");

  const summaryPath = path.join(
    configRoot,
    "codex_loop",
    "runtime",
    "run-summary",
    "summary.json",
  );
  const summaryText = await fs.readFile(summaryPath, "utf8");
  assert.match(summaryText, /"threadId": "thread-123"/);
});
