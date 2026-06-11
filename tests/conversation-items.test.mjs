import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationItemsFromMobileView } from "../app/shared/conversation-items.mjs";

test("buildConversationItemsFromMobileView prefers server conversation items and keeps chronological order", () => {
  const entries = buildConversationItemsFromMobileView({
    conversationItems: [
      { role: "assistant", at: "2026-06-07T10:02:00.000Z", text: "第二条", preview: "第二条" },
      { role: "user", at: "2026-06-07T10:01:00.000Z", text: "第一条", preview: "第一条" },
      { role: "user", at: "2026-06-07T10:01:00.000Z", text: "第一条", preview: "第一条" },
    ],
  });

  assert.deepEqual(
    entries.map((entry) => entry.text),
    ["第一条", "第二条"],
  );
});

test("buildConversationItemsFromMobileView falls back to prompt, transcript, and user-facing runtime events", () => {
  const entries = buildConversationItemsFromMobileView(
    {
      latestPrompt: "继续检查移动端历史对话。",
      thread: { lastDispatchAt: "2026-06-07T10:01:00.000Z" },
      transcriptEntries: [
        {
          at: "2026-06-07T10:02:00.000Z",
          summary: "Codex 已完成移动端验证。",
          activeTask: "移动端任务",
        },
        {
          at: "2026-06-07T10:02:30.000Z",
          summary: "已收到停止指令，当前循环进入收尾状态。",
          note: "用户在控制台点击停止",
        },
      ],
      runtimeEvents: [
        {
          at: "2026-06-07T10:03:00.000Z",
          type: "supervisor_review",
          title: "监督复盘",
          detail: "等待下一轮引导。",
        },
        {
          at: "2026-06-07T10:04:00.000Z",
          type: "graceful_stop_requested",
          title: "停止请求",
          detail: "用户在控制台点击停止",
        },
      ],
    },
    {
      latestPromptLabel: "codex-loop 指令",
      assistantFallbackLabel: "Codex 回复",
      runtimeFallbackLabel: "运行记录",
    },
  );

  assert.deepEqual(
    entries.map((entry) => [entry.role, entry.label, entry.text]),
    [
      ["user", "codex-loop 指令", "继续检查移动端历史对话。"],
      ["assistant", "移动端任务", "Codex 已完成移动端验证。"],
      ["assistant", "监督复盘", "等待下一轮引导。"],
    ],
  );
});

test("buildConversationItemsFromMobileView uses mirrored Codex conversation before fallback records", () => {
  const entries = buildConversationItemsFromMobileView({
    latestPrompt: "不应该展示这一条",
    codexConversation: {
      entries: [
        { role: "assistant", at: "2026-06-07T10:00:00.000Z", text: "镜像回复", preview: "镜像回复" },
      ],
    },
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "镜像回复");
});
