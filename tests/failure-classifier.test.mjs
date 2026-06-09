import test from "node:test";
import assert from "node:assert/strict";

import { classifyContinuationFailure } from "../app/server/lib/runtime-governance/failure-classifier.mjs";

test("classifies production continuation failures into Chinese recovery guidance", () => {
  const dispatch = classifyContinuationFailure({
    message: "Codex 原生发送未确认送达：没有观察到目标线程收到本次指令。",
    promptGenerator: "ollama",
  });

  assert.equal(dispatch.category, "codex_dispatch");
  assert.equal(dispatch.label, "Codex 发送失败");
  assert.equal(dispatch.severity, "error");
  assert.match(dispatch.userMessage, /没有确认送达|目标线程/);
  assert.match(dispatch.nextAction, /线程绑定|桌面端|重新开始/);

  const ollama = classifyContinuationFailure({
    message: "ollama unavailable",
    promptGenerationError: "ollama unavailable",
    promptGenerator: "ollama",
  });

  assert.equal(ollama.category, "ollama_generation");
  assert.match(ollama.label, /本地模型/);
  assert.match(ollama.userMessage, /Ollama|本地模型/);
  assert.match(ollama.nextAction, /Ollama|模型|设置/);
});

test("classifies local project blockers before dispatch guidance", () => {
  const missingDocs = classifyContinuationFailure({
    message: "继续循环前必须补齐项目文档或开发规则，当前缺失规则文档。",
    promptGenerator: "context-check",
  });

  assert.equal(missingDocs.category, "context_missing");
  assert.equal(missingDocs.label, "缺少项目规则");
  assert.match(missingDocs.nextAction, /文档|规则|创建 loop/);

  const missingWorkspace = classifyContinuationFailure({
    message: "项目路径或工作区不存在，无法继续自动续跑。",
    promptGenerator: "workspace-check",
  });

  assert.equal(missingWorkspace.category, "workspace_invalid");
  assert.equal(missingWorkspace.label, "工作区不可用");
  assert.match(missingWorkspace.nextAction, /工作区|项目路径|重新选择/);
});

test("classifies loop-control blockers separately from transport errors", () => {
  const supervisorPause = classifyContinuationFailure({
    message: "监督复盘建议暂停等待人工确认。",
  });

  assert.equal(supervisorPause.category, "supervisor_paused");
  assert.equal(supervisorPause.label, "等待人工确认");
  assert.equal(supervisorPause.severity, "warning");

  const duplicateDispatch = classifyContinuationFailure({
    message: "Loop continuation is already dispatching for the bound Codex thread.",
  });

  assert.equal(duplicateDispatch.category, "duplicate_dispatch");
  assert.match(duplicateDispatch.nextAction, /等待 Codex 完成|不要重复点击/);
});
