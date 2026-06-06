import React, { useEffect, useMemo, useState } from "react";

const API_BASE =
  import.meta.env.VITE_CODEX_LOOP_API_BASE || "http://127.0.0.1:4318/api";
const REQUEST_TIMEOUT_MS = 5000;

const modeTextMap = {
  running: "运行中",
  finalize_after_current: "收尾中",
  stopped: "已停止",
};

const continuationTextMap = {
  idle: "等待下一轮",
  dispatching: "正在给 Codex 续发下一条消息",
  error: "续发失败",
};

const launcherPhaseTextMap = {
  idle: "未启动",
  starting: "启动中",
  server_ready: "后端已就绪",
  web_ready: "前端已就绪",
  ready: "前后端已就绪",
  failed: "启动失败",
  stopped: "已停止",
};

function formatValue(value, fallback = "未设置") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return String(value);
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
      throw new Error(data.error || "请求失败");
    }
    return data;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function Metric({ label, value, muted = false }) {
  return (
    <div className={`metric ${muted ? "is-muted" : ""}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
    </div>
  );
}

function Section({ title, desc, actions, children }) {
  return (
    <section className="section-card">
      <div className="section-head">
        <div className="section-title-block">
          <h2>{title}</h2>
          {desc ? <p>{desc}</p> : null}
        </div>
        {actions ? <div className="section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function FeedCard({ title, body, meta, quiet = false }) {
  return (
    <article className={`feed-card ${quiet ? "is-quiet" : ""}`}>
      <span className="feed-card-meta">{meta}</span>
      <strong>{title}</strong>
      <p>{body}</p>
    </article>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [mobileView, setMobileView] = useState(null);
  const [launcherStatus, setLauncherStatus] = useState(null);
  const [loopRegistry, setLoopRegistry] = useState({ currentLoopId: "", loops: [] });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uiError, setUiError] = useState("");
  const [threadForm, setThreadForm] = useState({
    workspaceName: "",
    threadTitle: "",
    threadId: "",
    note: "",
    singleThreadMode: true,
  });
  const [threadSyncForm, setThreadSyncForm] = useState({
    lastUserInstructionSummary: "",
    lastAssistantActionSummary: "",
    latestCodexSummary: "",
  });
  const [loopForm, setLoopForm] = useState({
    loopName: "",
    runId: "",
    threadTitle: "",
    branch: "dev",
  });

  async function loadSnapshot() {
    setUiError("");

    try {
      const [nextSnapshot, nextLoops, nextMobile, nextLauncherStatus] = await Promise.all([
        requestJson("/snapshot"),
        requestJson("/loops"),
        requestJson("/mobile"),
        requestJson("/launcher-status"),
      ]);
      setSnapshot(nextSnapshot);
      setLoopRegistry(nextLoops);
      setMobileView(nextMobile);
      setLauncherStatus(nextLauncherStatus);
      setThreadForm({
        workspaceName: nextSnapshot.thread.workspaceName || "",
        threadTitle: nextSnapshot.thread.threadTitle || "",
        threadId: nextSnapshot.thread.threadId || "",
        note: nextSnapshot.thread.note || "",
        singleThreadMode: Boolean(nextSnapshot.thread.singleThreadMode),
      });
      setThreadSyncForm({
        lastUserInstructionSummary:
          nextSnapshot.thread.lastUserInstructionSummary || "",
        lastAssistantActionSummary:
          nextSnapshot.thread.lastAssistantActionSummary || "",
        latestCodexSummary: nextSnapshot.thread.latestCodexSummary || "",
      });
    } catch (error) {
      setUiError(
        error.name === "AbortError"
          ? "请求超时，请检查本地控制台服务是否仍在运行。"
          : error.message,
      );
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
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, []);

  async function withSubmit(action) {
    setSubmitting(true);
    setUiError("");
    try {
      await action();
      await loadSnapshot();
    } catch (error) {
      setUiError(
        error.name === "AbortError"
          ? "请求超时，本次操作未完成。"
          : error.message,
      );
    } finally {
      setSubmitting(false);
    }
  }

  const currentLoop = useMemo(
    () => loopRegistry.loops.find((loop) => loop.id === loopRegistry.currentLoopId) || null,
    [loopRegistry],
  );

  if (loading && !snapshot) {
    return <main className="app-shell loading-shell">正在加载循环状态…</main>;
  }

  const modeText =
    snapshot?.state.modeLabel || modeTextMap[snapshot?.state.mode] || "未知";
  const continuationStatus =
    continuationTextMap[snapshot?.thread.continuationStatus] || "尚未开始";
  const latestSummary =
    snapshot?.thread.latestSummary ||
    snapshot?.thread.latestCodexSummary ||
    snapshot?.state.recentSummary ||
    (snapshot?.state.startedAt ? "循环已启动，正在等待下一次可见进展。" : "");
  const latestEvent =
    snapshot?.thread.latestEventType ||
    snapshot?.state.events?.at(-1)?.type ||
    "暂无";
  const healthIssues = snapshot?.health?.issues || [];
  const transcriptEntries = mobileView?.transcriptEntries || [];
  const mobileSummary = mobileView?.summary?.recentSummary || latestSummary;
  const latestPrompt = mobileView?.latestPrompt || snapshot?.thread.lastDispatchPrompt;
  const primaryThreadName = formatValue(snapshot?.thread.threadTitle, "未绑定线程");
  const bindingNote = mobileView?.bindingNote || formatValue(snapshot?.thread.note, "暂无");
  const suggestedAction = mobileView?.suggestedAction || "建议先完成线程绑定，再开始循环。";
  const launcherPhase =
    launcherPhaseTextMap[launcherStatus?.phase] || formatValue(launcherStatus?.phase, "未知");
  const launcherApiUrl = formatValue(launcherStatus?.apiBaseUrl, "暂无");
  const launcherWebUrl = formatValue(launcherStatus?.webUrl, "暂无");
  const launcherNote = formatValue(launcherStatus?.note, "等待启动状态更新");
  const launcherError = formatValue(launcherStatus?.error, "无");

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="hero-tag">codex loop</span>
          <h1>{formatValue(currentLoop?.name || snapshot?.config.loopName, "未命名循环")}</h1>
          <p>
            这里专注回答三个问题：循环是否已经开始、现在卡在哪一步、最近一次给 Codex
            发了什么。桌面端可控制，手机端可查看最近对话镜像、绑定状态和建议动作。
          </p>
          <div className="hero-status-row">
            <span className={`status-pill ${snapshot?.health?.ok ? "" : "is-danger"}`}>
              {snapshot?.health?.ok ? "状态正常" : "需要处理异常"}
            </span>
            <span className="status-pill is-soft">{continuationStatus}</span>
          </div>
        </div>

        <div className="hero-metrics">
          <Metric label="当前模式" value={modeText} />
          <Metric label="绑定线程" value={primaryThreadName} muted={!snapshot?.thread.threadId} />
          <Metric
            label="已续发轮次"
            value={formatValue(snapshot?.thread.continuationCycleCount, "0")}
          />
          <Metric label="最近事件" value={latestEvent} />
        </div>
      </section>

      {uiError ? <div className="error-banner">{uiError}</div> : null}

      <div className="layout-grid">
        <Section
          title="运行控制"
          desc="开始、立即续跑、停止都放在这里。长任务期间也会持续自动刷新。"
          actions={
            <>
              <button
                type="button"
                className="primary-button"
                disabled={submitting}
                onClick={() => withSubmit(() => requestJson("/start", { method: "POST" }))}
              >
                开始循环
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={submitting}
                onClick={() => withSubmit(() => requestJson("/run-turn", { method: "POST" }))}
              >
                立即续跑一轮
              </button>
              <button
                type="button"
                className="ghost-button"
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
                停止
              </button>
            </>
          }
        >
          <div className="summary-stack">
            <Metric label="启动时间" value={formatValue(snapshot?.state.startedAt, "尚未启动")} />
            <Metric label="最近续发" value={formatValue(snapshot?.thread.lastDispatchAt, "暂无")} />
            <Metric label="最近完成" value={formatValue(snapshot?.thread.lastCompletionAt, "暂无")} />
            <Metric label="最近摘要" value={formatValue(latestSummary, "暂无")} />
          </div>
        </Section>

        <Section
          title="可见对话进度"
          desc="优先显示你最关心的真实续发内容，尽量模拟真人在同一线程里持续接话。"
        >
          <div className="feed-stack">
            <FeedCard
              meta="最近写给 Codex"
              title={continuationStatus}
              body={formatValue(latestPrompt, "暂时还没有续发内容。")}
            />
            <FeedCard
              meta="最近 Codex 摘要"
              title={formatValue(snapshot?.thread.latestCodexSummary, "暂无")}
              body={formatValue(
                snapshot?.thread.lastAssistantActionSummary || latestSummary,
                "等待下一次可见反馈。",
              )}
              quiet
            />
          </div>
        </Section>

        <Section
          title="循环管理"
          desc="创建新 loop、切换当前 loop、查看每个 loop 绑定到哪个可见线程。"
        >
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void withSubmit(async () => {
                await requestJson("/loops", {
                  method: "POST",
                  body: JSON.stringify(loopForm),
                });
                setLoopForm({
                  loopName: "",
                  runId: "",
                  threadTitle: "",
                  branch: "dev",
                });
              });
            }}
          >
            <label>
              <span>新循环名称</span>
              <input
                value={loopForm.loopName}
                onChange={(event) =>
                  setLoopForm((current) => ({ ...current, loopName: event.target.value }))
                }
              />
            </label>
            <label>
              <span>Run ID</span>
              <input
                value={loopForm.runId}
                onChange={(event) =>
                  setLoopForm((current) => ({ ...current, runId: event.target.value }))
                }
              />
            </label>
            <label>
              <span>线程标题</span>
              <input
                value={loopForm.threadTitle}
                onChange={(event) =>
                  setLoopForm((current) => ({ ...current, threadTitle: event.target.value }))
                }
              />
            </label>
            <label>
              <span>分支</span>
              <input
                value={loopForm.branch}
                onChange={(event) =>
                  setLoopForm((current) => ({ ...current, branch: event.target.value }))
                }
              />
            </label>
            <button type="submit" className="primary-button" disabled={submitting}>
              创建循环
            </button>
          </form>

          <div className="loop-list">
            {loopRegistry.loops.map((loop) => (
              <div key={loop.id} className={`loop-item ${loop.isCurrent ? "is-current" : ""}`}>
                <div className="loop-item-copy">
                  <strong>{loop.name}</strong>
                  <span>{loop.isCurrent ? "当前正在查看" : "可切换"}</span>
                  <span>
                    {loop.boundThreadId
                      ? `已绑定：${loop.boundThreadTitle || loop.boundThreadId}`
                      : "还没有绑定可见线程"}
                  </span>
                </div>
                <div className="loop-item-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={submitting || loop.isCurrent}
                    onClick={() =>
                      withSubmit(() =>
                        requestJson("/loops/select", {
                          method: "POST",
                          body: JSON.stringify({ loopId: loop.id }),
                        }),
                      )
                    }
                  >
                    切换
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={submitting || loop.isCurrent}
                    onClick={() =>
                      withSubmit(() =>
                        requestJson("/loops/delete", {
                          method: "POST",
                          body: JSON.stringify({ loopId: loop.id }),
                        }),
                      )
                    }
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          title="线程绑定"
          desc="把当前 loop 固定到一个真实可见线程，让续发记录能在 Codex 桌面端持续看到。"
        >
          <form
            className="form-stack"
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
            <label>
              <span>项目名称</span>
              <input
                value={threadForm.workspaceName}
                onChange={(event) =>
                  setThreadForm((current) => ({ ...current, workspaceName: event.target.value }))
                }
              />
            </label>
            <label>
              <span>线程标题</span>
              <input
                value={threadForm.threadTitle}
                onChange={(event) =>
                  setThreadForm((current) => ({ ...current, threadTitle: event.target.value }))
                }
              />
            </label>
            <label>
              <span>线程 ID</span>
              <input
                value={threadForm.threadId}
                onChange={(event) =>
                  setThreadForm((current) => ({ ...current, threadId: event.target.value }))
                }
              />
            </label>
            <label>
              <span>备注</span>
              <input
                value={threadForm.note}
                onChange={(event) =>
                  setThreadForm((current) => ({ ...current, note: event.target.value }))
                }
              />
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={threadForm.singleThreadMode}
                onChange={(event) =>
                  setThreadForm((current) => ({ ...current, singleThreadMode: event.target.checked }))
                }
              />
              <span>固定在同一个可见线程里持续续跑</span>
            </label>
            <button type="submit" className="primary-button" disabled={submitting}>
              保存线程绑定
            </button>
          </form>
        </Section>

        <Section
          title="续跑上下文"
          desc="这里维护下一条消息应当带上的用户意图、上轮动作和最近总结。"
        >
          <form
            className="form-stack"
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
            <label>
              <span>用户意图摘要</span>
              <textarea
                rows="3"
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
              <span>上一轮 Codex 动作</span>
              <textarea
                rows="3"
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
              <span>最近 Codex 总结</span>
              <textarea
                rows="4"
                value={threadSyncForm.latestCodexSummary}
                onChange={(event) =>
                  setThreadSyncForm((current) => ({
                    ...current,
                    latestCodexSummary: event.target.value,
                  }))
                }
              />
            </label>
            <button type="submit" className="primary-button" disabled={submitting}>
              保存续跑上下文
            </button>
          </form>
        </Section>

        <Section
          title="手机查看"
          desc="这块是移动端优先的只读视图。手机上重点看最近摘要、最近续发、绑定提示、建议动作和聊天镜像。"
        >
          <div className="mobile-panel">
            <div className="mobile-panel-top">
              <Metric label="手机端当前模式" value={mobileView?.loop?.modeLabel || modeText} />
              <Metric
                label="手机端绑定线程"
                value={formatValue(mobileView?.thread?.title || primaryThreadName, "未绑定")}
              />
            </div>

            <div className="status-card">
              <span className="status-label">线程绑定提示</span>
              <p>{formatValue(bindingNote, "暂无")}</p>
            </div>

            <div className="status-card">
              <span className="status-label">当前建议动作</span>
              <p>{formatValue(suggestedAction, "暂无")}</p>
            </div>

            <div className="status-card status-card-wide">
              <span className="status-label">最近摘要</span>
              <p>{formatValue(mobileSummary, "暂无摘要")}</p>
            </div>

            <div className="status-card status-card-wide">
              <span className="status-label">最近发给 Codex 的消息</span>
              <p>{formatValue(latestPrompt, "暂无")}</p>
            </div>

            <div className="transcript-list">
              {transcriptEntries.length === 0 ? (
                <div className="transcript-card">
                  <span className="status-label">最近聊天记录</span>
                  <p>还没有可供手机查看的记录。</p>
                </div>
              ) : (
                transcriptEntries.map((entry, index) => (
                  <div key={`${entry.at}-${entry.activeTask}-${index}`} className="transcript-card">
                    <span className="status-label">{formatValue(entry.at, "未知时间")}</span>
                    <strong>{formatValue(entry.activeTask, "未记录任务")}</strong>
                    <p>{formatValue(entry.summary, "暂无摘要")}</p>
                    <p className="transcript-note">{formatValue(entry.note, "暂无备注")}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </Section>

        <Section
          title="启动状态"
          desc="直接显示 dev 控制台当前启动到哪一步、真实端口是什么，以及是否已经可访问。"
        >
          <div className="summary-stack">
            <Metric label="当前阶段" value={launcherPhase} />
            <Metric
              label="后端地址"
              value={launcherApiUrl}
              muted={!launcherStatus?.apiBaseUrl}
            />
            <Metric
              label="前端地址"
              value={launcherWebUrl}
              muted={!launcherStatus?.webUrl}
            />
            <Metric label="状态说明" value={launcherNote} muted={!launcherStatus?.note} />
          </div>

          <details className="meta-details">
            <summary>展开启动细节</summary>
            <div className="meta-grid">
              <Metric label="后端就绪" value={launcherStatus?.serverReady ? "是" : "否"} />
              <Metric label="前端就绪" value={launcherStatus?.webReady ? "是" : "否"} />
              <Metric
                label="启动错误"
                value={launcherError}
                muted={!launcherStatus?.error}
              />
              <Metric
                label="状态更新时间"
                value={formatValue(launcherStatus?.updatedAt, "暂无")}
              />
            </div>
          </details>
        </Section>

        <Section
          title="健康检查"
          desc="尽量只保留真正有帮助的诊断，不再直接把路径和噪音摊在主界面上。"
        >
          <div className="summary-stack">
            <Metric label="整体结果" value={snapshot?.health?.ok ? "正常" : "异常"} />
            <Metric
              label="异常项"
              value={healthIssues.length ? healthIssues.join(" / ") : "无"}
              muted={!healthIssues.length}
            />
            <Metric label="最近事件" value={latestEvent} />
            <Metric
              label="续发错误"
              value={formatValue(snapshot?.thread.lastContinuationError, "无")}
              muted={!snapshot?.thread.lastContinuationError}
            />
          </div>

          <details className="meta-details">
            <summary>展开次要信息</summary>
            <div className="meta-grid">
              <Metric label="Run ID" value={formatValue(snapshot?.config.currentRunId)} />
              <Metric label="线程 ID" value={formatValue(snapshot?.thread.threadId, "未绑定")} />
              <Metric
                label="最后心跳"
                value={formatValue(snapshot?.thread.latestHeartbeatAt, "暂无")}
              />
            </div>
          </details>
        </Section>
      </div>
    </main>
  );
}
