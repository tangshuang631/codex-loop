import React, { useEffect, useMemo, useRef, useState } from "react";

import { deriveDashboardGuide } from "./dashboard-guide.mjs";

function resolveApiBase() {
  if (import.meta.env.VITE_CODEX_LOOP_API_BASE) {
    return import.meta.env.VITE_CODEX_LOOP_API_BASE;
  }

  if (typeof window !== "undefined") {
    const { protocol, hostname, port } = window.location;
    const numericPort = Number(port);
    if (Number.isFinite(numericPort) && numericPort > 0) {
      const pairedApiPort = numericPort - 1;
      if (pairedApiPort > 0) {
        return `${protocol}//${hostname}:${pairedApiPort}/api`;
      }
    }
  }

  return "http://127.0.0.1:3000/api";
}

const API_BASE = resolveApiBase();
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
  dispatching: "已发送，等待 Codex",
  error: "续跑失败",
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
function filterVisibleLoops(loops = []) {
  return loops.filter((loop) => {
    if (loop.isCurrent) {
      return true;
    }
    const staleDefaultLoop =
      loop.id === "default-run" &&
      !loop.boundThreadId &&
      loop.projectName === "project";
    return !staleDefaultLoop;
  });
}

function pickVisibleLoop(loops = [], preferredId = "") {
  const visibleLoops = filterVisibleLoops(loops);
  return (
    visibleLoops.find((loop) => loop.id === preferredId) ||
    visibleLoops.find((loop) => loop.isCurrent) ||
    visibleLoops[0] ||
    null
  );
}

