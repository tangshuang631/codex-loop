import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readCodexConversationMirror } from "../app/server/lib/codex-session-reader.mjs";

test("readCodexConversationMirror reads latest user and assistant messages from local Codex session jsonl", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-session-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempRoot;

  try {
    const threadId = "019e-test-thread";
    const sessionDir = path.join(tempRoot, "sessions", "2026", "06", "07");
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, `rollout-${threadId}.jsonl`);
    const records = [
      {
        timestamp: "2026-06-07T14:44:11.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "继续当前 loop，补 app 闭环测试。" }],
        },
      },
      {
        timestamp: "2026-06-07T14:45:09.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Codex 已开始补测试，并确认不需要额外生产接线。",
        },
      },
      {
        timestamp: "2026-06-07T14:46:14.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          last_agent_message: "本批完成 app 闭环覆盖，检查点已推送。",
        },
      },
    ];
    await fs.writeFile(
      sessionPath,
      records.map((record) => JSON.stringify(record)).join("\n"),
      "utf8",
    );

    const mirror = await readCodexConversationMirror(threadId);

    assert.equal(mirror.threadId, threadId);
    assert.equal(mirror.latestUser.text, "继续当前 loop，补 app 闭环测试。");
    assert.equal(mirror.latestAssistant.text, "本批完成 app 闭环覆盖，检查点已推送。");
    assert.equal(mirror.entries[0].label, "Codex 完成摘要");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
