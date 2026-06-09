import assert from "node:assert/strict";
import test from "node:test";

import { planLoopWithFallback } from "../app/server/lib/ollama-loop-planner.mjs";

test("fallback task planner uses product-facing task wording", async () => {
  const result = await planLoopWithFallback({
    draft: {
      workspaceRoot: "E:\\2026\\demo-project",
      git: { hasGit: true, branch: "dev" },
      docs: { ruleDocs: [] },
    },
    answer: "",
    fetchImpl: async () => {
      throw new Error("ollama offline");
    },
  });

  assert.equal(result.source, "template");
  assert.match(result.objectiveSummary, /自动化任务/);
  assert.equal(result.checklist.includes("创建首个任务，并绑定到可见 Codex 线程"), true);
  assert.doesNotMatch(
    [result.objectiveSummary, ...result.checklist].join("\n"),
    /首个自动化 loop|创建首个 loop|新建 loop|当前 loop/,
  );
});