async function requestJsonLegacyUnused(targetPath, options = {}) {
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
    const rawText = await response.text();
    let data = {};
    if (rawText.trim()) {
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error("服务返回内容不完整，请稍后重试。");
      }
    }
    if (!response.ok) {
      throw new Error(data.error || "请求失败");
    }
    return data;
  } finally {
    window.clearTimeout(timeoutId);
  }
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
    const rawText = await response.text();
    const hasBody = rawText.trim().length > 0;
    let data = {};
    if (hasBody) {
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error("服务返回内容不完整，请稍后重试。");
      }
    }
    if (!response.ok) {
      throw new Error(data.error || "请求失败，请稍后重试。");
    }
    if (!hasBody && response.status !== 204) {
      throw new Error("服务暂时没有返回结果，请稍后重试。");
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

function summarizeVisibleText(value, fallback = "暂无", maxLength = 120) {
  const text = formatValue(value, "").replace(/\[(.*?)\]\((.*?)\)/g, "$1").trim();
  if (!text) {
    return fallback;
  }
  if (text === "Loop initialized; waiting for the first heartbeat or Codex progress sync.") {
    return "刚开始运行，等待第一轮进展。";
  }
  const firstParagraph = text
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .find(Boolean) || text;
  const firstLine = firstParagraph.split("\n").map((item) => item.trim()).find(Boolean) || firstParagraph;
  const compact = firstLine.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? compact.slice(0, maxLength) + "..." : compact;
}

function translateHealthIssue(issue) {
  const value = formatValue(issue, "");
  if (value === "transcript:stale") {
    return "最近记录还没有同步到面板，请等待这一轮完成后再查看。";
  }
  if (value === "continuation:stalled") {
    return "这一轮等待时间过长，建议确认目标线程是否仍在输出。";
  }
  if (value === "heartbeat:stale") {
    return "运行心跳超过预期时间未更新。";
  }
  if (value === "continuation:error") {
    return "续跑失败，请查看最近记录里的错误信息。";
  }
  return value || "暂无";
}

function isUsefulTranscriptEntry(entry) {
  const summary = formatValue(entry?.summary, "");
  if (!summary) {
    return false;
  }
  if (summary.includes("???") || summary.includes("锟")) {
    return false;
  }
  if (summary.includes("循环已启动") || summary.includes("正在等待第一轮")) {
    return false;
  }
  if (summary.includes("正在向绑定的 Codex 线程发送")) {
    return false;
  }
  return true;
}

function deriveActionHint(snapshot, suggestedAction) {
  if (!snapshot?.thread?.threadId) {
    return "先去管理页绑定线程。";
  }
  if (snapshot?.thread?.continuationStatus === "dispatching") {
    return "先等待这一轮完成，再决定是否继续。";
  }
  if (snapshot?.state?.stopRequested || snapshot?.state?.finalizeRequested) {
    return "当前正在收尾，先等待结束。";
  }
  if (snapshot?.state?.mode === "running") {
    return "先看最近记录，再决定是否停止或调整设置。";
  }
  const fallback = summarizeVisibleText(suggestedAction, "");
  return fallback || "先开始循环。";
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

function StatusSummaryPanel({
  modeText,
  continuationStatus,
  currentLoopName,
  threadLabel,
  modelStatus,
  pollStatus,
  healthSummary,
}) {
  const rows = [
    ["运行", `${modeText} · ${continuationStatus}`],
    ["任务", currentLoopName],
    ["线程", threadLabel],
    ["模型", modelStatus],
    ["同步", pollStatus],
    ["提醒", healthSummary],
  ];

  return (
    <div className="status-summary-panel">
      {rows.map(([label, value]) => (
        <div className="status-summary-row" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

const StatusSummaryPanelV2 = StatusSummaryPanel;

function ConversationTimeline({
  entries,
  latestCodexUser,
  latestCodexAssistant,
  latestPrompt,
  latestPromptAt,
  fallbackEntries,
}) {
  const conversationEntries = (entries.length
    ? entries
    : [
        latestCodexAssistant
          ? { ...latestCodexAssistant, label: "Codex 回复", role: "assistant" }
          : null,
        latestCodexUser
          ? { ...latestCodexUser, label: "codex-loop 指令", role: "user" }
          : null,
      ].filter(Boolean)).filter(Boolean);

  const latestPromptText = formatValue(latestPrompt, "");
  const latestPromptAlreadyVisible =
    !latestPromptText ||
    conversationEntries.some((entry) => formatValue(entry.text, "").trim() === latestPromptText.trim());

  if (!latestPromptAlreadyVisible) {
    conversationEntries.push({
      at: latestPromptAt,
      role: "user",
      text: latestPromptText,
      preview: latestPromptText,
      label: "codex-loop 指令",
    });
  }

  conversationEntries.sort((a, b) => {
    const left = Date.parse(a.at || "");
    const right = Date.parse(b.at || "");
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return left - right;
  });

  const fallbackConversation = !conversationEntries.length && fallbackEntries.length
    ? fallbackEntries.map((entry) => ({
        at: entry.at,
        role: "assistant",
        text: entry.summary,
        preview: entry.summary,
        label: "本地记录",
      }))
    : [];
  const visibleEntries = conversationEntries.length ? conversationEntries : fallbackConversation;

  if (!visibleEntries.length) {
    return (
      <div className="conversation-empty">
        绑定线程并开始循环后，这里会像 Codex 对话一样展示 codex-loop 发出的指令和 Codex 的回复。
      </div>
    );
  }

  return (
    <div className="conversation-timeline">
      {visibleEntries.map((entry, index) => {
        const isLoopMessage = entry.role === "user";
        const fullText = formatValue(entry.text, isLoopMessage ? latestPrompt : "");
        const previewText = formatValue(entry.preview, fullText);
        const summary = summarizeVisibleText(previewText || fullText, "暂无内容", isLoopMessage ? 180 : 320);
        return (
          <article
            className={`conversation-row ${isLoopMessage ? "is-loop" : "is-codex"}`}
            key={`${entry.at || index}-${entry.role}-${index}`}
          >
            <details className="conversation-bubble" open={!isLoopMessage}>
              <summary>
                <span className="conversation-meta">
                  {formatTime(entry.at, "未知时间")} · {isLoopMessage ? "codex-loop 指令" : "Codex 回复"}
                </span>
                <strong>{summary}</strong>
                <em>{fullText ? (isLoopMessage ? "点击展开完整指令" : "点击收起完整回复") : "等待完整内容同步"}</em>
              </summary>
              {fullText ? <pre>{fullText}</pre> : null}
            </details>
          </article>
        );
      })}
    </div>
  );
}
function QuickActionButton({ action, onAction, variant = "secondary", disabled = false }) {
  if (!action?.id || !action?.label) {
    return null;
  }

  return (
    <button
      type="button"
      className={`${variant}-button`}
      disabled={disabled}
      onClick={() => onAction(action.id)}
    >
      {action.label}
    </button>
  );
}

function deriveVisibleWaitingText(snapshot, fallbackText) {
  const summary = formatValue(fallbackText, "");
  if (!summary) {
    return "等待这一轮完成。";
  }
  if (snapshot?.thread?.continuationStatus === "dispatching") {
    return summary.includes("Codex")
      ? "这一轮已发出，正在等待 Codex 完成。"
      : "这一轮处理中，正在等待结果同步。";
  }
  return summary;
}

function SidebarSummary({ currentLoop, loopRegistry, snapshot, pollStatus }) {
  const visibleLoops = filterVisibleLoops(loopRegistry.loops || []);
  return (
    <div className="sidebar-summary-card">
      <span className="sidebar-summary-label">当前焦点</span>
      <strong>{formatValue(currentLoop?.name || snapshot?.config?.loopName, "未命名任务")}</strong>
      <p>{formatValue(currentLoop?.projectName || snapshot?.config?.projectName, "未命名项目")}</p>
      <div className="sidebar-summary-meta">
        <span>{visibleLoops.length} 个任务</span>
        <span>{snapshot?.thread?.threadId ? "已连接窗口" : "待连接窗口"}</span>
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
  onBack,
  onReset,
}) {
  const currentQuestion = assistantState?.currentQuestion;
  const draft = assistantState?.draft || {};
  const plan = draft.plan || {};
  const createdLoop = assistantState?.createdLoop?.loop;
  const messages = assistantState?.messages || [];

  return (
    <div className="sidebar-form assistant-pane">
      <h3>创建 loop</h3>
      <p className="sidebar-help">
        先确认项目、任务名和分支，再开始循环。
      </p>

      {assistantState?.status === "completed" && createdLoop ? (
        <div className="assistant-result">
          <DetailCard
            meta="创建完成"
            title={createdLoop.name}
            body={[
              "已归入项目：" + createdLoop.projectName,
              "分支：" + formatValue(createdLoop.branch),
              "工作区：" + formatValue(createdLoop.workspaceRoot),
            ].join("\n")}
          />
        </div>
      ) : null}

      {currentQuestion ? (
        <>
          <div className="assistant-thread">
            <DetailCard meta="当前步骤" title="继续填写" body={currentQuestion.prompt} quiet />

            {messages.length ? (
              <details className="assistant-disclosure" open>
                <summary>创建对话</summary>
                <div className="assistant-message-list">
                  {messages.slice(-6).map((message, index) => (
                    <article
                      key={`${message.at || "msg"}-${index}`}
                      className={`assistant-message assistant-message-${message.role || "assistant"}`}
                    >
                      <span className="assistant-message-role">
                        {message.role === "user" ? "你" : "助手"}
                      </span>
                      <p>{message.text}</p>
                    </article>
                  ))}
                </div>
              </details>
            ) : null}

            <details className="assistant-disclosure" open>
              <summary>当前进度</summary>
              <div className="assistant-draft-grid">
                <Metric label="项目路径" value={formatValue(draft.workspaceRoot, "待填写")} muted={!draft.workspaceRoot} />
                <Metric label="项目名" value={formatValue(draft.projectName, "待填写")} muted={!draft.projectName} />
                <Metric label="任务名" value={formatValue(draft.loopName, "待填写")} muted={!draft.loopName} />
                <Metric label="分支" value={formatValue(draft.branch, "待填写")} muted={!draft.branch} />
              </div>
            </details>
            {plan.objectiveSummary ? (
              <details className="assistant-disclosure" open>
                <summary>任务规划</summary>
                <div className="detail-stack">
                  <DetailCard
                    meta={plan.source === "ollama" ? "本地模型规划" : "模板规划"}
                    title={plan.objectiveSummary}
                    body={[
                      "建议项目名：" + formatValue(plan.suggestedProjectName, "暂无"),
                      "建议任务名：" + formatValue(plan.suggestedLoopName, "暂无"),
                      "建议分支：" + formatValue(plan.suggestedBranch, "暂无"),
                    ].join("\n")}
                  />
                  {plan.checklist?.length ? (
                    <DetailCard
                      meta="规划清单"
                      title="建议步骤"
                      body={plan.checklist.map((item, index) => `${index + 1}. ${item}`).join("\n")}
                      quiet
                    />
                  ) : null}
                  {plan.riskNotes?.length ? (
                    <DetailCard
                      meta="风险提醒"
                      title="需要注意的点"
                      body={plan.riskNotes.join("\n")}
                      quiet
                    />
                  ) : null}
                </div>
              </details>
            ) : null}
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
              placeholder={
                currentQuestion.id === "project_name" && draft.workspaceRoot
                  ? "也可以直接描述你的自动续跑规划意图"
                  : currentQuestion.placeholder || "输入你的回答"
              }
              onChange={(event) => setAssistantAnswer(event.target.value)}
              rows={4}
            />
            <div className="workspace-guide-actions">
              <button type="submit" className="primary-button" disabled={submitting || !assistantAnswer.trim()}>
                下一步
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={submitting}
                onClick={() => void onBack()}
              >
                上一步
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={submitting}
                onClick={() => void onReset()}
              >
                重新开始
              </button>
            </div>
          </form>
        </>
      ) : null}

      {draft.docs?.ruleDocs?.length || draft.docs?.devDocs?.length ? (
        <details className="assistant-disclosure">
          <summary>已识别信息</summary>
          <div className="remote-steps">
            <p>Git：{draft.git?.hasGit ? formatValue(draft.git.branch, "已识别仓库") : "暂未识别"}</p>
            {draft.docs.ruleDocs?.map((doc) => (
              <p key={doc}>规则：{doc}</p>
            ))}
            {draft.docs.devDocs?.map((doc) => (
              <p key={doc}>说明：{doc}</p>
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

function ManagePane({
  threadForm,
  setThreadForm,
  settingsForm,
  setSettingsForm,
  automationStatus,
  launcherPhase,
  launcherWebUrl,
  remoteAccessStatus,
  remoteTransport,
  ollamaModels,
  promptGeneratorStatus,
  conversationLanguage,
  healthIssues,
  latestEvent,
  snapshot,
  submitting,
  withSubmit,
  activeManageSection,
  setActiveManageSection,
}) {
  const isDispatching = snapshot?.thread?.continuationStatus === "dispatching";
  const isFinalizing = snapshot?.state?.stopRequested || snapshot?.state?.finalizeRequested;
  const isRunning = snapshot?.state?.mode === "running";
  const runningHeadline = isFinalizing
    ? "正在收尾"
    : isDispatching
      ? "已发送，等待 Codex 完成"
      : isRunning
        ? "循环运行中"
        : "当前 loop 已停止";
  const runningDescription = isFinalizing
    ? "不会再发送新指令，等待当前轮结束后停止。"
    : isDispatching
      ? "Codex 正在处理当前轮，完成前不会继续追发。"
      : isRunning
        ? "系统会等待 Codex 完整结束一轮，再决定是否继续发送。"
        : "需要继续时点击开始循环；如需本地模型参与，请先开启全局 Ollama。";
  const thinkingStateClass = isFinalizing
    ? "is-finalizing"
    : isDispatching || isRunning
      ? "is-active"
      : "is-idle";

  return (
    <div className="sidebar-pane-stack">
      <details
        className="sidebar-disclosure"
        open={activeManageSection === "thread"}
        onToggle={(event) => {
          if (event.currentTarget.open) setActiveManageSection("thread");
        }}
      >
        <summary>绑定线程</summary>
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
          <p className="sidebar-help">
            第一次接入，或要把 loop 切换到另一个可见线程时，再来这里修改。
          </p>
          <label>
            <span>显示名称</span>
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
            <span>线程名称</span>
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
            <span>备注</span>
            <textarea
              rows={3}
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
            <span>只在当前线程里持续续跑</span>
          </label>
          <button type="submit" className="primary-button" disabled={submitting}>
            保存线程绑定
          </button>
        </form>
      </details>

      <details
        className="sidebar-disclosure"
        open={activeManageSection === "automation" || activeManageSection === "ollama"}
        onToggle={(event) => {
          if (event.currentTarget.open && activeManageSection !== "ollama") {
            setActiveManageSection("automation");
          }
        }}
      >
        <summary>全局设置</summary>
        <form
          className="sidebar-form"
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
              <span>默认对话语言</span>
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
              <span>自动续跑间隔（分钟）</span>
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

          <details
            className="workspace-details"
            open={activeManageSection === "ollama"}
            onToggle={(event) => {
              if (event.currentTarget.open) setActiveManageSection("ollama");
            }}
          >
            <summary>Ollama 设置</summary>
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
                <span>开启 Ollama 后，默认用于所有 loop</span>
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
                  <option value="">从本地模型中选择</option>
                  {ollamaModels.map((model) => (
                    <option key={model.name} value={model.name}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>模型地址</span>
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
            {!ollamaModels.length ? (
              <p className="sidebar-help">
                还没有检测到可用的本地模型。不开启也能运行；开启后会默认用于整理 Codex 回复和生成下一步提示。
              </p>
            ) : null}
          </details>

          <div className="metric-grid compact-metric-grid">
            <Metric label="语言" value={conversationLanguage} />
            <Metric
              label="自动节奏"
              value={automationStatus?.connected ? `${automationStatus.intervalMinutes} 分钟` : "未连接"}
            />
            <Metric label="提示增强" value={promptGeneratorStatus} />
            <Metric label="启动状态" value={launcherPhase} />
          </div>

          <button type="submit" className="primary-button" disabled={submitting}>
            保存全局设置
          </button>
        </form>
      </details>

      <details
        className="sidebar-disclosure"
        open={activeManageSection === "safety"}
        onToggle={(event) => {
          if (event.currentTarget.open) setActiveManageSection("safety");
        }}
      >
        <summary>运行与安全</summary>
        <div className="sidebar-form">
          <div className="metric-grid compact-metric-grid">
            <Metric label="最近事件" value={latestEvent} />
            <Metric label="远程访问" value={remoteTransport} />
            <Metric label="控制台地址" value={launcherWebUrl} />
            <Metric
              label="健康状态"
              value={healthIssues.length ? `${healthIssues.length} 个提示` : "当前正常"}
            />
          </div>
          {healthIssues.length ? (
            <div className="detail-stack">
              {healthIssues.map((issue, index) => (
                <DetailCard
                  key={`${issue}-${index}`}
                  meta="健康提示"
                  title="需要留意"
                  body={issue}
                  quiet
                />
              ))}
            </div>
          ) : (
            <p className="sidebar-help">当前没有明显异常，可以继续推进。</p>
          )}
          {remoteAccessStatus?.url ? (
            <DetailCard
              meta="远程入口"
              title={remoteAccessStatus.url}
              body="如果你需要在别的设备上查看状态，可以使用这个地址。"
              quiet
            />
          ) : null}
        </div>
      </details>
    </div>
  );
}
function CreateWorkspaceView({
  assistantState,
  assistantAnswer,
  setAssistantAnswer,
  submitting,
  onSubmit,
  onBack,
  onReset,
}) {
  return (
    <section className="workspace-focus">
      <div className="workspace-focus-head">
        <span className="workspace-focus-eyebrow">创建新任务</span>
        <h1>对话创建 loop</h1>
        <p>这里会完整显示创建流程，你不需要挤在侧边栏里操作。</p>
      </div>

      <LoopCreationAssistantPane
        assistantState={assistantState}
        assistantAnswer={assistantAnswer}
        setAssistantAnswer={setAssistantAnswer}
        submitting={submitting}
        onSubmit={onSubmit}
        onBack={onBack}
        onReset={onReset}
      />
    </section>
  );
}

function ManageWorkspaceView(props) {
  return (
    <section className="workspace-focus">
      <div className="workspace-focus-head">
        <span className="workspace-focus-eyebrow">全局设置</span>
        <h1>调整 codex-loop 设置</h1>
        <p>线程绑定、自动续跑、本地模型和关闭控制台都集中放在这里。</p>
      </div>

      <ManagePane {...props} />
    </section>
  );
}

function DashboardHome({
  currentLoop,
  snapshot,
  modeText,
  continuationStatus,
  launcherPhase,
  pollStatus,
  pollState,
  submitting,
  handleDashboardAction,
  setActiveSidebarPane,
  setActiveManageSection,
  onRequestShutdown,
  threadLabel,
  latestSummary,
  transcriptEntries,
  latestPrompt,
  settingsForm,
  healthIssues,
  uiError,
}) {
  const projectTitle = formatValue(
    currentLoop?.projectName || snapshot?.config?.projectName,
    "当前项目",
  );
  const loopTitle = formatValue(
    currentLoop?.name || snapshot?.config?.loopName,
    "当前 loop",
  );
  const codexConversation = snapshot?.codexConversation || {};
  const latestCodexUser = codexConversation.latestUser || null;
  const latestCodexAssistant = codexConversation.latestAssistant || null;
  const codexConversationEntries = [...(codexConversation.entries || []).slice(0, 10)].reverse();
  const visibleTranscriptEntries = transcriptEntries.filter(isUsefulTranscriptEntry).slice(0, 4);
  const isDispatching = snapshot?.thread?.continuationStatus === "dispatching";
  const isFinalizing = snapshot?.state?.stopRequested || snapshot?.state?.finalizeRequested;
  const isRunning = snapshot?.state?.mode === "running";
  const healthSummary = healthIssues.length ? healthIssues.join("\n") : "当前没有明显异常。";
  const modelStatus = settingsForm.promptGeneratorEnabled
    ? "已开启 · " + settingsForm.promptGeneratorModel
    : "未开启";
  const runningHeadline = isFinalizing
    ? "正在收尾"
    : isDispatching
      ? "已发送，等待 Codex 完成"
      : isRunning
        ? "循环运行中"
        : "已停止";
  const runningDescription = isFinalizing
    ? "不会再发送新指令，等待当前轮结束后停止。"
    : isDispatching
      ? "Codex 正在处理当前轮，完成前不会继续追发。"
      : isRunning
        ? "系统会等待 Codex 完整完成一轮，再决定是否继续。"
        : "需要继续时点击开始循环；如需本地模型参与，请先打开设置。";
  const thinkingStateClass = isFinalizing
    ? "is-finalizing"
    : isDispatching || isRunning
      ? "is-active"
      : "is-idle";
  const latestVisibleSummary = summarizeVisibleText(
    snapshot?.thread?.latestCodexSummary || latestSummary,
    "等待第一轮可见进展",
  );
  const statusLine = `${runningHeadline} · ${threadLabel}`;

  return (
    <>
      <section className="workspace-hero">
        <div className="workspace-hero-copy">
          <span className="workspace-hero-project">{projectTitle}</span>
          <h1>{loopTitle}</h1>
          <div className="workspace-status-row">
            <StatusPill text={modeText} active={snapshot?.state?.mode === "running"} />
            <StatusPill
              text={continuationStatus}
              tone={snapshot?.thread?.continuationStatus === "error" ? "danger" : "soft"}
              active={isDispatching}
            />
            <StatusPill text={launcherPhase} tone="soft" />
            <StatusPill text={pollStatus} tone="soft" active={pollState.syncing} />
          </div>
          <div className="workspace-guide-card is-actions-only compact-actions">
            <strong>{statusLine}</strong>
            <div className="workspace-guide-actions">
              <button
                type="button"
                className="primary-button"
                disabled={submitting}
                onClick={() => void handleDashboardAction("start-loop")}
              >
                开始循环
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={submitting}
                onClick={() => void handleDashboardAction("stop-loop")}
              >
                停止
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={submitting}
                onClick={() => setActiveSidebarPane("create")}
              >
                新建 loop
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={submitting}
                onClick={() => {
                  setActiveManageSection("ollama");
                  setActiveSidebarPane("manage");
                }}
              >
                设置
              </button>
              <button
                type="button"
                className="ghost-button danger-zone-button"
                disabled={submitting}
                onClick={() => void onRequestShutdown()}
              >
                关闭控制台
              </button>
            </div>
          </div>
        </div>

        <div className="workspace-hero-aside">
          <div className={`workspace-thinking-card ${thinkingStateClass}`}>
            <div className={`thinking-pulse ${thinkingStateClass}`} aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div>
              <strong>{runningHeadline}</strong>
              <p>{runningDescription}</p>
            </div>
          </div>
        </div>
      </section>

      {uiError ? <div className="error-banner">{uiError}</div> : null}

      <div className="workspace-columns">
        <div className="workspace-primary">
          <Section title="对话记录">
            <ConversationTimeline
              entries={codexConversationEntries}
              latestCodexUser={latestCodexUser}
              latestCodexAssistant={latestCodexAssistant}
              latestPrompt={latestPrompt}
              latestPromptAt={snapshot?.thread?.lastDispatchAt}
              fallbackEntries={visibleTranscriptEntries}
            />
          </Section>
        </div>

        <aside className="workspace-secondary">
          <Section title="状态" desc={latestVisibleSummary}>
            <StatusSummaryPanelV2
              modeText={modeText}
              continuationStatus={continuationStatus}
              currentLoopName={loopTitle}
              threadLabel={threadLabel}
              modelStatus={modelStatus}
              pollStatus={pollStatus}
              healthSummary={healthSummary}
            />
          </Section>
        </aside>
      </div>
    </>
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
  const [activeManageSection, setActiveManageSection] = useState("automation");
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
      setSelectedLoopId((current) => {
        const selected = pickVisibleLoop(nextLoops.loops || [], current || nextLoops.currentLoopId);
        return selected?.id || nextLoops.currentLoopId || "";
      });
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
      const rawMessage = String(error?.message || "");
      setUiError(
        error.name === "AbortError"
          ? "请求超时，请检查本地控制台服务是否仍在运行。"
          : rawMessage.includes("Unexpected end of JSON input")
            ? "服务返回内容不完整，请稍后重试。"
            : rawMessage,
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

  async function requestFullShutdown() {
    const runningActiveLoop =
      snapshot?.state?.mode === "running" &&
      !snapshot?.state?.stopRequested &&
      !snapshot?.state?.finalizeRequested;
    const message = runningActiveLoop
      ? "当前任务还在运行。确认后会先请求停止当前任务，再关闭 codex-loop 服务。是否继续？"
      : "确认关闭 codex-loop 服务吗？这会直接关闭当前控制台进程，适合用于重启。";

    if (!window.confirm(message)) {
      return;
    }

    await withSubmit(async () => {
      await requestJson("/shutdown", {
        method: "POST",
        body: JSON.stringify({
          reason: "manual shutdown from dashboard",
        }),
      });
    });
  }

  const loopGroups = useMemo(
    () => groupLoopsByProject(filterVisibleLoops(loopRegistry.loops || [])),
    [loopRegistry],
  );

  const currentLoop = useMemo(
    () => pickVisibleLoop(loopRegistry.loops || [], selectedLoopId || loopRegistry.currentLoopId),
    [loopRegistry, selectedLoopId],
  );
  const visibleLoops = useMemo(
    () => filterVisibleLoops(loopRegistry.loops || []),
    [loopRegistry],
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
  const healthIssues = (snapshot?.health?.issues || []).map(translateHealthIssue);
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
    : "默认模式";
  const remoteTransport = remoteAccessStatus?.recommendedTransport || "tailscale";
  const launcherWebUrl = launcherStatus?.webUrl || launcherStatus?.webBaseUrl || "未提供";
  const latestEvent = formatValue(snapshot?.thread?.latestEventType || snapshot?.state?.events?.at(-1)?.type, "暂无");
  const pollStatus = pollState.syncing
    ? "同步中"
    : pollState.failedCount > 0
      ? `重试 ${pollState.failedCount}`
      : pollState.lastSuccessAt
        ? `更新于 ${formatTime(pollState.lastSuccessAt)}`
        : "等待首次同步";
  const threadTitle =
    snapshot?.thread?.threadTitle || snapshot?.thread?.workspaceName || "尚未绑定可见窗口";
  const threadLabel = snapshot?.thread?.threadId
    ? `${threadTitle}（${snapshot.thread.threadId}）`
    : threadTitle;
  const changeSummary =
    snapshot?.thread?.lastAssistantActionSummary ||
    mobileView?.summary?.recentSummary ||
    latestSummary;
  const mobileSummary =
    mobileView?.summary?.recentSummary || latestSummary;
  const dashboardGuide = deriveDashboardGuide({
    snapshot,
    currentLoop,
    mobileView,
    pollStatus,
  });

  async function handleDashboardAction(actionId) {
    if (actionId === "open-manage") {
      setActiveSidebarPane("manage");
      return;
    }

    if (actionId === "open-create") {
      setActiveSidebarPane("create");
      return;
    }

    if (actionId === "start-loop") {
      await withSubmit(async () => {
        await requestJson("/start", { method: "POST" });
      });
      return;
    }

    if (actionId === "stop-loop") {
      await withSubmit(async () => {
        await requestJson("/stop", {
          method: "POST",
          body: JSON.stringify({
            reason: "manual stop from dashboard",
          }),
        });
      });
      return;
    }
  }

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
                ["loops", "任务"],
                ["create", "创建"],
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
                                            setActiveSidebarPane("manage");
                                            setLoopMenuOpenId("");
                                          }}
                                        >
                                          打开设置
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            withSubmit(async () => {
                                              const nextName = window.prompt("输入新的任务名称", loop.name);
                                              if (!nextName || nextName === loop.name) return;
                                              await requestJson("/rename-loop", {
                                                method: "POST",
                                                body: JSON.stringify({ loopName: nextName }),
                                              });
                                              setLoopMenuOpenId("");
                                            })
                                          }
                                        >
                                          重命名任务
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
                                            删除这个任务
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

            {activeSidebarPane !== "loops" ? (
              <div className="sidebar-pane-hint">
                <strong>{activeSidebarPane === "create" ? "正在创建新任务" : "正在调整全局设置"}</strong>
                <p>
                  {activeSidebarPane === "create"
                    ? "右侧已经切换到完整创建流程。"
                    : "右侧已经切换到完整设置面板。"}
                </p>
              </div>
            ) : null}

            <div className="sidebar-footer">
              <button
                type="button"
                className={`sidebar-settings-button ${activeSidebarPane === "manage" ? "is-active" : ""}`}
                onClick={() => {
                  setActiveManageSection("ollama");
                  setActiveSidebarPane("manage");
                }}
              >
                <span className="sidebar-settings-icon" aria-hidden="true">设置</span>
                <span>设置</span>
              </button>
            </div>
          </>
        ) : (
          <div className="sidebar-collapsed-list">
            {visibleLoops.map((loop) => (
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
            <button
              type="button"
              className={`collapsed-loop-pill ${activeSidebarPane === "manage" ? "is-active" : ""}`}
              onClick={() => {
                setActiveManageSection("ollama");
                setActiveSidebarPane("manage");
              }}
              title="设置"
            >
              设置
            </button>
          </div>
        )}
      </aside>

      <section className="workspace-main">
        {activeSidebarPane === "create" ? (
          <CreateWorkspaceView
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
            onBack={() =>
              withSubmit(async () => {
                await requestJson("/loop-creation-assistant/back", {
                  method: "POST",
                });
                setAssistantAnswer("");
              })
            }
            onReset={() =>
              withSubmit(async () => {
                await requestJson("/loop-creation-assistant/reset", {
                  method: "POST",
                });
                setAssistantAnswer("");
              })
            }
          />
        ) : null}

        {activeSidebarPane === "manage" ? (
          <ManageWorkspaceView
            threadForm={threadForm}
            setThreadForm={setThreadForm}
            settingsForm={settingsForm}
            setSettingsForm={setSettingsForm}
            automationStatus={automationStatus}
            launcherPhase={launcherPhase}
            launcherWebUrl={launcherWebUrl}
            remoteAccessStatus={remoteAccessStatus}
            remoteTransport={remoteTransport}
            ollamaModels={ollamaModels}
            promptGeneratorStatus={promptGeneratorStatus}
            conversationLanguage={conversationLanguage}
            healthIssues={healthIssues}
            latestEvent={latestEvent}
            snapshot={snapshot}
            submitting={submitting}
            withSubmit={withSubmit}
            activeManageSection={activeManageSection}
            setActiveManageSection={setActiveManageSection}
          />
        ) : null}

        {activeSidebarPane === "loops" ? (
          <DashboardHome
            currentLoop={currentLoop}
            snapshot={snapshot}
            modeText={modeText}
            continuationStatus={continuationStatus}
            launcherPhase={launcherPhase}
            pollStatus={pollStatus}
            pollState={pollState}
            dashboardGuide={dashboardGuide}
            submitting={submitting}
            handleDashboardAction={handleDashboardAction}
            setActiveSidebarPane={setActiveSidebarPane}
            setActiveManageSection={setActiveManageSection}
            onRequestShutdown={requestFullShutdown}
            automationSchedule={automationSchedule}
            automationStatus={automationStatus}
            threadLabel={threadLabel}
            latestSummary={latestSummary}
            changeSummary={changeSummary}
            suggestedAction={suggestedAction}
            transcriptEntries={transcriptEntries}
            latestPrompt={latestPrompt}
            mobileSummary={mobileSummary}
            bindingNote={bindingNote}
            strategy={strategy}
            settingsForm={settingsForm}
            healthIssues={healthIssues}
            uiError={uiError}
          />
        ) : null}

        
      </section>
    </main>
  );
}
