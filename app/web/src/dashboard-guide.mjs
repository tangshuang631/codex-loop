function safeText(value, fallback = "") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return String(value);
}

function firstDefined(...values) {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return "";
}

function formatRecentTime(value) {
  if (!value) {
    return "暂无";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "暂无";
  }

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatThreadDisplay(thread = {}) {
  const title = safeText(thread.threadTitle || thread.workspaceName, "已绑定线程");
  const threadId = safeText(thread.threadId, "");
  return threadId ? `${title}（${threadId}）` : "还没有绑定线程";
}

export function deriveDashboardGuide({
  snapshot = {},
  currentLoop = null,
  mobileView = {},
  pollStatus = "",
} = {}) {
  const mode = snapshot?.state?.mode || "stopped";
  const hasBoundThread = Boolean(snapshot?.thread?.threadId);
  const hasTranscript = (mobileView?.transcriptEntries || []).length > 0;
  const nextAction = firstDefined(
    mobileView?.strategy?.contextCard?.nextAction,
    mobileView?.suggestedAction,
    snapshot?.thread?.latestSummary,
    snapshot?.state?.recentSummary,
    "等待下一步",
  );
  const summary = firstDefined(
    snapshot?.thread?.latestCodexSummary,
    snapshot?.thread?.latestSummary,
    snapshot?.state?.recentSummary,
    mobileView?.bindingNote,
    "还没有新的 loop 进展。",
  );
  const lastUpdatedAt = firstDefined(
    snapshot?.thread?.latestHeartbeatAt,
    snapshot?.state?.lastHeartbeatAt,
    snapshot?.thread?.lastUpdatedAt,
  );

  const supportingMetrics = [
    {
      label: "当前项目",
      value: safeText(
        currentLoop?.projectName || snapshot?.config?.projectName,
        "未命名项目",
      ),
    },
    {
      label: "当前线程",
      value: hasBoundThread ? formatThreadDisplay(snapshot?.thread) : "还没有绑定线程",
    },
    {
      label: "最近同步",
      value: safeText(pollStatus, "等待同步"),
    },
    {
      label: "最近记录",
      value: formatRecentTime(lastUpdatedAt),
    },
  ];

  if (!hasBoundThread) {
    return {
      stage: "bind-thread",
      title: "先绑定一个可见线程，让 loop 真正接入你的项目",
      summary: safeText(
        mobileView?.bindingNote,
        "当前还没有绑定线程。首页状态会刷新，但还不会形成连续、可见的协作记录。",
      ),
      focusLabel: "现在最值得先做",
      focusValue: "去“管理”里填写线程标题和 thread id，保存后再开始 loop。",
      primaryAction: {
        id: "open-manage",
        label: "去绑定线程",
      },
      secondaryAction: {
        id: "open-create",
        label: "先新建 loop",
      },
      supportingMetrics,
    };
  }

  if (mode !== "running" && !hasTranscript) {
    return {
      stage: "start-loop",
      title: "线程已经接好，可以开始第一轮 loop 了",
      summary,
      focusLabel: "建议下一步",
      focusValue: safeText(nextAction, "点击“开始循环”，生成第一轮连续记录。"),
      primaryAction: {
        id: "start-loop",
        label: "开始循环",
      },
      secondaryAction: {
        id: "run-turn",
        label: "先续跑一轮",
      },
      supportingMetrics,
    };
  }

  return {
    stage: "active-loop",
    title: "当前 loop 正在推进，首页只保留最关键的判断和动作",
    summary,
    focusLabel: "接下来做什么",
    focusValue: safeText(nextAction, "继续查看最近改动，并决定下一轮任务。"),
    primaryAction: {
      id: "run-turn",
      label: "续跑一轮",
    },
    secondaryAction: {
      id: "open-manage",
      label: "调整设置",
    },
    supportingMetrics,
  };
}
