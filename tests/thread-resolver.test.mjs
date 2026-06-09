import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listCodexThreadCandidates,
  resolveCodexThread,
} from "../app/server/lib/codex-link/thread-resolver.mjs";

async function withTempCodexHome(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-thread-resolver-"));
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

async function writeSession(tempRoot, { threadId, cwd, title = "", records = [] }) {
  const sessionDir = path.join(tempRoot, "sessions", "2026", "06", "09");
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, `rollout-${threadId}.jsonl`);
  const lines = [
    {
      timestamp: "2026-06-09T08:00:00.000Z",
      type: "session_meta",
      payload: {
        id: threadId,
        cwd,
        title,
        originator: "Codex Desktop",
      },
    },
    ...records,
  ];
  await fs.writeFile(
    sessionPath,
    lines.map((record) => JSON.stringify(record)).join("\n"),
    "utf8",
  );
  return sessionPath;
}

test("resolver lists local Codex sessions with thread id, cwd, title, and recent text", async () => {
  await withTempCodexHome(async (tempRoot) => {
    await writeSession(tempRoot, {
      threadId: "thread-demo",
      cwd: "E:\\2026\\demo",
      title: "首页体验优化",
      records: [
        {
          timestamp: "2026-06-09T08:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "继续优化首页体验。" }],
          },
        },
      ],
    });

    const candidates = await listCodexThreadCandidates();

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].threadId, "thread-demo");
    assert.equal(candidates[0].workspaceRoot, "E:\\2026\\demo");
    assert.equal(candidates[0].displayTitle, "首页体验优化");
    assert.match(candidates[0].searchText, /首页体验/);
  });
});

test("resolver returns the unique thread matching project path and window name", async () => {
  await withTempCodexHome(async (tempRoot) => {
    await writeSession(tempRoot, {
      threadId: "thread-target",
      cwd: "E:\\2026\\opencow",
      title: "NPC 展示任务",
    });
    await writeSession(tempRoot, {
      threadId: "thread-other",
      cwd: "E:\\2026\\codex-loop",
      title: "控制台任务",
    });

    const result = await resolveCodexThread({
      workspaceRoot: "e:/2026/opencow",
      windowTitle: "NPC",
    });

    assert.equal(result.status, "matched");
    assert.equal(result.threadId, "thread-target");
    assert.equal(result.workspaceRoot, "E:\\2026\\opencow");
    assert.match(result.userMessage, /已找到/);
  });
});

test("resolver asks for manual fallback when project path matches multiple windows", async () => {
  await withTempCodexHome(async (tempRoot) => {
    await writeSession(tempRoot, {
      threadId: "thread-a",
      cwd: "E:\\2026\\opencow",
      title: "前端任务",
    });
    await writeSession(tempRoot, {
      threadId: "thread-b",
      cwd: "E:\\2026\\opencow",
      title: "后端任务",
    });

    const result = await resolveCodexThread({
      workspaceRoot: "E:\\2026\\opencow",
    });

    assert.equal(result.status, "ambiguous");
    assert.equal(result.candidates.length, 2);
    assert.match(result.userMessage, /找到 2 个/);
    assert.match(result.userMessage, /线程 ID/);
  });
});

test("resolver uses window name to disambiguate matching project sessions", async () => {
  await withTempCodexHome(async (tempRoot) => {
    await writeSession(tempRoot, {
      threadId: "thread-a",
      cwd: "E:\\2026\\opencow",
      title: "前端任务",
    });
    await writeSession(tempRoot, {
      threadId: "thread-b",
      cwd: "E:\\2026\\opencow",
      title: "后端任务",
    });

    const result = await resolveCodexThread({
      workspaceRoot: "E:\\2026\\opencow",
      windowTitle: "后端",
    });

    assert.equal(result.status, "matched");
    assert.equal(result.threadId, "thread-b");
  });
});

test("resolver returns a Chinese unmatched reason when no session matches", async () => {
  await withTempCodexHome(async (tempRoot) => {
    await writeSession(tempRoot, {
      threadId: "thread-other",
      cwd: "E:\\2026\\other",
      title: "其他任务",
    });

    const result = await resolveCodexThread({
      workspaceRoot: "E:\\2026\\missing",
      windowTitle: "主任务",
    });

    assert.equal(result.status, "unmatched");
    assert.match(result.userMessage, /没有找到/);
    assert.match(result.userMessage, /手动/);
  });
});
