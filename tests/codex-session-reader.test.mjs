import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readCodexConversationMirror } from "../app/server/lib/codex-session-reader.mjs";

async function withTempCodexHome(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-session-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempRoot;

  try {
    await fn(tempRoot);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeSession(tempRoot, threadId, records) {
  const sessionDir = path.join(tempRoot, "sessions", "2026", "06", "08");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, `rollout-${threadId}.jsonl`);
  await fs.writeFile(
    sessionPath,
    records.map((record) => JSON.stringify(record)).join("\n"),
    "utf8",
  );
  return sessionPath;
}

test("readCodexConversationMirror reads latest user and assistant messages from local Codex session jsonl", async () => {
  await withTempCodexHome(async (tempRoot) => {
    const threadId = "019e-test-thread";
    await writeSession(tempRoot, threadId, [
      {
        timestamp: "2026-06-08T14:44:11.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "继续当前 loop，补 app 闭环测试。" }],
        },
      },
      {
        timestamp: "2026-06-08T14:45:09.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Codex 已开始补测试，并确认不需要额外生产接线。",
        },
      },
      {
        timestamp: "2026-06-08T14:46:14.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          last_agent_message: "本批完成 app 闭环覆盖，检查点已推送。",
        },
      },
    ]);

    const mirror = await readCodexConversationMirror(threadId);

    assert.equal(mirror.threadId, threadId);
    assert.equal(mirror.latestUser.text, "继续当前 loop，补 app 闭环测试。");
    assert.equal(mirror.latestAssistant.text, "本批完成 app 闭环覆盖，检查点已推送。");
    assert.equal(mirror.entries[0].label, "Codex 完成摘要");
  });
});

test("readCodexConversationMirror keeps codex-loop delegated prompts as user messages", async () => {
  await withTempCodexHome(async (tempRoot) => {
    const threadId = "019e-delegated-thread";
    await writeSession(tempRoot, threadId, [
      {
        timestamp: "2026-06-08T04:13:21.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "<codex_delegation>",
                "  <source_thread_id>source-thread</source_thread_id>",
                "  <input>直接开始开发。请基于最新检查点完成最小变更。</input>",
                "</codex_delegation>",
              ].join("\n"),
            },
          ],
        },
      },
      {
        timestamp: "2026-06-08T04:15:06.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          last_agent_message: "本轮完成了回归测试并已提交。",
        },
      },
    ]);

    const mirror = await readCodexConversationMirror(threadId);

    assert.equal(mirror.latestUser.label, "codex-loop 指令");
    assert.equal(mirror.latestUser.text, "直接开始开发。请基于最新检查点完成最小变更。");
    assert.equal(mirror.entries[0].role, "assistant");
    assert.equal(mirror.entries[1].role, "user");
  });
});

test("readCodexConversationMirror dedupes the same Codex reply across event shapes", async () => {
  await withTempCodexHome(async (tempRoot) => {
    const threadId = "019e-duplicate-thread";
    const repeatedText = "本轮完成了回归测试并已提交。";
    await writeSession(tempRoot, threadId, [
      {
        timestamp: "2026-06-08T04:15:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: repeatedText }],
        },
      },
      {
        timestamp: "2026-06-08T04:15:06.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: repeatedText,
        },
      },
      {
        timestamp: "2026-06-08T04:15:07.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          last_agent_message: repeatedText,
        },
      },
    ]);

    const mirror = await readCodexConversationMirror(threadId);

    assert.equal(mirror.entries.length, 1);
    assert.equal(mirror.latestAssistant.text, repeatedText);
    assert.equal(mirror.latestCompletion.text, repeatedText);
    assert.equal(mirror.entries[0].label, "Codex 完成摘要");
  });
});
