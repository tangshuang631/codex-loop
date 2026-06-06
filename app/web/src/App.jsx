import React, { useEffect, useState } from "react";

const API_BASE =
  import.meta.env.VITE_CODEX_LOOP_API_BASE || "http://127.0.0.1:4318/api";
const REQUEST_TIMEOUT_MS = 5000;

const modeToneMap = {
  running: "tone-running",
  finalize_after_current: "tone-finalize",
  stopped: "tone-stopped",
};

const modeTextMap = {
  running: "\u8fd0\u884c\u4e2d",
  finalize_after_current: "\u6536\u5c3e\u4e2d",
  stopped: "\u5df2\u505c\u6b62",
};

function formatValue(value, fallback = "\u672a\u8bbe\u7f6e") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  return String(value);
}

function SummaryItem({ label, value, muted }) {
  return (
    <div className={`summary-item ${muted ? "is-muted" : ""}`}>
      <span className="summary-label">{label}</span>
      <span className="summary-value">{value}</span>
    </div>
  );
}

function PathRow({ label, value }) {
  return (
    <div className="path-row">
      <span className="path-label">{label}</span>
      <code className="path-value">{value}</code>
    </div>
  );
}

function SectionCard({ title, kicker, children, wide }) {
  return (
    <section className={`section-card ${wide ? "is-wide" : ""}`}>
      <div className="section-head">
        <span className="section-kicker">{kicker}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

async function requestJson(targetPath, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}${targetPath}`, {
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      ...options,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }

    return data;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uiError, setUiError] = useState("");
  const [budgetForm, setBudgetForm] = useState({
    maxMinutes: "",
    maxTokens: "",
    finalizeLeadMinutes: "",
    finalizeLeadTokens: "",
  });
  const [threadForm, setThreadForm] = useState({
    workspaceName: "",
    threadTitle: "",
    threadId: "",
    note: "",
    singleThreadMode: true,
  });
  const [overrideForm, setOverrideForm] = useState({
    allowFinishCurrentTask: true,
    requirePushBeforeStop: false,
    requireVisiblePrimaryThread: true,
  });
  const [heartbeatForm, setHeartbeatForm] = useState({
    activeTask: "",
    progressSummary: "",
    note: "",
    consumedTokens: "",
  });
  const [threadSyncForm, setThreadSyncForm] = useState({
    lastUserInstructionSummary: "",
    lastAssistantActionSummary: "",
    latestCodexSummary: "",
  });

  async function loadSnapshot() {
    setLoading(true);
    setUiError("");

    try {
      const nextSnapshot = await requestJson("/snapshot");
      setSnapshot(nextSnapshot);
      setBudgetForm({
        maxMinutes: nextSnapshot.config.budgets.maxMinutes,
        maxTokens: nextSnapshot.config.budgets.maxTokens,
        finalizeLeadMinutes: nextSnapshot.config.budgets.finalizeLeadMinutes,
        finalizeLeadTokens: nextSnapshot.config.budgets.finalizeLeadTokens,
      });
      setThreadForm({
        workspaceName: nextSnapshot.thread.workspaceName || "",
        threadTitle: nextSnapshot.thread.threadTitle || "",
        threadId: nextSnapshot.thread.threadId || "",
        note: nextSnapshot.thread.note || "",
        singleThreadMode: Boolean(nextSnapshot.thread.singleThreadMode),
      });
      setOverrideForm({
        allowFinishCurrentTask:
          nextSnapshot.profile?.resolved?.stopPolicy?.allowFinishCurrentTask ??
          true,
        requirePushBeforeStop:
          nextSnapshot.profile?.resolved?.stopPolicy?.requirePushBeforeStop ??
          false,
        requireVisiblePrimaryThread:
          nextSnapshot.profile?.resolved?.threadPolicy
            ?.requireVisiblePrimaryThread ?? true,
      });
      setHeartbeatForm({
        activeTask: nextSnapshot.state.activeTask || "",
        progressSummary:
          nextSnapshot.state.recentSummary || nextSnapshot.state.lastNote || "",
        note: nextSnapshot.state.lastNote || "",
        consumedTokens:
          nextSnapshot.state.consumedTokens !== undefined
            ? String(nextSnapshot.state.consumedTokens)
            : "",
      });
      setThreadSyncForm({
        lastUserInstructionSummary:
          nextSnapshot.thread.lastUserInstructionSummary || "",
        lastAssistantActionSummary:
          nextSnapshot.thread.lastAssistantActionSummary || "",
        latestCodexSummary: nextSnapshot.thread.latestCodexSummary || "",
      });
    } catch (error) {
      const message =
        error.name === "AbortError"
          ? "\u8bf7\u6c42\u8d85\u65f6\uff0c\u63a7\u5236\u53f0\u4fdd\u6301\u53ef\u7528\uff0c\u8bf7\u68c0\u67e5\u672c\u5730\u670d\u52a1\u72b6\u6001\u3002"
          : error.message;
      setUiError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadSnapshot();
    }, 8000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  async function withSubmit(action) {
    setSubmitting(true);
    setUiError("");

    try {
      const nextSnapshot = await action();
      setSnapshot(nextSnapshot);
    } catch (error) {
      const message =
        error.name === "AbortError"
          ? "\u8bf7\u6c42\u8d85\u65f6\uff0c\u672c\u6b21\u64cd\u4f5c\u672a\u5b8c\u6210\u3002"
          : error.message;
      setUiError(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !snapshot) {
    return (
      <main className="app-shell loading-shell">
        {"\u6b63\u5728\u8bfb\u53d6 codex_loop \u72b6\u6001..."}
      </main>
    );
  }

  const mode = snapshot?.state.mode || "stopped";
  const modeText = snapshot?.state.modeLabel || modeTextMap[mode];
  const titleLine = snapshot?.thread.workspaceName
    ? `${snapshot.thread.workspaceName} / ${snapshot.thread.threadTitle}`
    : snapshot?.thread.threadTitle || "\u672a\u7ed1\u5b9a\u7ebf\u7a0b";

  return (
    <main className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <header className="top-hero">
        <div className="top-hero-copy">
          <span className="eyebrow">codex_loop</span>
          <h1>{titleLine}</h1>
          <p>
            {
              "\u4e00\u4e2a\u4e13\u6ce8\u4e8e\u957f\u65f6 Codex \u5f00\u53d1\u5faa\u73af\u7684\u672c\u5730\u63a7\u5236\u53f0\u3002\u4e3b\u5386\u53f2\u7559\u5728 Codex \u7ebf\u7a0b\uff0c\u672c\u5730\u53ea\u8d1f\u8d23\u6536\u5c3e\u3001\u9884\u7b97\u3001\u6062\u590d\u548c\u8ffd\u8e2a\u3002"
            }
          </p>
        </div>

        <div className="hero-status-cluster">
          <div className={`mode-pill ${modeToneMap[mode] || "tone-stopped"}`}>
            <span className="mode-dot" />
            <span>{modeText}</span>
          </div>
          <div className="thread-chip">
            <span>{"\u4e3b\u7ebf\u7a0b ID"}</span>
            <strong>{formatValue(snapshot?.thread.threadId)}</strong>
          </div>
          <div className="thread-chip">
            <span>{"\u6700\u8fd1\u9519\u8bef"}</span>
            <strong>{formatValue(snapshot?.error.message, "\u65e0")}</strong>
          </div>
        </div>
      </header>

      {uiError ? (
        <div className="error-banner">
          <span>{"\u8bf7\u6c42\u5931\u8d25"}</span>
          <strong>{uiError}</strong>
        </div>
      ) : null}

      <div className="console-grid">
        <SectionCard title="\u5faa\u73af\u63a7\u5236" kicker="CONTROL">
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              disabled={submitting}
              onClick={() =>
                withSubmit(() => requestJson("/start", { method: "POST" }))
              }
            >
              {"\u5f00\u59cb\u8fd0\u884c"}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={submitting}
              onClick={() =>
                withSubmit(() =>
                  requestJson("/stop", {
                    method: "POST",
                    body: JSON.stringify({ reason: "console graceful stop" }),
                  }),
                )
              }
            >
              {"\u8bf7\u6c42\u4f18\u96c5\u505c\u6b62"}
            </button>
          </div>

          <div className="summary-grid">
            <SummaryItem label="Run ID" value={formatValue(snapshot?.config.currentRunId)} />
            <SummaryItem
              label="\u5de5\u4f5c\u533a\u8def\u5f84"
              value={formatValue(snapshot?.paths.workspaceRoot)}
            />
            <SummaryItem
              label="\u5206\u652f"
              value={formatValue(snapshot?.config.branch)}
            />
            <SummaryItem
              label="\u5f53\u524d\u4efb\u52a1"
              value={formatValue(snapshot?.state.activeTask, "\u5c1a\u672a\u5199\u5165")}
              muted={!snapshot?.state.activeTask}
            />
          </div>
        </SectionCard>

        <SectionCard title="\u9884\u7b97\u4e0e\u6536\u5c3e" kicker="BUDGET">
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void withSubmit(() =>
                requestJson("/budgets", {
                  method: "POST",
                  body: JSON.stringify({
                    maxMinutes: Number(budgetForm.maxMinutes),
                    maxTokens: Number(budgetForm.maxTokens),
                    finalizeLeadMinutes: Number(budgetForm.finalizeLeadMinutes),
                    finalizeLeadTokens: Number(budgetForm.finalizeLeadTokens),
                  }),
                }),
              );
            }}
          >
            <label>
              <span>{"\u6700\u5927\u65f6\u957f\uff08\u5206\u949f\uff09"}</span>
              <input
                value={budgetForm.maxMinutes}
                onChange={(event) =>
                  setBudgetForm((current) => ({
                    ...current,
                    maxMinutes: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>{"\u6700\u5927 Token"}</span>
              <input
                value={budgetForm.maxTokens}
                onChange={(event) =>
                  setBudgetForm((current) => ({
                    ...current,
                    maxTokens: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>{"\u63d0\u524d\u6536\u5c3e\u65f6\u957f"}</span>
              <input
                value={budgetForm.finalizeLeadMinutes}
                onChange={(event) =>
                  setBudgetForm((current) => ({
                    ...current,
                    finalizeLeadMinutes: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>{"\u63d0\u524d\u6536\u5c3e Token"}</span>
              <input
                value={budgetForm.finalizeLeadTokens}
                onChange={(event) =>
                  setBudgetForm((current) => ({
                    ...current,
                    finalizeLeadTokens: event.target.value,
                  }))
                }
              />
            </label>

            <button type="submit" className="ghost-button" disabled={submitting}>
              {"\u4fdd\u5b58\u9884\u7b97"}
            </button>
          </form>
        </SectionCard>

        <SectionCard title="Heartbeat \u6458\u8981" kicker="HEARTBEAT">
          <form
            className="thread-form"
            onSubmit={(event) => {
              event.preventDefault();
              void withSubmit(() =>
                requestJson("/heartbeat", {
                  method: "POST",
                  body: JSON.stringify({
                    activeTask: heartbeatForm.activeTask,
                    progressSummary: heartbeatForm.progressSummary,
                    note: heartbeatForm.note,
                    consumedTokens: Number(heartbeatForm.consumedTokens || 0),
                  }),
                }),
              );
            }}
          >
            <div className="form-grid">
              <label>
                <span>{"\u5f53\u524d\u4efb\u52a1"}</span>
                <input
                  value={heartbeatForm.activeTask}
                  onChange={(event) =>
                    setHeartbeatForm((current) => ({
                      ...current,
                      activeTask: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>{"\u8fdb\u5c55\u6458\u8981"}</span>
                <input
                  value={heartbeatForm.progressSummary}
                  onChange={(event) =>
                    setHeartbeatForm((current) => ({
                      ...current,
                      progressSummary: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>{"\u9644\u52a0\u8bf4\u660e"}</span>
                <input
                  value={heartbeatForm.note}
                  onChange={(event) =>
                    setHeartbeatForm((current) => ({
                      ...current,
                      note: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>{"\u7d2f\u79ef Token"}</span>
                <input
                  value={heartbeatForm.consumedTokens}
                  onChange={(event) =>
                    setHeartbeatForm((current) => ({
                      ...current,
                      consumedTokens: event.target.value,
                    }))
                  }
                />
              </label>
            </div>

            <button type="submit" className="ghost-button" disabled={submitting}>
              {"\u5199\u5165 Heartbeat"}
            </button>
          </form>
        </SectionCard>

        <SectionCard title="\u7ebf\u7a0b\u7ed1\u5b9a" kicker="THREAD" wide>
          <form
            className="thread-form"
            onSubmit={(event) => {
              event.preventDefault();
              void withSubmit(() =>
                requestJson("/thread", {
                  method: "POST",
                  body: JSON.stringify(threadForm),
                }),
              );
            }}
          >
            <div className="form-grid wide-grid">
              <label>
                <span>{"\u9879\u76ee\u540d"}</span>
                <input
                  value={threadForm.workspaceName}
                  onChange={(event) =>
                    setThreadForm((current) => ({
                      ...current,
                      workspaceName: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>{"\u7ebf\u7a0b\u6807\u9898"}</span>
                <input
                  value={threadForm.threadTitle}
                  onChange={(event) =>
                    setThreadForm((current) => ({
                      ...current,
                      threadTitle: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>{"\u7ebf\u7a0b ID"}</span>
                <input
                  value={threadForm.threadId}
                  onChange={(event) =>
                    setThreadForm((current) => ({
                      ...current,
                      threadId: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>{"\u5907\u6ce8"}</span>
                <input
                  value={threadForm.note}
                  onChange={(event) =>
                    setThreadForm((current) => ({
                      ...current,
                      note: event.target.value,
                    }))
                  }
                />
              </label>
            </div>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={threadForm.singleThreadMode}
                onChange={(event) =>
                  setThreadForm((current) => ({
                    ...current,
                    singleThreadMode: event.target.checked,
                  }))
                }
              />
              <span>{"\u56fa\u5b9a\u5355\u7ebf\u7a0b\u8fde\u7eed\u5386\u53f2"}</span>
            </label>

            <button type="submit" className="ghost-button" disabled={submitting}>
              {"\u4fdd\u5b58\u7ebf\u7a0b\u7ed1\u5b9a"}
            </button>
          </form>

          <form
            className="thread-form thread-sync-form"
            onSubmit={(event) => {
              event.preventDefault();
              void withSubmit(() =>
                requestJson("/thread/sync", {
                  method: "POST",
                  body: JSON.stringify(threadSyncForm),
                }),
              );
            }}
          >
            <div className="form-grid">
              <label>
                <span>{"\u6700\u8fd1\u7528\u6237\u610f\u56fe\u6458\u8981"}</span>
                <input
                  value={threadSyncForm.lastUserInstructionSummary}
                  onChange={(event) =>
                    setThreadSyncForm((current) => ({
                      ...current,
                      lastUserInstructionSummary: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>{"\u6700\u8fd1 Codex \u52a8\u4f5c\u6458\u8981"}</span>
                <input
                  value={threadSyncForm.lastAssistantActionSummary}
                  onChange={(event) =>
                    setThreadSyncForm((current) => ({
                      ...current,
                      lastAssistantActionSummary: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>{"\u7ebf\u7a0b\u603b\u6458\u8981"}</span>
                <input
                  value={threadSyncForm.latestCodexSummary}
                  onChange={(event) =>
                    setThreadSyncForm((current) => ({
                      ...current,
                      latestCodexSummary: event.target.value,
                    }))
                  }
                />
              </label>
            </div>

            <button type="submit" className="ghost-button" disabled={submitting}>
              {"\u540c\u6b65 Codex \u7ebf\u7a0b\u955c\u50cf"}
            </button>
          </form>

          <div className="summary-grid thread-mirror-grid">
            <SummaryItem
              label="\u955c\u50cf\u6a21\u5f0f"
              value={formatValue(snapshot?.thread.latestModeLabel, "\u6682\u65e0")}
            />
            <SummaryItem
              label="\u955c\u50cf\u6700\u8fd1\u4efb\u52a1"
              value={formatValue(snapshot?.thread.latestActiveTask, "\u6682\u65e0")}
              muted={!snapshot?.thread.latestActiveTask}
            />
            <SummaryItem
              label="\u955c\u50cf\u6700\u8fd1\u6458\u8981"
              value={formatValue(snapshot?.thread.latestSummary, "\u6682\u65e0")}
              muted={!snapshot?.thread.latestSummary}
            />
            <SummaryItem
              label="\u955c\u50cf\u6700\u8fd1 Heartbeat"
              value={formatValue(snapshot?.thread.latestHeartbeatAt, "\u6682\u65e0")}
            />
            <SummaryItem
              label="\u7528\u6237\u610f\u56fe\u6458\u8981"
              value={formatValue(
                snapshot?.thread.lastUserInstructionSummary,
                "\u6682\u65e0",
              )}
              muted={!snapshot?.thread.lastUserInstructionSummary}
            />
            <SummaryItem
              label="Codex \u52a8\u4f5c\u6458\u8981"
              value={formatValue(
                snapshot?.thread.lastAssistantActionSummary,
                "\u6682\u65e0",
              )}
              muted={!snapshot?.thread.lastAssistantActionSummary}
            />
            <SummaryItem
              label="\u7ebf\u7a0b\u603b\u6458\u8981"
              value={formatValue(snapshot?.thread.latestCodexSummary, "\u6682\u65e0")}
              muted={!snapshot?.thread.latestCodexSummary}
            />
          </div>
        </SectionCard>

        <SectionCard title="Loop \u7ec6\u8282\u5fae\u8c03" kicker="PROFILE">
          <form
            className="thread-form"
            onSubmit={(event) => {
              event.preventDefault();
              void withSubmit(() =>
                requestJson("/overrides", {
                  method: "POST",
                  body: JSON.stringify({
                    stopPolicy: {
                      allowFinishCurrentTask: overrideForm.allowFinishCurrentTask,
                      requirePushBeforeStop: overrideForm.requirePushBeforeStop,
                    },
                    threadPolicy: {
                      requireVisiblePrimaryThread:
                        overrideForm.requireVisiblePrimaryThread,
                    },
                  }),
                }),
              );
            }}
          >
            <div className="summary-grid">
              <SummaryItem
                label="\u9002\u914d\u5668"
                value={formatValue(snapshot?.profile?.adapter?.displayName)}
              />
              <SummaryItem
                label="\u4e25\u683c\u5ea6"
                value={formatValue(snapshot?.profile?.resolved?.verification?.strictness)}
              />
            </div>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={overrideForm.allowFinishCurrentTask}
                onChange={(event) =>
                  setOverrideForm((current) => ({
                    ...current,
                    allowFinishCurrentTask: event.target.checked,
                  }))
                }
              />
              <span>{"\u505c\u6b62\u65f6\u5141\u8bb8\u5148\u5b8c\u6210\u5f53\u524d\u4efb\u52a1"}</span>
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={overrideForm.requirePushBeforeStop}
                onChange={(event) =>
                  setOverrideForm((current) => ({
                    ...current,
                    requirePushBeforeStop: event.target.checked,
                  }))
                }
              />
              <span>{"\u505c\u6b62\u524d\u8981\u6c42\u81ea\u52a8 push"}</span>
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={overrideForm.requireVisiblePrimaryThread}
                onChange={(event) =>
                  setOverrideForm((current) => ({
                    ...current,
                    requireVisiblePrimaryThread: event.target.checked,
                  }))
                }
              />
              <span>{"\u8981\u6c42\u53ef\u89c1\u4e3b\u7ebf\u7a0b\u5386\u53f2"}</span>
            </label>

            <button type="submit" className="ghost-button" disabled={submitting}>
              {"\u4fdd\u5b58\u5fae\u8c03"}
            </button>
          </form>
        </SectionCard>

        <SectionCard title="\u72b6\u6001\u901f\u89c8" kicker="STATUS">
          <div className="summary-grid">
            <SummaryItem label="\u5f53\u524d\u6a21\u5f0f" value={modeText} />
            <SummaryItem
              label="\u6700\u8fd1 Heartbeat"
              value={formatValue(snapshot?.state.lastHeartbeatAt, "\u6682\u65e0")}
            />
            <SummaryItem
              label="\u6536\u5c3e\u6807\u8bb0"
              value={
                snapshot?.state.finalizeRequested
                  ? "\u5df2\u8bf7\u6c42"
                  : "\u672a\u8bf7\u6c42"
              }
            />
            <SummaryItem
              label="\u505c\u6b62\u6807\u8bb0"
              value={
                snapshot?.state.stopRequested
                  ? "\u5df2\u8bf7\u6c42"
                  : "\u672a\u8bf7\u6c42"
              }
            />
            <SummaryItem
              label="\u6700\u8fd1\u4e8b\u4ef6"
              value={formatValue(snapshot?.state.events?.at(-1)?.type, "\u6682\u65e0")}
            />
            <SummaryItem
              label="\u8fdb\u5c55\u6458\u8981"
              value={formatValue(snapshot?.state.recentSummary, "\u6682\u65e0")}
              muted={!snapshot?.state.recentSummary}
            />
          </div>
        </SectionCard>

        <SectionCard title="\u9519\u8bef\u4e0e\u8def\u5f84" kicker="RECOVERY" wide>
          <div className="path-stack">
            <PathRow
              label="\u9519\u8bef\u4fe1\u606f"
              value={formatValue(snapshot?.error.message, "\u65e0")}
            />
            <PathRow
              label="\u9002\u914d\u5668\u8bf4\u660e"
              value={formatValue(snapshot?.profile?.adapter?.description, "\u65e0")}
            />
            <PathRow
              label="\u72b6\u6001\u6587\u4ef6"
              value={formatValue(snapshot?.paths.statePath)}
            />
            <PathRow
              label="\u65e5\u5fd7\u6587\u4ef6"
              value={formatValue(snapshot?.paths.logPath)}
            />
            <PathRow
              label="Transcript Mirror"
              value={formatValue(snapshot?.paths.transcriptPath)}
            />
            <PathRow
              label="\u8fd0\u884c\u76ee\u5f55"
              value={formatValue(snapshot?.paths.runtimeDir)}
            />
          </div>
        </SectionCard>
      </div>
    </main>
  );
}
