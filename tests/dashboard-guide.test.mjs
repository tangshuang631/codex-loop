import test from "node:test";
import assert from "node:assert/strict";

import { deriveDashboardGuide } from "../app/web/src/dashboard-guide.mjs";

test("deriveDashboardGuide prioritizes thread binding for first-time users", () => {
  const guide = deriveDashboardGuide({
    snapshot: {
      state: {
        mode: "running",
        recentSummary: "Loop initialized; waiting for the first heartbeat or Codex progress sync.",
      },
      thread: {
        threadId: "",
        threadTitle: "默认线程",
        latestSummary: "Loop initialized; waiting for the first heartbeat or Codex progress sync.",
        continuationStatus: "idle",
      },
      health: {
        issues: ["transcript:stale"],
      },
    },
    currentLoop: {
      name: "默认循环",
      projectName: "project",
    },
    mobileView: {
      suggestedAction: "等待下一步",
      bindingNote: "当前还没有绑定可见线程，请先绑定线程再启动或续跑。",
      transcriptEntries: [],
      strategy: {
        contextCard: {
          nextAction: "先绑定线程",
        },
      },
    },
    pollStatus: "已更新 06/07 13:57",
  });

  assert.equal(guide.stage, "bind-thread");
  assert.match(guide.title, /绑定.*线程/);
  assert.equal(guide.primaryAction.id, "open-manage");
  assert.match(guide.summary, /绑定/);
});

test("deriveDashboardGuide promotes starting the loop after binding is ready", () => {
  const guide = deriveDashboardGuide({
    snapshot: {
      state: {
        mode: "stopped",
        recentSummary: "Ready to begin the first verified run.",
      },
      thread: {
        threadId: "thread-123",
        threadTitle: "项目主线程",
        latestSummary: "Ready to begin the first verified run.",
        continuationStatus: "idle",
      },
      health: {
        issues: [],
      },
    },
    currentLoop: {
      name: "结算链路收口",
      projectName: "storefront",
    },
    mobileView: {
      suggestedAction: "开始第一轮 loop",
      bindingNote: "已绑定到项目主线程。",
      transcriptEntries: [],
      strategy: {
        contextCard: {
          nextAction: "点击开始循环，生成第一轮连续记录。",
        },
      },
    },
    pollStatus: "等待首轮同步",
  });

  assert.equal(guide.stage, "start-loop");
  assert.equal(guide.primaryAction.id, "start-loop");
  assert.match(guide.title, /开始/);
  assert.match(
    guide.supportingMetrics.find((item) => item.label === "当前线程").value,
    /项目主线程/,
  );
});

test("deriveDashboardGuide shows progress mode when the loop is actively running", () => {
  const guide = deriveDashboardGuide({
    snapshot: {
      state: {
        mode: "running",
        recentSummary: "Finished the launcher verification batch and moved to UI cleanup.",
        lastHeartbeatAt: "2026-06-07T05:57:08.405Z",
      },
      thread: {
        threadId: "thread-321",
        threadTitle: "控制台产品化",
        latestSummary: "Finished the launcher verification batch and moved to UI cleanup.",
        latestCodexSummary: "Finished the launcher verification batch and moved to UI cleanup.",
        continuationStatus: "idle",
        lastDispatchPrompt: "Continue from the latest verified checkpoint.",
      },
      health: {
        issues: [],
      },
    },
    currentLoop: {
      name: "控制台产品化",
      projectName: "codex-loop",
    },
    mobileView: {
      suggestedAction: "查看最近改动并决定下一轮任务。",
      bindingNote: "当前 loop 已绑定到可见线程。",
      transcriptEntries: [{ at: "2026-06-07T05:57:08.405Z", activeTask: "UI cleanup" }],
      strategy: {
        contextCard: {
          nextAction: "继续压缩首页信息架构。",
        },
      },
    },
    pollStatus: "已更新 06/07 13:57",
  });

  assert.equal(guide.stage, "active-loop");
  assert.equal(guide.primaryAction.id, "run-turn");
  assert.match(guide.title, /正在推进|关键/);
  assert.match(guide.focusLabel, /接下来|下一步/);
});
