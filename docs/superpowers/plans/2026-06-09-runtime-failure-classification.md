# Runtime Failure Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make continuation failures diagnosable with concise Chinese categories, user messages, and recovery actions across logs, runtime state, home status, and mobile export.

**Architecture:** Add a focused `runtime-governance/failure-classifier.mjs` module with a pure `classifyContinuationFailure()` API. Keep `runtime-store.mjs` as the integration point for persistence and exported status, without expanding frontend surface area in this slice.

**Tech Stack:** Node ESM, `node:test`, existing runtime JSON state, Vite web build.

---

### Task 1: Failure Classifier Module

**Files:**
- Create: `tests/failure-classifier.test.mjs`
- Create: `app/server/lib/runtime-governance/failure-classifier.mjs`

- [ ] **Step 1: Write the failing test**

```js
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
  assert.match(dispatch.userMessage, /没有确认送达|目标线程/);
  assert.match(dispatch.nextAction, /线程绑定|桌面端|重新开始/);

  const ollama = classifyContinuationFailure({
    message: "ollama unavailable",
    promptGenerationError: "ollama unavailable",
    promptGenerator: "ollama",
  });

  assert.equal(ollama.category, "ollama_generation");
  assert.match(ollama.label, /本地模型/);
  assert.match(ollama.nextAction, /Ollama|模型|设置/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/failure-classifier.test.mjs`

Expected: FAIL because `failure-classifier.mjs` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create a pure classifier with categories for Codex dispatch, Ollama generation, missing context docs, invalid workspace, supervisor pause, duplicate dispatch, budget stop, and unknown failure.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/failure-classifier.test.mjs`

Expected: PASS.

### Task 2: Runtime Store Integration

**Files:**
- Modify: `app/server/lib/runtime-store.mjs`
- Modify: `tests/runtime-store.test.mjs`
- Modify: `tests/summary-export.test.mjs`

- [ ] **Step 1: Write integration assertions**

Assert `markContinuationFailed()` persists `lastContinuationFailureCategory`, `lastContinuationFailureLabel`, and `lastContinuationFailureAction`, and that `exportMobileView().processStatus` uses category-specific guidance.

- [ ] **Step 2: Run target tests**

Run: `node --test tests/runtime-store.test.mjs tests/summary-export.test.mjs`

Expected: FAIL until runtime persistence and export are wired.

- [ ] **Step 3: Implement integration**

Import the classifier, call it inside `markContinuationFailed()`, persist the structured fields, include them in the runtime event, clear them when status is no longer `error`, and use them in `buildProcessStatus()`.

- [ ] **Step 4: Run target tests**

Run: `node --test tests/failure-classifier.test.mjs tests/runtime-store.test.mjs tests/summary-export.test.mjs`

Expected: PASS.

### Task 3: Documentation And Verification

**Files:**
- Modify: `docs/enterprise-loop-architecture.md`
- Modify: `docs/loop-engineering-principles.md`
- Modify: `tests/docs-loop-engineering.test.mjs`

- [ ] **Step 1: Add docs assertions**

Assert the architecture docs mention `runtime-governance/failure-classifier.mjs` as the first extracted running governance boundary.

- [ ] **Step 2: Update docs**

Describe failure classification as part of the runtime governance layer and clarify that UI should show user-level recovery guidance, not raw debug labels.

- [ ] **Step 3: Full verification and commit**

Run: `npm test`

Run: `npm run build:web`

Expected: both exit with code 0, then commit and push to `origin/main`.
