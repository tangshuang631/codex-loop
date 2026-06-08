import assert from "node:assert/strict";
import test from "node:test";

import {
  __testHooks,
  dispatchThreadMessage,
} from "../app/server/lib/codex-dispatcher.mjs";

test("dispatchThreadMessage disables invisible legacy fallback modes", async () => {
  const previousMode = process.env.CODEX_LOOP_DISPATCH_MODE;

  try {
    for (const mode of ["legacy", "thread-store", "cli-resume"]) {
      process.env.CODEX_LOOP_DISPATCH_MODE = mode;
      await assert.rejects(
        () =>
          dispatchThreadMessage({
            threadId: "thread-123",
            prompt: "继续推进",
            workspaceRoot: process.cwd(),
          }),
        /旧 CLI\/线程存储兜底链路已禁用/,
      );
    }
  } finally {
    if (previousMode === undefined) {
      delete process.env.CODEX_LOOP_DISPATCH_MODE;
    } else {
      process.env.CODEX_LOOP_DISPATCH_MODE = previousMode;
    }
  }
});

test("desktop native follower requests use the renderer protocol version", () => {
  assert.equal(__testHooks.requestVersion("thread-follower-start-turn"), 1);
  assert.equal(__testHooks.requestVersion("thread-follower-steer-turn"), 1);
  assert.equal(__testHooks.requestVersion("thread-follower-submit-user-input"), 1);
});

test("desktop native follower params target the bound conversation with delegated input", () => {
  const previousThreadId = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "source-thread";

  try {
    const params = __testHooks.createFollowerTurnParams({
      threadId: "target-thread",
      prompt: "继续检查核心链路。",
      workspaceRoot: "E:/2026/opencow",
      model: "gpt-test",
    });

    assert.equal(params.conversationId, "target-thread");
    assert.equal(params.turnStartParams.threadId, "target-thread");
    assert.equal(params.turnStartParams.cwd, "E:/2026/opencow");
    assert.equal(params.turnStartParams.model, "gpt-test");
    assert.match(params.turnStartParams.input[0].text, /<codex_delegation>/);
    assert.match(params.turnStartParams.input[0].text, /<source_thread_id>source-thread<\/source_thread_id>/);
    assert.match(params.turnStartParams.input[0].text, /<input>继续检查核心链路。<\/input>/);
  } finally {
    if (previousThreadId === undefined) {
      delete process.env.CODEX_THREAD_ID;
    } else {
      process.env.CODEX_THREAD_ID = previousThreadId;
    }
  }
});

test("desktop native delivery is observed only when the target thread contains this delegated prompt", () => {
  const previousThreadId = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "source-thread";

  try {
    const prompt = "继续检查核心链路。";
    const visiblePrompt = __testHooks.buildDelegatedPrompt(prompt);
    const broadcast = {
      type: "broadcast",
      method: "thread-stream-state-changed",
      params: {
        conversationId: "target-thread",
        change: {
          conversationState: {
            id: "target-thread",
            turns: [
              {
                params: {
                  input: [{ type: "text", text: visiblePrompt }],
                },
                items: [],
              },
            ],
          },
        },
      },
    };

    assert.equal(
      __testHooks.isTargetThreadDeliveryBroadcast(broadcast, {
        threadId: "target-thread",
        prompt,
      }),
      true,
    );
    assert.equal(
      __testHooks.isTargetThreadDeliveryBroadcast(broadcast, {
        threadId: "target-thread",
        prompt: "另一条消息",
      }),
      false,
    );
    assert.equal(
      __testHooks.isTargetThreadDeliveryBroadcast(broadcast, {
        threadId: "other-thread",
        prompt,
      }),
      false,
    );
  } finally {
    if (previousThreadId === undefined) {
      delete process.env.CODEX_THREAD_ID;
    } else {
      process.env.CODEX_THREAD_ID = previousThreadId;
    }
  }
});
