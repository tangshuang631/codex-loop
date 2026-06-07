import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  ensureAdapterArtifacts,
  readResolvedLoopProfile,
  saveUserOverrides,
} from "../app/server/lib/adapter-store.mjs";

test("ensureAdapterArtifacts seeds generic adapter defaults", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-adapter-"));
  const loopRoot = path.join(tempRoot, "codex_loop");
  await fs.mkdir(path.join(loopRoot, "projects"), { recursive: true });
  await fs.writeFile(
    path.join(loopRoot, "config.json"),
    `${JSON.stringify({
      projectName: "demo",
      branch: "dev",
      currentRunId: "run-1",
      projectAdapter: "generic",
      budgets: {
        maxMinutes: 120,
        maxTokens: 60000,
        finalizeLeadMinutes: 15,
        finalizeLeadTokens: 8000,
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const profile = await ensureAdapterArtifacts(tempRoot);
  assert.equal(profile.adapter.adapterId, "generic");
  assert.equal(profile.resolved.singleThread.required, true);
});

test("saveUserOverrides persists loop detail tuning", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-overrides-"));
  const loopRoot = path.join(tempRoot, "codex_loop");
  await fs.mkdir(path.join(loopRoot, "projects"), { recursive: true });
  await fs.writeFile(
    path.join(loopRoot, "config.json"),
    `${JSON.stringify({
      projectName: "demo",
      branch: "dev",
      currentRunId: "run-2",
      projectAdapter: "generic",
      budgets: {
        maxMinutes: 120,
        maxTokens: 60000,
        finalizeLeadMinutes: 15,
        finalizeLeadTokens: 8000,
      },
    }, null, 2)}\n`,
    "utf8",
  );

  await ensureAdapterArtifacts(tempRoot);
  await saveUserOverrides(tempRoot, {
    stopPolicy: {
      allowFinishCurrentTask: false,
    },
    budgets: {
      maxMinutes: 240,
    },
  });

  const profile = await readResolvedLoopProfile(tempRoot);
  assert.equal(profile.overrides.stopPolicy.allowFinishCurrentTask, false);
  assert.equal(profile.resolved.stopPolicy.allowFinishCurrentTask, false);
  assert.equal(profile.resolved.budgets.maxMinutes, 240);
});

test("ensureAdapterArtifacts resolves generic adapter without requiring bundled example files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-generic-only-"));
  const loopRoot = path.join(tempRoot, "codex_loop");
  await fs.mkdir(loopRoot, { recursive: true });
  await fs.writeFile(
    path.join(loopRoot, "config.json"),
    `${JSON.stringify({
      projectName: "",
      branch: "dev",
      currentRunId: "run-generic",
      projectAdapter: "generic",
      budgets: {
        maxMinutes: 120,
        maxTokens: 60000,
        finalizeLeadMinutes: 15,
        finalizeLeadTokens: 8000,
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const profile = await ensureAdapterArtifacts(loopRoot);
  assert.equal(profile.adapter.adapterId, "generic");
  assert.equal(profile.resolved.singleThread.required, true);
});
