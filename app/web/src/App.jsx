import React, { useEffect, useMemo, useRef, useState } from "react";

const API_BASE =
  import.meta.env.VITE_CODEX_LOOP_API_BASE || "http://127.0.0.1:4318/api";
const REQUEST_TIMEOUT_MS = 8000;
const ACTIVE_POLL_MS = 5000;
const IDLE_POLL_MS = 12000;

const modeTextMap = {
  running: "运行中",
  finalize_after_current: "收尾中",
  stopped: "已停止",
};

const continuationTextMap = {
  idle: "等待下一轮",
  dispatching: "正在向 Codex 发送下一条消息",
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

function formatTime(value, fallback = "暂无") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupLoopsByProject(loops = []) {
  return loops.reduce((groups, loop) => {
    const projectName = loop.projectName || "未分类项目";
    if (!groups[projectName]) {
      groups[projectName] = [];
    }
    groups[projectName].push(loop);
    return groups;
  }, {});
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

function DetailCard({ title, body, meta, quiet = false }) {
  return (
    <article className={`detail-card ${quiet ? "is-quiet" : ""}`}>
      {meta ? <span className="detail-card-meta">{meta}</span> : null}
      <strong>{title}</strong>
      <p>{body}</p>
    </article>
  );
}

function Section({ title, desc, actions, children }) {
  return (
    <section className="workspace-section">
      <div className="workspace-section-head">
        <div className="workspace-section-title">
          <h2>{title}</h2>
          {desc ? <p>{desc}</p> : null}
        </div>
        {actions ? <div className="workspace-section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function StatusPill({ text, tone = "default", active = false }) {
  return (
    <span
      className={[
        "status-pill",
        tone === "danger" ? "is-danger" : "",
        tone === "soft" ? "is-soft" : "",
        active ? "is-live" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {active ? <span className="status-dot" aria-hidden="true" /> : null}
      {text}
    </span>
  );
}

function SidebarSummary({ currentLoop, loopRegistry, snapshot, pollStatus }) {
  return (
    <div className="sidebar-summary-card">
      <span className="sidebar-summary-label">当前焦点</span>
      <strong>{formatValue(currentLoop?.name || snapshot?.config?.loopName, "未命名 loop")}</strong>
      <p>{formatValue(currentLoop?.projectName || snapshot?.config?.projectName, "未命名项目")}</p>
      <div className="sidebar-summary-meta">
        <span>{loopRegistry.loops.length} 个 loop</span>
        <span>{snapshot?.thread?.threadId ? "已绑定线程" : "待绑定线程"}</span>
        <span>{pollStatus}</span>
      </div>
    </div>
  );
}

function SkeletonBlock() {
  return (
    <main className="app-shell loading-shell">
      <div className="skeleton-shell">
        <div className="skeleton-card skeleton-card-large" />
        <div className="skeleton-grid">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      </div>
    </main>
  );
}

function LoopCreationAssistantPane({
  assistantState,
  assistantAnswer,
  setAssistantAnswer,
  submitting,
  onSubmit,
}) {
  const currentQuestion = assistantState?.currentQuestion;
  const draft = assistantState?.draft || {};
  const createdLoop = assistantState?.createdLoop?.loop;

  return (
    <div className="sidebar-form assistant-pane">
      <h3>对话创建 Loop</h3>
      <p className="sidebar-help">
        像和助手对话一样创建 loop。这里会自动检测项目路径、Git、规则文档和推荐分支，再生成左侧可管理的新 loop。
      </p>

      {assistantState?.status === "completed" && createdLoop ? (
        <div className="assistant-result">
          <DetailCard
            meta="创建完成"
            title={createdLoop.name}
            body={`已归入项目：${createdLoop.projectName}\n分支：${formatValue(createdLoop.branch)}\n工作区：${formatValue(createdLoop.workspaceRoot)}`}
          />
        </div>
      ) : null}

      {currentQuestion ? (
        <>
          <div className="assistant-thread">
            <DetailCard
              meta="当前问题"
              title={currentQuestion.id}
              body={currentQuestion.prompt}
              quiet
            />
            <div className="assistant-draft-grid">
              <Metric label="项目路径" value={formatValue(draft.workspaceRoot, "等待填写")} muted={!draft.workspaceRoot} />
              <Metric label="项目名" value={formatValue(draft.projectName, "等待填写")} muted={!draft.projectName} />
              <Metric label="Loop 名称" value={formatValue(draft.loopName, "等待填写")} muted={!draft.loopName} />
              <Metric label="分支" value={formatValue(draft.branch, "等待填写")} muted={!draft.branch} />
              <Metric
                label="Git 状态"
                value={draft.git?.hasGit ? `已检测到 ${formatValue(draft.git.branch, "仓库")}` : "未检测到 Git"}
                muted={!draft.git?.hasGit}
              />
              <Metric
                label="规则文档"
                value={draft.docs?.ruleDocs?.length ? `${draft.docs.ruleDocs.length} 份` : "暂未发现"}
                muted={!draft.docs?.ruleDocs?.length}
              />
            </div>
          </div>

          <form
            className="assistant-reply-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onSubmit();
            }}
          >
            <textarea
              value={assistantAnswer}
              placeholder={currentQuestion.placeholder || "输入你的回答"}
              onChange={(event) => setAssistantAnswer(event.target.value)}
              rows={4}
            />
            <button type="submit" className="primary-button" disabled={submitting || !assistantAnswer.trim()}>
              发送回答
            </button>
          </form>
        </>
      ) : null}

      {draft.docs?.ruleDocs?.length || draft.docs?.devDocs?.length ? (
        <details className="workspace-details" open>
          <summary>已发现的文档与线索</summary>
          <div className="remote-steps">
            {draft.docs.ruleDocs?.map((doc) => (
              <p key={doc}>规则：{doc}</p>
            ))}
            {draft.docs.devDocs?.map((doc) => (
              <p key={doc}>开发：{doc}</p>
            ))}
            {draft.docs.notes?.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [mobileView, setMobileView] = useState(null);
  const [launcherStatus, setLauncherStatus] = useState(null);
  const [remoteAccessStatus, setRemoteAccessStatus] = useState(null);
  const [automationStatus, setAutomationStatus] = useState(null);
  const [ollamaModels, setOllamaModels] = useState([]);
  const [assistantState, setAssistantState] = useState(null);
  const [assistantAnswer, setAssistantAnswer] = useState("");
  const [loopRegistry, setLoopRegistry] = useState({ currentLoopId: "", loops: [] });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uiError, setUiError] = useState("");
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeSidebarPane, setActiveSidebarPane] = useState("loops");
  const [selectedLoopId, setSelectedLoopId] = useState("");
  const [loopMenuOpenId, setLoopMenuOpenId] = useState("");
  const [threadForm, setThreadForm] = useState({
    workspaceName: "",
    threadTitle: "",
    threadId: "",
    note: "",
    singleThreadMode: true,
  });
  const [settingsForm, setSettingsForm] = useState({
    conversationLanguage: "zh-CN",
    intervalMinutes: "10",
    promptGeneratorEnabled: false,
    promptGeneratorModel: "qwen2.5:7b",
    promptGeneratorBaseUrl: "http://127.0.0.1:11434",
  });
  const [pollState, setPollState] = useState({
    syncing: false,
    lastSuccessAt: "",
    failedCount: 0,
    lastDurationMs: 0,
  });

  const pollInFlightRef = useRef(false);
  const intervalRef = useRef(null);

  async function loadSnapshot({ silent = false } = {}) {
    if (pollInFlightRef.current) {
      return;
    }

    pollInFlightRef.current = true;
    const startedAt = performance.now();

    if (!silent) {
      setLoading((current) => current && !snapshot);
    }

    try {
      const [
        nextAutomationStatus,
        nextSnapshot,
        nextLoops,
        nextMobile,
        nextLauncherStatus,
        nextRemoteAccessStatus,
        nextOllamaModels,
        nextAssistantState,
      ] = await Promise.all([
        requestJson("/automation"),
        requestJson("/snapshot"),
        requestJson("/loops"),
        requestJson("/mobile"),
        requestJson("/launcher-status"),
        requestJson("/remote-access"),
        requestJson("/ollama/models").catch(() => ({ models: [] })),
        requestJson("/loop-creation-assistant"),
      ]);

      setAutomationStatus(nextAutomationStatus);
      setSnapshot(nextSnapshot);
      setLoopRegistry(nextLoops);
      setMobileView(nextMobile);
      setLauncherStatus(nextLauncherStatus);
      setRemoteAccessStatus(nextRemoteAccessStatus);
      setOllamaModels(nextOllamaModels.models || []);
      setAssistantState(nextAssistantState);
      setSelectedLoopId((current) => current || nextLoops.currentLoopId || "");
      setThreadForm({
        workspaceName: nextSnapshot.thread.workspaceName || "",
        threadTitle: nextSnapshot.thread.threadTitle || "",
        threadId: nextSnapshot.thread.threadId || "",
        note: nextSnapshot.thread.note || "",
        singleThreadMode: Boolean(nextSnapshot.thread.singleThreadMode),
      });
      setSettingsForm({
        conversationLanguage:
          nextSnapshot.profile?.resolved?.conversation?.language || "zh-CN",
        intervalMinutes: String(nextAutomationStatus?.intervalMinutes || 10),
        promptGeneratorEnabled: Boolean(
          nextSnapshot.profile?.resolved?.conversation?.promptGenerator?.enabled,
        ),
        promptGeneratorModel:
          nextSnapshot.profile?.resolved?.conversation?.promptGenerator?.model || "qwen2.5:7b",
        promptGeneratorBaseUrl:
          nextSnapshot.profile?.resolved?.conversation?.promptGenerator?.baseUrl ||
          "http://127.0.0.1:11434",
      });
      setUiError("");
      setPollState({
        syncing: false,
        lastSuccessAt: new Date().toISOString(),
        failedCount: 0,
        lastDurationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      setUiError(
        error.name === "AbortError"
          ? "请求超时，请检查本地控制台服务是否仍在运行。"
          : error.message,
      );
      setPollState((current) => ({
        ...current,
        syncing: false,
        failedCount: current.failedCount + 1,
        lastDurationMs: Math.round(performance.now() - startedAt),
      }));
    } finally {
      pollInFlightRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    function startPolling() {
      window.clearInterval(intervalRef.current);
      const delay = document.hidden ? IDLE_POLL_MS : ACTIVE_POLL_MS;
      intervalRef.current = window.setInterval(() => {
        setPollState((current) => ({ ...current, syncing: true }));
        void loadSnapshot({ silent: true });
      }, delay);
    }

    startPolling();
    document.addEventListener("visibilitychange", startPolling);

    return () => {
      window.clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", startPolling);
    };
  }, []);

  async function withSubmit(action) {
    setSubmitting(true);
    setUiError("");
    try {
      await action();
      await loadSnapshot({ silent: true });
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

  const loopGroups = useMemo(
    () => groupLoopsByProject(loopRegistry.loops || []),
    [loopRegistry],
  );

  const currentLoop = useMemo(
    () =>
      loopRegistry.loops.find((loop) => loop.id === (selectedLoopId || loopRegistry.currentLoopId)) ||
      loopRegistry.loops.find((loop) => loop.id === loopRegistry.currentLoopId) ||
      null,
    [loopRegistry, selectedLoopId],
  );

  const modeText =
    snapshot?.state?.modeLabel || modeTextMap[snapshot?.state?.mode] || "未知";
  const continuationStatus =
    continuationTextMap[snapshot?.thread?.continuationStatus] || "尚未开始";
  const latestSummary =
    snapshot?.thread?.latestSummary ||
    snapshot?.thread?.latestCodexSummary ||
    snapshot?.state?.recentSummary ||
    "等待第一轮进展";
  const latestPrompt = snapshot?.thread?.lastDispatchPrompt || "";
  const transcriptEntries = mobileView?.transcriptEntries || [];
  const strategy = mobileView?.strategy || {
    contextCard: {},
    rhythmCard: {},
    guardrailCard: {},
  };
  const healthIssues = snapshot?.health?.issues || [];
  const bindingNote = mobileView?.bindingNote || "尚未生成";
  const suggestedAction = mobileView?.suggestedAction || "等待下一步";
  const launcherPhase =
    launcherPhaseTextMap[launcherStatus?.phase] || formatValue(launcherStatus?.phase, "未知");
  const automationSchedule = automationStatus?.connected
    ? `${automationStatus.intervalMinutes} 分钟`
    : "未连接";
  const conversationLanguage = settingsForm.conversationLanguage === "en" ? "英文" : "中文优先";
  const promptGeneratorStatus = settingsForm.promptGeneratorEnabled
    ? `已启用 · ${settingsForm.promptGeneratorModel}`
    : "默认模板";
  const remoteTransport = remoteAccessStatus?.recommendedTransport || "tailscale";
  const launcherWebUrl = launcherStatus?.webUrl || launcherStatus?.webBaseUrl || "未提供";
  const latestEvent = formatValue(snapshot?.thread?.latestEventType || snapshot?.state?.events?.at(-1)?.type, "暂无");
  const pollStatus = pollState.syncing
    ? "同步中"
    : pollState.failedCount > 0
      ? `重试 ${pollState.failedCount}`
      : pollState.lastSuccessAt
        ? `更新于 ${formatTime(pollState.lastSuccessAt)}`
        : "等待首轮同步";

  if (loading && !snapshot) {
    return <SkeletonBlock />;
  }

  return (
    <main className="workspace-shell">
      <aside className={`workspace-sidebar ${sidebarOpen ? "" : "is-collapsed"}`}>
        <div className="sidebar-topbar">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((current) => !current)}
          >
            {sidebarOpen ? "收起" : "展开"}
          </button>
          {sidebarOpen ? <strong>codex-loop</strong> : null}
        </div>

        {sidebarOpen ? (
          <>
            <SidebarSummary
              currentLoop={currentLoop}
              loopRegistry={loopRegistry}
              snapshot={snapshot}
              pollStatus={pollStatus}
            />

            <div className="sidebar-panes">
              {[
                ["loops", "Loop"],
                ["create", "创建"],
                ["thread", "线程"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`sidebar-pane-tab ${activeSidebarPane === id ? "is-active" : ""}`}
                  onClick={() => setActiveSidebarPane(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {activeSidebarPane === "loops" ? (
              <div className="sidebar-pane-stack">
                <div className="sidebar-loop-groups">
                  {Object.entries(loopGroups).map(([projectName, loops]) => {
                    const collapsed = collapsedProjects[projectName];
                    return (
                      <div key={projectName} className="sidebar-group">
                        <button
                          type="button"
                          className="sidebar-group-toggle"
                          onClick={() =>
                            setCollapsedProjects((current) => ({
                              ...current,
                              [projectName]: !current[projectName],
                            }))
                          }
                        >
                          <span>{projectName}</span>
                          <span>{collapsed ? "展开" : "折叠"}</span>
                        </button>

                        {!collapsed ? (
                          <div className="sidebar-loop-list">
                            {loops.map((loop) => {
                              const isActive = loop.id === (currentLoop?.id || loopRegistry.currentLoopId);
                              return (
                                <div key={loop.id} className={`sidebar-loop-item ${isActive ? "is-active" : ""}`}>
                                  <button
                                    type="button"
                                    className="sidebar-loop-main"
                                    onClick={() =>
                                      withSubmit(async () => {
                                        setSelectedLoopId(loop.id);
                                        await requestJson("/loops/select", {
                                          method: "POST",
                                          body: JSON.stringify({ loopId: loop.id }),
                                        });
                                      })
                                    }
                                  >
                                    <strong>{loop.name}</strong>
                                    <span>{formatValue(loop.boundThreadTitle, "未绑定线程")}</span>
                                    <span className="sidebar-loop-path">{formatValue(loop.branch, "dev")}</span>
                                  </button>

                                  <div className="sidebar-loop-tools">
                                    <button
                                      type="button"
                                      className="loop-tool-button"
                                      onClick={() =>
                                        setLoopMenuOpenId((current) => (current === loop.id ? "" : loop.id))
                                      }
                                    >
                                      管理
                                    </button>
                                    {loopMenuOpenId === loop.id ? (
                                      <div className="loop-context-menu">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setActiveSidebarPane("thread");
                                            setLoopMenuOpenId("");
                                          }}
                                        >
                                          编辑线程绑定
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            withSubmit(async () => {
                                              const nextName = window.prompt("输入新的 loop 名称", loop.name);
                                              if (!nextName || nextName === loop.name) return;
                                              await requestJson("/rename-loop", {
                                                method: "POST",
                                                body: JSON.stringify({ loopName: nextName }),
                                              });
                                              setLoopMenuOpenId("");
                                            })
                                          }
                                        >
                                          重命名当前 loop
                                        </button>
                                        {!loop.isCurrent ? (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              withSubmit(async () => {
                                                await requestJson("/loops/delete", {
                                                  method: "POST",
                                                  body: JSON.stringify({ loopId: loop.id }),
                                                });
                                                setLoopMenuOpenId("");
                                              })
                                            }
                                          >
                                            删除这个 loop
                                          </button>
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {activeSidebarPane === "create" ? (
              <LoopCreationAssistantPane
                assistantState={assistantState}
                assistantAnswer={assistantAnswer}
                setAssistantAnswer={setAssistantAnswer}
                submitting={submitting}
                onSubmit={() =>
                  withSubmit(async () => {
                    await requestJson("/loop-creation-assistant/reply", {
                      method: "POST",
                      body: JSON.stringify({ answer: assistantAnswer }),
                    });
                    setAssistantAnswer("");
                  })
                }
              />
            ) : null}

            {activeSidebarPane === "thread" ? (
              <div className="sidebar-pane-stack">
                <form
                  className="sidebar-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void withSubmit(async () => {
                      await requestJson("/thread", {
                        method: "POST",
                        body: JSON.stringify(threadForm),
                      });
                    });
                  }}
                >
                  <h3>线程绑定</h3>
                  <p className="sidebar-help">
                    这里保留详细低代码信息，方便你定位 Codex 桌面端真实线程，并让 loop 的续发记录显示在那个可见窗口里。
                  </p>
                  <label>
                    <span>项目显示名</span>
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
                    <span>线程标题</span>
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
                    <span>线程 ID</span>
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
                    <span>说明备注</span>
                    <textarea
                      rows={4}
                      value={threadForm.note}
                      onChange={(event) =>
                        setThreadForm((current) => ({
                          ...current,
                          note: event.target.value,
                        }))
                      }
                    />
                  </label>
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
                    <span>单线程续发模式</span>
                  </label>
                  <button type="submit" className="primary-button" disabled={submitting}>
                    保存线程绑定
                  </button>
                </form>
              </div>
            ) : null}
          </>
        ) : (
          <div className="sidebar-collapsed-list">
            {(loopRegistry.loops || []).map((loop) => (
              <button
                key={loop.id}
                type="button"
                className={`collapsed-loop-pill ${loop.id === currentLoop?.id ? "is-active" : ""}`}
                onClick={() =>
                  withSubmit(async () => {
                    setSelectedLoopId(loop.id);
                    await requestJson("/loops/select", {
                      method: "POST",
                      body: JSON.stringify({ loopId: loop.id }),
                    });
                  })
                }
              >
                {loop.name.slice(0, 2)}
              </button>
            ))}
          </div>
        )}
      </aside>

      <section className="workspace-main">
        <section className="workspace-hero">
          <div className="workspace-hero-copy">
            <span className="workspace-hero-project">
              {formatValue(currentLoop?.projectName || snapshot?.config?.projectName, "当前项目")}
            </span>
            <h1>{formatValue(currentLoop?.name || snapshot?.config?.loopName, "当前 loop")}</h1>
            <p>
              首页只聚焦当前 loop 的真实进度、对话记录和策略卡片。左边负责管理所有 loop，右边负责把当前 loop 跑稳、看清、可控。
            </p>
            <div className="workspace-status-row">
              <StatusPill text={modeText} active={snapshot?.state?.mode === "running"} />
              <StatusPill
                text={continuationStatus}
                tone={snapshot?.thread?.continuationStatus === "error" ? "danger" : "soft"}
                active={snapshot?.thread?.continuationStatus === "dispatching"}
              />
              <StatusPill text={launcherPhase} tone="soft" />
              <StatusPill text={pollStatus} tone="soft" active={pollState.syncing} />
            </div>
            <div className="workspace-thinking-card">
              <div className="thinking-pulse" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div>
                <strong>
                  {snapshot?.thread?.continuationStatus === "dispatching"
                    ? "Codex 正在思考并准备下一条消息"
                    : snapshot?.state?.mode === "running"
                      ? "loop 正在后台持续推进"
                      : "当前没有活跃续发"}
                </strong>
                <p>
                  {snapshot?.thread?.continuationStatus === "dispatching"
                    ? "前端会持续刷新状态，避免长任务时误以为卡死。"
                    : "即使当前没有可见输出，前端也会维持轻量轮询和健康检查，确保长时间运行更稳定。"}
                </p>
              </div>
            </div>
          </div>

          <div className="workspace-hero-metrics">
            <Metric label="最后成功同步" value={formatTime(pollState.lastSuccessAt)} muted={!pollState.lastSuccessAt} />
            <Metric label="最近心跳" value={formatTime(snapshot?.thread?.latestHeartbeatAt || snapshot?.state?.lastHeartbeatAt)} muted={!(snapshot?.thread?.latestHeartbeatAt || snapshot?.state?.lastHeartbeatAt)} />
            <Metric label="轮询耗时" value={`${pollState.lastDurationMs || 0} ms`} />
            <Metric label="自动化间隔" value={automationSchedule} muted={!automationStatus?.connected} />
          </div>
        </section>

        {uiError ? <div className="error-banner">{uiError}</div> : null}

        <div className="workspace-columns">
          <div className="workspace-primary">
            <Section
              title="当前状态"
              desc="启动、停止、手动续跑和当前摘要都集中在这里。"
              actions={
                <>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={submitting}
                    onClick={() =>
                      withSubmit(async () => {
                        await requestJson("/start", { method: "POST" });
                      })
                    }
                  >
                    开始循环
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={submitting}
                    onClick={() =>
                      withSubmit(async () => {
                        await requestJson("/run-turn", { method: "POST" });
                      })
                    }
                  >
                    手动续跑一轮
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={submitting}
                    onClick={() =>
                      withSubmit(async () => {
                        await requestJson("/stop", {
                          method: "POST",
                          body: JSON.stringify({ reason: "manual stop from console" }),
                        });
                      })
                    }
                  >
                    停止并收尾
                  </button>
                </>
              }
            >
              <div className="metric-grid">
                <Metric label="当前模式" value={modeText} />
                <Metric label="续发状态" value={continuationStatus} />
                <Metric label="线程标题" value={formatValue(snapshot?.thread?.threadTitle, "未绑定线程")} muted={!snapshot?.thread?.threadTitle} />
                <Metric label="线程 ID" value={formatValue(snapshot?.thread?.threadId, "未绑定")} muted={!snapshot?.thread?.threadId} />
              </div>
              <div className="detail-stack">
                <DetailCard
                  meta="最新摘要"
                  title={formatValue(snapshot?.thread?.latestCodexSummary || latestSummary, "等待首轮输出")}
                  body={formatValue(snapshot?.thread?.lastAssistantActionSummary || latestSummary, "等待下一轮反馈")}
                />
                <DetailCard
                  meta="当前建议"
                  title={formatValue(suggestedAction, "等待更新")}
                  body={formatValue(bindingNote, "暂无")}
                  quiet
                />
              </div>
            </Section>

            <Section
              title="对话记录"
              desc="这里集中看当前 loop 最近发给 Codex 的消息、最新反馈，以及手机端看到的聊天镜像。"
            >
              <div className="detail-stack">
                <DetailCard
                  meta="最近发送给 Codex"
                  title={continuationStatus}
                  body={formatValue(latestPrompt, "暂时还没有续发内容。")}
                />
                <DetailCard
                  meta="最新 Codex 摘要"
                  title={formatValue(snapshot?.thread?.latestCodexSummary, "暂无")}
                  body={formatValue(
                    snapshot?.thread?.lastAssistantActionSummary || latestSummary,
                    "等待下一次可见反馈。",
                  )}
                  quiet
                />
              </div>

              <div className="transcript-stream">
                {transcriptEntries.length === 0 ? (
                  <DetailCard
                    title="暂无聊天镜像"
                    body="绑定线程并跑起来之后，这里会持续显示最近的 loop 聊天卡片。"
                  />
                ) : (
                  transcriptEntries.map((entry, index) => (
                    <DetailCard
                      key={`${entry.at}-${entry.activeTask}-${index}`}
                      meta={formatTime(entry.at, "未知时间")}
                      title={formatValue(entry.activeTask, "未记录任务")}
                      body={`${formatValue(entry.summary, "暂无摘要")}\n\n${formatValue(entry.note, "暂无备注")}`}
                    />
                  ))
                )}
              </div>
            </Section>

            <Section
              title="当前设置"
              desc="默认中文优先。自动化间隔、Ollama 模型与提示词生成都在这里。"
            >
              <form
                className="settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void withSubmit(async () => {
                    await requestJson("/overrides", {
                      method: "POST",
                      body: JSON.stringify({
                        conversation: {
                          language: settingsForm.conversationLanguage,
                          promptGenerator: {
                            enabled: settingsForm.promptGeneratorEnabled,
                            provider: "ollama",
                            model: settingsForm.promptGeneratorModel,
                            baseUrl: settingsForm.promptGeneratorBaseUrl,
                          },
                        },
                      }),
                    });
                    if (automationStatus?.connected) {
                      await requestJson("/automation", {
                        method: "POST",
                        body: JSON.stringify({
                          intervalMinutes: Number(settingsForm.intervalMinutes),
                        }),
                      });
                    }
                  });
                }}
              >
                <div className="settings-grid">
                  <label>
                    <span>默认续发语言</span>
                    <select
                      value={settingsForm.conversationLanguage}
                      onChange={(event) =>
                        setSettingsForm((current) => ({
                          ...current,
                          conversationLanguage: event.target.value,
                        }))
                      }
                    >
                      <option value="zh-CN">中文优先</option>
                      <option value="en">英文</option>
                    </select>
                  </label>
                  <label>
                    <span>自动化间隔（分钟）</span>
                    <input
                      type="number"
                      min="1"
                      value={settingsForm.intervalMinutes}
                      onChange={(event) =>
                        setSettingsForm((current) => ({
                          ...current,
                          intervalMinutes: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <details className="workspace-details" open={settingsForm.promptGeneratorEnabled}>
                  <summary>高级设置：动态续发生成</summary>
                  <div className="settings-grid">
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={settingsForm.promptGeneratorEnabled}
                        onChange={(event) =>
                          setSettingsForm((current) => ({
                            ...current,
                            promptGeneratorEnabled: event.target.checked,
                          }))
                        }
                      />
                      <span>启用本地 Ollama 生成下一条消息</span>
                    </label>
                    <label>
                      <span>模型名称</span>
                      <input
                        value={settingsForm.promptGeneratorModel}
                        onChange={(event) =>
                          setSettingsForm((current) => ({
                            ...current,
                            promptGeneratorModel: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>本地模型列表</span>
                      <select
                        value={
                          ollamaModels.some((model) => model.name === settingsForm.promptGeneratorModel)
                            ? settingsForm.promptGeneratorModel
                            : ""
                        }
                        onChange={(event) => {
                          if (!event.target.value) return;
                          setSettingsForm((current) => ({
                            ...current,
                            promptGeneratorModel: event.target.value,
                          }));
                        }}
                      >
                        <option value="">从本地 Ollama 模型中选择</option>
                        {ollamaModels.map((model) => (
                          <option key={model.name} value={model.name}>
                            {model.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Ollama Base URL</span>
                      <input
                        value={settingsForm.promptGeneratorBaseUrl}
                        onChange={(event) =>
                          setSettingsForm((current) => ({
                            ...current,
                            promptGeneratorBaseUrl: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                </details>

                <div className="metric-grid">
                  <Metric label="语言策略" value={conversationLanguage} />
                  <Metric label="自动化节奏" value={automationSchedule} muted={!automationStatus?.connected} />
                  <Metric label="动态续发生成" value={promptGeneratorStatus} />
                  <Metric label="启动状态" value={launcherPhase} />
                </div>

                <button type="submit" className="primary-button" disabled={submitting}>
                  保存当前设置
                </button>
              </form>
            </Section>
          </div>

          <aside className="workspace-secondary">
            <Section
              title="策略卡片"
              desc="这是 loop 强于原生自动化的关键：每次续发前都明确理由、节奏和收尾条件。"
            >
              <div className="metric-grid">
                <Metric label="为什么继续" value={formatValue(strategy.contextCard?.whyContinue, "暂无")} />
                <Metric label="预计下一步" value={formatValue(strategy.contextCard?.nextAction, "暂无")} />
                <Metric label="节奏策略" value={formatValue(strategy.rhythmCard?.promptGeneratorMode, "template")} />
                <Metric label="暂停 / 收尾条件" value={formatValue(strategy.guardrailCard?.stopRule, "暂无")} />
              </div>
            </Section>

            <Section
              title="手机查看"
              desc="手机上重点看摘要、策略、最近消息和聊天记录。"
            >
              <div className="detail-stack">
                <DetailCard title="线程绑定提示" body={bindingNote} />
                <DetailCard title="当前建议动作" body={suggestedAction} />
                <DetailCard
                  title="手机端最近摘要"
                  body={formatValue(mobileView?.summary?.recentSummary || latestSummary, "暂无摘要")}
                />
              </div>
            </Section>

            <Section
              title="远程访问"
              desc="不部署云服务器时，最简单的跨网络访问方案是 Tailscale。"
            >
              <div className="metric-grid">
                <Metric label="推荐方案" value={remoteTransport} />
                <Metric
                  label="当前就绪"
                  value={remoteAccessStatus?.remoteReady ? "已具备基础条件" : "尚未安装远程入口"}
                />
                <Metric label="前端地址" value={launcherWebUrl} />
                <Metric
                  label="最后异常"
                  value={formatValue(snapshot?.thread?.lastContinuationError, "无")}
                  muted={!snapshot?.thread?.lastContinuationError}
                />
              </div>
              <details className="workspace-details">
                <summary>展开最简接入步骤</summary>
                <div className="remote-steps">
                  {(remoteAccessStatus?.recommendedSteps || []).map((step) => (
                    <p key={step}>{step}</p>
                  ))}
                </div>
              </details>
            </Section>

            <Section
              title="健康检查"
              desc="这里只显示真正有帮助的信息，其它噪音都收起来。"
            >
              <div className="metric-grid">
                <Metric label="整体结果" value={snapshot?.health?.ok ? "正常" : "异常"} />
                <Metric
                  label="异常项"
                  value={healthIssues.length ? healthIssues.join(" / ") : "无"}
                  muted={!healthIssues.length}
                />
                <Metric label="最近事件" value={latestEvent} />
                <Metric label="接口地址" value={formatValue(launcherStatus?.apiBaseUrl, "暂无")} />
              </div>
            </Section>
          </aside>
        </div>
      </section>
    </main>
  );
}
