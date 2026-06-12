import React, { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

import { deriveDashboardGuide } from "./dashboard-guide.mjs";
import { dedupeRuntimeEventsForDisplay } from "./runtime-events.mjs";
import {
  buildProductionFocusSummary,
  buildModelPipelineSummary,
  buildStatusHeroSummary,
  buildLongRunDecision,
  getConversationActionLabel,
  getConversationDetailKindLabel,
  getConversationEntryLabel,
  getConversationRoleLabel,
  presentStatusRowLabel as presentSharedStatusRowLabel,
} from "../../shared/presentation.mjs";
import {
  getConversationDetailLabel,
  getConversationDetailMeta,
  parseMarkdownTextBlock,
  splitMarkdownBlocks,
} from "../../shared/conversation-format.mjs";
import { buildConversationItemsFromMobileView } from "../../shared/conversation-items.mjs";

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
const CODEX_LOOP_MOBILE_DEVICE = "codex-loop-mobile-device";
const MOBILE_DEVICE_STORAGE_KEY = CODEX_LOOP_MOBILE_DEVICE;
const DEFAULT_SUPERVISOR_FORM = {
  roleTraits:
    "同时扮演产品经理、测试人员、挑剔真实用户和长期监工：控制范围，关注可用性，主动发现偏离用户目标的问题。",
  testingRules:
    "Codex 完成一个清晰里程碑后再做独立验收；优先检查用户能否看懂状态、历史记录和下一步。",
  acceptanceCriteria:
    "每轮只推进一小批可验证改动；完成后必须能说明改了什么、如何验证、还有什么风险。",
};

const modeTextMap = {
  running: "运行中",
  finalize_after_current: "收尾中",
  stopped: "已停止",
};

const continuationTextMap = {
  idle: "等待下一轮",
  dispatching: "已发送，等待 Codex",
  reviewing: "监督复盘中",
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

function shortThreadId(threadId = "") {
  const value = formatValue(threadId, "");
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function groupLoopsByProject(loops = [], projects = []) {
  const groupedProjects = [];
  const byName = new Map();

  const ensureProject = (project) => {
    const name = formatValue(project?.name || project?.projectName, "未分类项目");
    const key = name.toLocaleLowerCase();
    if (!byName.has(key)) {
      const nextProject = {
        id: project?.id || key,
        name,
        workspaceRoot: project?.workspaceRoot || "",
        isEmpty: Boolean(project?.isEmpty),
        loops: [],
      };
      byName.set(key, nextProject);
      groupedProjects.push(nextProject);
    }
    return byName.get(key);
  };

  for (const project of projects) {
    ensureProject(project);
  }

  for (const loop of loops) {
    const project = ensureProject({
      name: loop.projectName || "未分类项目",
      workspaceRoot: loop.workspaceRoot || "",
    });
    project.loops.push(loop);
    project.isEmpty = false;
  }

  return groupedProjects.map((project) => ({
    ...project,
    isEmpty: project.loops.length === 0,
  }));
}

function presentStatusRowLabel(label) {
  if (label === "longrun") {
    return "长跑判断";
  }
  return label;
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

function buildProjectMenuId(projectName = "") {
  return `project:${projectName}`;
}

function getInitialSidebarOpen() {
  if (typeof window === "undefined") {
    return true;
  }
  return !window.matchMedia("(max-width: 720px)").matches;
}

function resolveLauncherPhaseText(launcherStatus, snapshot, pollState) {
  const phase = launcherStatus?.phase || "";
  const dashboardIsLive = Boolean(snapshot) && (Boolean(pollState?.lastSuccessAt) || Boolean(snapshot?.health));

  if (launcherStatus?.serverReady && launcherStatus?.webReady) {
    return "前后端已就绪";
  }

  if (phase === "starting" && dashboardIsLive) {
    return "控制台可用";
  }

  return launcherPhaseTextMap[phase] || formatValue(phase, "未知");
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

function presentPendingGuidanceStatus(result, fallback = "已记录下一轮补充。") {
  const pending = result?.pendingGuidance;
  const primary = formatValue(result?.message, "").trim();
  if (primary) {
    return primary;
  }
  if (!pending || typeof pending !== "object") {
    return fallback;
  }

  const statusLabel = formatValue(pending.statusLabel, "").trim();
  const detail =
    formatValue(pending.userMessage, "").trim() ||
    formatValue(pending.statusDetail, "").trim();

  if (statusLabel && detail) {
    return `${statusLabel}：${detail}`;
  }
  if (detail) {
    return detail;
  }
  if (statusLabel) {
    return statusLabel;
  }
  return fallback;
}

function applyPendingGuidanceFeedback(result, fallback, setMessage) {
  const text = presentPendingGuidanceStatus(result, fallback);
  setMessage(text);
}

function buildUserFacingProcessDigest(processStatus, fallbackDetail = "") {
  const headline = formatValue(processStatus?.headline, "当前可继续推进");
  const detail = formatValue(processStatus?.detail || fallbackDetail, "系统正在同步最新状态。");
  const holdReason = formatValue(processStatus && processStatus.holdReason, "");
  const nextAction = formatValue(processStatus?.nextAction, "先看最新记录，再决定是否继续发送下一轮。");
  const now = holdReason ? `${headline}，${holdReason}` : headline;
  return {
    now,
    detail,
    nextAction,
    holdReason,
  };
}

function copyTextToClipboard(text) {
  const value = formatValue(text, "");
  if (!value) return;
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

const THREAD_ID_REQUEST_PROMPT =
  "请告诉我当前这个 Codex 窗口的 threadId，只输出 threadId，不要输出解释。";

function ThreadIdHelpCard({ compact = false }) {
  const steps = compact
    ? [
        "优先在创建任务里填写项目路径和 Codex 窗口名自动匹配。",
        "自动匹配失败时，再在 Codex 窗口发送下面这句话。",
        "复制 Codex 返回的 threadId。",
        "粘贴到线程 ID 作为兜底。",
      ]
    : [
        "优先填写项目路径和 Codex 窗口名，让系统自动匹配。",
        "如果提示找不到或不唯一，再复制这句话发给目标 Codex 窗口。",
        "它返回 threadId 后，粘贴到线程 ID。",
        "保存绑定后再开始循环。",
      ];

  return (
    <div className={`thread-id-help-card ${compact ? "is-compact" : ""}`}>
      <div>
        <strong>{compact ? "新窗口线程号" : "获取线程号"}</strong>
        <p>
          {compact
            ? "创建前先确认这个任务要绑定哪个 Codex 窗口。"
            : "自动匹配失败时，再用这一句向目标 Codex 窗口询问 threadId。"}
        </p>
      </div>
      <ol className="thread-id-step-list">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="thread-id-copy-row">
        <code>{THREAD_ID_REQUEST_PROMPT}</code>
        <button type="button" className="ghost-button" onClick={() => copyTextToClipboard(THREAD_ID_REQUEST_PROMPT)}>
          复制指令
        </button>
      </div>
      <small>这个指令只用于获取窗口编号，不会启动循环。</small>
    </div>
  );
}

function trimPathToken(token) {
  return formatValue(token, "").replace(/[),.;，。；）]+$/u, "");
}

function looksLikeFilePath(token) {
  const value = trimPathToken(token);
  return (
    /^[A-Za-z]:[\\/][^\s]+/.test(value) ||
    /^\.{1,2}[\\/][^\s]+/.test(value) ||
    /^\/[^\s]+/.test(value)
  );
}

function InlineMessageText({ text }) {
  const value = formatValue(text, "");
  if (!value) return null;

  const pattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|[A-Za-z]:[\\/][^\s`，。；：、（）()<>"]+|\.{1,2}[\\/][^\s`，。；：、（）()<>"]+|\/[^\s`，。；：、（）()<>"]+)/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) {
      parts.push(value.slice(lastIndex, match.index));
    }

    const raw = match[0];
    if (raw.startsWith("`") && raw.endsWith("`")) {
      parts.push(
        <code className="inline-code" key={`${match.index}-code`}>
          {raw.slice(1, -1)}
        </code>,
      );
    } else {
      const linkMatch = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const pathText = linkMatch ? linkMatch[2] : trimPathToken(raw);
      if (looksLikeFilePath(pathText)) {
        parts.push(
          <button
            type="button"
            className="file-path-chip"
            key={`${match.index}-path`}
            title="右键复制路径"
            onClick={() => copyTextToClipboard(pathText)}
            onContextMenu={(event) => {
              event.preventDefault();
              copyTextToClipboard(pathText);
            }}
          >
            {linkMatch ? linkMatch[1] : pathText}
          </button>,
        );
      } else {
        parts.push(raw);
      }
    }

    lastIndex = match.index + raw.length;
  }

  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }

  return parts.map((part, index) =>
    typeof part === "string" ? <React.Fragment key={`text-${index}`}>{part}</React.Fragment> : part,
  );
}

function MarkdownMessage({ text }) {
  const value = formatValue(text, "");
  if (!value) return null;
  const blocks = splitMarkdownBlocks(value);

  function renderTextBlock(blockText, blockIndex) {
    const segments = parseMarkdownTextBlock(blockText);

    return segments.map((segment, index) => {
      if (segment.type === "heading") {
        const Tag = segment.depth === 1 ? "h3" : "h4";
        return (
          <Tag className="markdown-heading" key={`${blockIndex}-${index}`}>
            <InlineMessageText text={segment.text} />
          </Tag>
        );
      }

      if (segment.type === "list") {
        const ListTag = segment.ordered ? "ol" : "ul";
        return (
          <ListTag className="markdown-list" key={`${blockIndex}-${index}`}>
            {segment.items.map((item, itemIndex) => (
              <li key={`${blockIndex}-${index}-${itemIndex}`}>
                <InlineMessageText text={item} />
              </li>
            ))}
          </ListTag>
        );
      }

      return (
        <p className="markdown-paragraph" key={`${blockIndex}-${index}`}>
          <InlineMessageText text={segment.text} />
        </p>
      );
    });
  }

  return (
    <div className="markdown-message">
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <figure className="markdown-code-block" key={`code-${index}`}>
            <figcaption>
              <span>{block.lang || "代码"}</span>
              <button type="button" onClick={() => copyTextToClipboard(block.content)}>
                复制
              </button>
            </figcaption>
            <pre>{block.content}</pre>
          </figure>
        ) : (
          <React.Fragment key={`text-${index}`}>
            {renderTextBlock(block.content, index)}
          </React.Fragment>
        ),
      )}
    </div>
  );
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
  if (value === "context:missing") {
    return "已配置的项目规则或开发文档缺失，请先恢复文件或重新配置后再继续。";
  }
  if (value === "context:not-file") {
    return "已配置的项目规则或开发文档不是有效文件，请重新选择正确的文档文件。";
  }
  if (value === "context:unreadable") {
    return "已配置的项目规则或开发文档无法读取，请检查文件权限或重新配置后再继续。";
  }
  if (value === "workspace:missing") {
    return "项目路径不存在，请先恢复项目目录或重新选择工作区。";
  }
  if (value === "workspace:not-directory") {
    return "项目路径不是目录，请重新选择正确的项目工作区。";
  }
  if (value === "workspace:unreadable") {
    return "项目路径无法读取，请检查权限或重新选择工作区。";
  }
  return value || "暂无";
}

function formatReadinessStage(readiness = {}) {
  const stage = readiness?.stage || "";
  if (stage === "production") return "可长跑";
  if (stage === "observing") return "观察中";
  if (stage === "trial") return "短时试用";
  if (stage === "blocked") return "需处理";
  return "等待判断";
}

function formatProductionTarget(target = {}) {
  return [
    formatValue(target.threadTitle || target.workspaceName || target.runId, ""),
    formatValue(target.workspaceRoot, ""),
    target.threadId ? shortThreadId(target.threadId) : "",
  ]
    .filter(Boolean)
    .join(" / ");
}

function isUsefulTranscriptEntry(entry) {
  const summary = formatValue(entry?.summary || entry?.note, "");
  const note = formatValue(entry?.note, "");
  if (!summary && !note) {
    return false;
  }
  const text = `${summary}\n${note}`;
  if (text.includes("???") || text.includes("锟")) {
    return false;
  }
  if (text.includes("循环已启动") || text.includes("正在等待第一轮")) {
    return false;
  }
  if (text.includes("正在向绑定的 Codex 线程发送")) {
    return false;
  }
  if (text.includes("已收到停止指令") || text.includes("已清空未发送的补充引导")) {
    return false;
  }
  if (text.includes("manual stop") || note === "pending_guidance_cleared") {
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
  if (snapshot?.thread?.continuationStatus === "reviewing") {
    return "正在监督复盘，等待本地模型决定下一步。";
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
        tone === "warning" ? "is-warning" : "",
        tone === "ready" ? "is-ready" : "",
        tone === "soft" ? "is-soft" : "",
        tone === "active" ? "is-active" : "",
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

function buildLoopProgressItems({ processStatus, runtimeEvents = [], healthSummary = "" }) {
  const latestEventType = processStatus?.latestEventType || runtimeEvents[0]?.type || "";
  const hasThread = processStatus?.state !== "unbound";
  const hasStopLimit =
    processStatus?.stopLimit && processStatus.stopLimit !== "未设置停止条件";
  const hasPendingGuidance = Boolean(processStatus?.hasPendingGuidance);
  const hasSupervisorReview = Boolean(processStatus?.hasSupervisorReview);
  const hasHealthIssue = healthSummary && healthSummary !== "当前没有明显异常。";

  return [
    {
      key: "binding",
      label: "线程绑定",
      detail: hasThread ? "已绑定目标 Codex 线程" : "先绑定要接入的 Codex 窗口",
      state: hasThread ? "done" : "current",
    },
    {
      key: "current-turn",
      label: "当前轮",
      detail:
        processStatus?.headline ||
        (latestEventType === "codex_followup_completed"
          ? "Codex 已完成一轮"
          : "等待下一轮可发送时机"),
      state:
        processStatus?.state === "error"
          ? "error"
          : processStatus?.waitingForCodex || processStatus?.reviewingSupervisor
            ? "current"
            : processStatus?.canSendNextTurn
              ? "done"
              : "pending",
    },
    {
      key: "supervisor",
      label: "监督复盘",
      detail: processStatus?.reviewingSupervisor
        ? "本地模型正在监督复盘，完成前不发送下一条"
        : hasSupervisorReview
        ? processStatus?.supervisorInstructionPreview || processStatus?.supervisorReview
        : "等待 Codex 完成后再由本地模型复盘",
      state: processStatus?.reviewingSupervisor ? "current" : hasSupervisorReview ? "done" : "pending",
    },
    {
      key: "guidance",
      label: "补充引导",
      detail: hasPendingGuidance
        ? processStatus.pendingGuidancePreview
        : "没有临时补充，按文档和规则推进",
      state: hasPendingGuidance ? "current" : "pending",
    },
    {
      key: "stop-limit",
      label: "停止条件",
      detail: processStatus?.stopLimit || "未设置停止条件",
      state: hasStopLimit ? "done" : "pending",
    },
    {
      key: "health",
      label: "健康状态",
      detail: hasHealthIssue ? healthSummary : "暂无需要处理的异常",
      state: hasHealthIssue ? "error" : "done",
    },
  ];
}

function LoopProgressPanel({ processStatus, runtimeEvents, healthSummary }) {
  const items = buildLoopProgressItems({ processStatus, runtimeEvents, healthSummary });
  const currentItem = items.find((item) => item.state === "current") || items.find((item) => item.state === "error") || items[0];

  return (
    <details className="loop-progress-panel">
      <summary>
        <span>进度</span>
        <strong>{currentItem?.label || "当前轮"}</strong>
      </summary>
      <div className="loop-progress-list">
        {items.map((item) => (
          <div className={`loop-progress-item is-${item.state}`} key={item.key}>
            <span className="loop-progress-dot" aria-hidden="true">
              {item.state === "done" ? "✓" : ""}
            </span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="loop-progress-source">来源：当前轮状态 · 最近运行记录</div>
    </details>
  );
}

function MobileAccessFold({
  remoteAccessStatus,
  launcherWebUrl,
  pairingSession,
  pairingLoading,
  pairingError,
  onCreatePairingSession,
  onRevokePairedDevice,
}) {
  const [pairingQrDataUrl, setPairingQrDataUrl] = useState("");
  const mobileUrl =
    remoteAccessStatus?.mobileAppUrl ||
    remoteAccessStatus?.primaryMobileUrl ||
    remoteAccessStatus?.url ||
    remoteAccessStatus?.publicBaseUrl ||
    launcherWebUrl ||
    "";
  const candidateUrls = remoteAccessStatus?.candidateUrls || [];
  const steps = remoteAccessStatus?.recommendedSteps || [];
  const devicePairing = remoteAccessStatus?.devicePairing || {};
  const summary =
    remoteAccessStatus?.summary ||
    "手机和这台电脑在同一网络后，可以用控制台地址查看当前任务。";
  const warning = remoteAccessStatus?.warning || "";
  const statusText =
    remoteAccessStatus?.statusText ||
    (remoteAccessStatus?.isLocalOnly ? "手机暂时不能直接打开当前地址。" : "手机可以打开这个地址。");
  const nextAction =
    remoteAccessStatus?.nextAction ||
    (remoteAccessStatus?.isLocalOnly
      ? "请换成这台电脑的 Tailscale 地址或局域网 IP。"
      : "用手机浏览器打开上面的地址。");
  const mobileUrlHint = remoteAccessStatus?.mobileUrlHint || "";
  const pairingSummary =
    remoteAccessStatus?.devicePairing?.summary ||
    devicePairing.summary ||
    "还没有绑定手机。";
  const pairingAction =
    remoteAccessStatus?.pairingAction ||
    devicePairing.nextAction ||
    "生成扫码绑定后，移动端 App 可以长期访问这台电脑。";
  const pairedDevices = Array.isArray(devicePairing.devices) ? devicePairing.devices : [];
  const pairingAuditEvents = Array.isArray(devicePairing.auditEvents)
    ? devicePairing.auditEvents.slice(-3).reverse()
    : [];

  useEffect(() => {
    let cancelled = false;
    const payload = pairingSession?.qrPayload || "";
    if (!payload) {
      setPairingQrDataUrl("");
      return () => {
        cancelled = true;
      };
    }

    QRCode.toDataURL(payload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 176,
      color: {
        dark: "#111111",
        light: "#ffffff",
      },
    })
      .then((url) => {
        if (!cancelled) {
          setPairingQrDataUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPairingQrDataUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pairingSession?.qrPayload]);

  return (
    <details className="mobile-access-fold">
      <summary>
        <span>移动端使用</span>
        <strong>{remoteAccessStatus?.mobileReachable ? "手机可打开" : "需要换地址"}</strong>
      </summary>
      <p className="mobile-access-status">{statusText}</p>
      {mobileUrl ? (
        <div className="mobile-access-url">
          <code>{mobileUrl}</code>
          <button type="button" onClick={() => copyTextToClipboard(mobileUrl)}>
            复制地址
          </button>
        </div>
      ) : null}
      {mobileUrlHint && mobileUrlHint !== mobileUrl ? (
        <p className="mobile-access-hint">手机上请改用：{mobileUrlHint}</p>
      ) : null}
      {candidateUrls.length ? (
        <div className="mobile-access-candidates">
          <strong>推荐手机地址</strong>
          {candidateUrls.map((candidate) => (
            <div className="mobile-access-candidate" key={candidate.url}>
              <span>{candidate.label || "手机地址"}</span>
              <code>{candidate.appUrl || candidate.url}</code>
              <button type="button" onClick={() => copyTextToClipboard(candidate.appUrl || candidate.url)}>
                复制
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <p>{nextAction}</p>
      <p>{summary}</p>
      {warning ? <p className="mobile-access-warning">{warning}</p> : null}
      <div className="mobile-pairing-panel">
        <div className="mobile-pairing-head">
          <div>
            <strong>扫码绑定</strong>
            <p>{pairingSummary}</p>
          </div>
          <button type="button" disabled={pairingLoading} onClick={onCreatePairingSession}>
            {pairingLoading ? "加载中" : "移动端使用"}
          </button>
        </div>
        <p>{pairingAction}</p>
        <p>长期绑定后，codex-loop 重启后不用重复扫码。</p>
        {pairingError ? <p className="mobile-access-warning">{pairingError}</p> : null}
        {pairedDevices.length ? (
          <div className="mobile-pairing-devices">
            {pairedDevices.map((device) => (
              <div className="mobile-pairing-device" key={device.id}>
                <div>
                  <strong>{device.name || "已绑定手机"}</strong>
                  <p>最近连接 {formatTime(device.lastSeenAt || device.pairedAt)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onRevokePairedDevice(device)}
                >
                  撤销绑定
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {pairingAuditEvents.length ? (
          <details className="mobile-pairing-audit">
            <summary>最近绑定记录</summary>
            {pairingAuditEvents.map((event, index) => (
              <p key={`${event.type}-${event.deviceId}-${event.at}-${index}`}>
                {event.type === "device_revoked" ? "撤销" : event.type === "device_paired" ? "绑定" : "验证"}
                {" · "}
                {event.deviceName || event.deviceId || "手机"}
                {" · "}
                {formatTime(event.at)}
              </p>
            ))}
          </details>
        ) : null}
        {pairingSession?.pairingCode ? (
          <div className="mobile-pairing-session">
            <div className="mobile-pairing-code">
              <span>配对码</span>
              <strong>{pairingSession.pairingCode}</strong>
              <button type="button" onClick={() => copyTextToClipboard(pairingSession.pairingCode)}>
                复制配对码
              </button>
            </div>
            {pairingSession?.browserPairingUrl ? (
              <p>手机扫码后会自动打开绑定页；如果扫码失败，可以展开备用方式。</p>
            ) : null}
            {pairingSession?.qrPayload ? (
              <div className="mobile-pairing-qr">
                <span>二维码</span>
                {pairingQrDataUrl ? (
                  <img
                    className="mobile-pairing-qr-image"
                    src={pairingQrDataUrl}
                    alt="手机扫码绑定"
                  />
                ) : null}
              </div>
            ) : null}
            {pairingSession?.browserPairingUrl || pairingSession?.qrPayload ? (
              <details className="mobile-pairing-backup">
                <summary>备用绑定方式</summary>
                {pairingSession?.browserPairingUrl ? (
                  <div className="mobile-pairing-code">
                    <span>绑定链接</span>
                    <code>{pairingSession.browserPairingUrl}</code>
                    <button type="button" onClick={() => copyTextToClipboard(pairingSession.browserPairingUrl)}>
                      复制链接
                    </button>
                  </div>
                ) : null}
                {pairingSession?.qrPayload ? (
                  <div className="mobile-pairing-code">
                    <span>扫码内容</span>
                    <code>{pairingSession.qrPayload}</code>
                    <button type="button" onClick={() => copyTextToClipboard(pairingSession.qrPayload)}>
                      复制内容
                    </button>
                  </div>
                ) : null}
              </details>
            ) : null}
            {pairingSession?.expiresAt ? (
              <p>有效期到 {formatTime(pairingSession.expiresAt)}，过期后重新生成即可。</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {steps.length ? (
        <div className="mobile-access-steps">
          {steps.map((step, index) => (
            <p key={`${index}-${step}`}>{index + 1}. {step}</p>
          ))}
        </div>
      ) : null}
    </details>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M13.8 2.8a1.9 1.9 0 0 1 2.7 2.7L6.9 15.1 3 16l.9-3.9 9.9-9.3Z" />
      <path d="m12.3 4.3 3.4 3.4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M4.5 6.2h11" />
      <path d="M8.2 3.8h3.6l.8 1.6H7.4l.8-1.6Z" />
      <path d="M6.2 6.2 7 16h6l.8-9.8" />
      <path d="M8.8 8.6v4.8M11.2 8.6v4.8" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M3.4 10 16.2 3.8 12 16.2l-2.4-5.8L3.4 10Z" />
      <path d="m9.6 10.4 6.6-6.6" />
    </svg>
  );
}

function IconButton({ label, children, disabled = false, tone = "default", onClick }) {
  return (
    <button
      type="button"
      className={`icon-button ${tone === "danger" ? "is-danger" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PendingGuidanceComposer({
  pendingGuidanceText,
  setPendingGuidanceText,
  pendingGuidanceEditMode = false,
  submitting,
  onSavePendingGuidance,
  onCancelPendingGuidanceEdit,
}) {
  return (
    <form
      className="conversation-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void onSavePendingGuidance(pendingGuidanceText);
      }}
    >
      <textarea
        rows={2}
        aria-label="补充下一轮给 Codex 的话"
        value={pendingGuidanceText}
        placeholder="补充你要说的话 ,等 Codex 完成后合并，会等 Codex 当前任务完成再发送"
        onChange={(event) => setPendingGuidanceText(event.target.value)}
      />
      {pendingGuidanceEditMode ? (
        <button
          type="button"
          className="ghost-button"
          disabled={submitting}
          onClick={() => onCancelPendingGuidanceEdit?.()}
        >
          取消编辑
        </button>
      ) : null}
      <button
        type="submit"
        className="primary-button"
        disabled={submitting || !pendingGuidanceText.trim()}
      >
        {pendingGuidanceEditMode ? "保存修改" : "发送"}
      </button>
    </form>
  );
}

function readStoredMobileDevice() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(MOBILE_DEVICE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStoredMobileDevice(device) {
  if (typeof window === "undefined") {
    return;
  }

  if (!device?.deviceId || !device?.deviceToken) {
    window.localStorage.removeItem(MOBILE_DEVICE_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(MOBILE_DEVICE_STORAGE_KEY, JSON.stringify(device));
}

function parsePairingPayload(value) {
  const text = formatValue(value, "");
  if (!text) {
    return {};
  }

  try {
    const url = new URL(text);
    return {
      sessionId: url.searchParams.get("sessionId") || "",
      pairingCode: url.searchParams.get("code") || "",
    };
  } catch {
    return {};
  }
}

function buildMobileConversationEntries(mobileView) {
  return buildConversationItemsFromMobileView(mobileView, {
    latestPromptLabel: "codex-loop 指令",
    assistantFallbackLabel: "Codex 回复",
    runtimeFallbackLabel: "运行记录",
  });

  if (mobileView?.conversationItems?.length) {
    return dedupeConversationEntries(mobileView.conversationItems);
  }

  const codexEntries = mobileView?.codexConversation?.entries || [];
  if (codexEntries.length) {
    return dedupeConversationEntries(codexEntries);
  }

  const entries = [];
  const latestPrompt = formatValue(mobileView?.latestPrompt, "");
  if (latestPrompt) {
    entries.push({
      at: mobileView?.thread?.lastDispatchAt || "",
      role: "user",
      text: latestPrompt,
      preview: latestPrompt,
      label: "codex-loop 指令",
    });
  }

  for (const entry of mobileView?.transcriptEntries || []) {
    const summary = entry.summary || entry.note || "";
    if (!summary) continue;
    entries.push({
      at: entry.at,
      role: "assistant",
      text: summary,
      preview: summary,
      label: entry.activeTask || "Codex 回复",
    });
  }

  for (const event of mobileView?.runtimeEvents || []) {
    const detail = event.detail || event.title || "";
    if (!detail) continue;
    entries.push({
      at: event.at,
      role: event.type?.includes("dispatch") ? "user" : "assistant",
      text: detail,
      preview: detail,
      label: event.title || "运行记录",
    });
  }

  return dedupeConversationEntries(entries);
}

function MobileConversationTimeline({ mobileView }) {
  const entries = buildMobileConversationEntries(mobileView).sort((a, b) => {
    const left = Date.parse(a.at || "");
    const right = Date.parse(b.at || "");
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return left - right;
  });
  const bottomRef = useRef(null);
  const latest = entries.at(-1) || {};

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [entries.length, latest.at, latest.role]);

  if (!entries.length) {
    return (
      <div className="conversation-empty">
        还没有同步到历史对话。绑定任务后，这里会展示 codex-loop 指令和 Codex 回复。
      </div>
    );
  }

  return (
    <div className="conversation-timeline mobile-task-conversation">
      {entries.map((entry, index) => {
        const isLoopMessage = entry.role === "user" || entry.role === "loop";
        const fullText = formatValue(entry.text || entry.summary || entry.preview, "");
        const summary = summarizeVisibleText(
          entry.preview || fullText,
          isLoopMessage ? "codex-loop 已发送一条指令" : "Codex 已返回一条记录",
          isLoopMessage ? 160 : 260,
        );
        return (
          <article
            className={isLoopMessage ? "conversation-row is-loop" : "conversation-row is-codex"}
            key={`${entry.at || index}-${entry.role}-${index}`}
          >
            <details
              className="conversation-bubble"
              open={shouldOpenConversationEntry({
                entry,
                fullText,
                isLoopMessage,
                isGuidance: false,
                index,
                total: entries.length,
              })}
            >
              <summary>
                <span className="conversation-meta">
                  {formatTime(entry.at, "未知时间")} · {getConversationEntryLabel({
                    isGuidance: false,
                    isLoop: isLoopMessage,
                  })}
                </span>
                <strong>{summary}</strong>
                <span className="conversation-actions">
                  <em>
                    {getConversationActionLabel({
                      hasText: Boolean(fullText),
                      isGuidance: false,
                      isLoop: isLoopMessage,
                    })}
                  </em>
                  {fullText ? (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        copyTextToClipboard(fullText);
                      }}
                    >
                      复制全文
                    </button>
                  ) : null}
                </span>
              </summary>
              {fullText ? <MarkdownMessage text={fullText} /> : null}
              <ConversationDetailBlocks blocks={entry.detailBlocks} />
            </details>
          </article>
        );
      })}
      <div className="conversation-bottom-anchor" ref={bottomRef} aria-hidden="true" />
    </div>
  );
}

function MobileTaskApp() {
  const [mobileDevice, setMobileDevice] = useState(readStoredMobileDevice);
  const [mobileView, setMobileView] = useState(null);
  const [pairingPayload, setPairingPayload] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [guidanceText, setGuidanceText] = useState("");
  const [mobileGuidanceEditMode, setMobileGuidanceEditMode] = useState(false);
  const [mobileProductionStatus, setMobileProductionStatus] = useState(null);
  const [mobileProductionPreflight, setMobileProductionPreflight] = useState(null);
  const [statusText, setStatusText] = useState("正在连接 codex-loop。");
  const [errorText, setErrorText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef(null);

  const parsedPairing = parsePairingPayload(pairingPayload);
  const effectiveSessionId = sessionId || parsedPairing.sessionId || "";
  const effectivePairingCode = pairingCode || parsedPairing.pairingCode || "";

  async function loadProtectedMobileView({ silent = false } = {}) {
    if (!mobileDevice?.deviceId || !mobileDevice?.deviceToken) {
      setStatusText("请先完成手机绑定。");
      return;
    }

    if (!silent) {
      setStatusText("正在同步任务。");
    }
    try {
      const [result, productionStatusResult, productionPreflightResult] = await Promise.all([
        requestJson("/mobile/view", {
          method: "POST",
          body: JSON.stringify({
            deviceId: mobileDevice?.deviceId,
            deviceToken: mobileDevice?.deviceToken,
          }),
        }),
        requestJson("/production-status").catch(() => null),
        requestJson("/production-preflight").catch(() => null),
      ]);
      setMobileView(result.mobile);
      setMobileProductionStatus(productionStatusResult);
      setMobileProductionPreflight(productionPreflightResult);
      setErrorText("");
      setStatusText("手机已绑定，任务状态已同步。");
    } catch (error) {
      setErrorText(error?.message || "同步失败，请重新扫码。");
      setStatusText("手机绑定不可用。");
      if (/设备未绑定|重新扫码|令牌/.test(error?.message || "")) {
        writeStoredMobileDevice(null);
        setMobileDevice(null);
      }
    }
  }

  useEffect(() => {
    void loadProtectedMobileView();
  }, [mobileDevice?.deviceId, mobileDevice?.deviceToken]);

  useEffect(() => {
    window.clearInterval(pollRef.current);
    if (!mobileDevice?.deviceId || !mobileDevice?.deviceToken) {
      return undefined;
    }

    pollRef.current = window.setInterval(() => {
      void loadProtectedMobileView({ silent: true });
    }, ACTIVE_POLL_MS);

    return () => window.clearInterval(pollRef.current);
  }, [mobileDevice?.deviceId, mobileDevice?.deviceToken]);

  async function confirmPairing() {
    if (!effectiveSessionId || !effectivePairingCode) {
      setErrorText("请粘贴扫码内容，或输入配对会话和配对码。");
      return;
    }

    setSubmitting(true);
    setErrorText("");
    try {
      const result = await requestJson("/device-pairing/confirm", {
        method: "POST",
        body: JSON.stringify({
          sessionId: effectiveSessionId,
          pairingCode: effectivePairingCode,
          deviceName: "移动端任务",
        }),
      });
      const nextDevice = {
        deviceId: result.device?.id,
        deviceToken: result.deviceToken,
        deviceName: result.device?.name || "移动端任务",
      };
      writeStoredMobileDevice(nextDevice);
      setMobileDevice(nextDevice);
      setStatusText("手机已绑定，正在同步任务。");
      setPairingPayload("");
      setPairingCode("");
      setSessionId("");
    } catch (error) {
      setErrorText(error?.message || "绑定失败，请重新扫码。");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveMobileGuidance() {
    const text = guidanceText.trim();
    if (!text || !mobileDevice?.deviceId || !mobileDevice?.deviceToken) {
      return;
    }

    setSubmitting(true);
    setErrorText("");
    try {
      const guidanceResult = await requestJson("/mobile/guidance", {
        method: "POST",
        body: JSON.stringify({
          deviceId: mobileDevice?.deviceId,
          deviceToken: mobileDevice?.deviceToken,
          text,
          replace: mobileGuidanceEditMode,
        }),
      });
      setGuidanceText("");
      setMobileGuidanceEditMode(false);
      setStatusText(
        guidanceResult?.message ||
          (guidanceResult?.dispatch === "sent"
            ? "已发送引导，正在等待 Codex 完成当前轮。"
            : "已保存补充引导，会等 Codex 完成后交给本地模型 / NPC 合并。"),
      );
      applyPendingGuidanceFeedback(
        guidanceResult,
        guidanceResult?.dispatch === "sent"
          ? "已发送补充引导，正在等待 Codex 完成当前轮。"
          : "已记录补充引导，会在 Codex 完成后合并发送。",
        setStatusText,
      );
      await loadProtectedMobileView({ silent: true });
    } catch (error) {
      setErrorText(error?.message || "发送引导失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  async function clearMobileGuidance() {
    if (!mobileDevice?.deviceId || !mobileDevice?.deviceToken) {
      return;
    }

    setSubmitting(true);
    setErrorText("");
    try {
      const result = await requestJson("/mobile/guidance", {
        method: "DELETE",
        body: JSON.stringify({
          deviceId: mobileDevice?.deviceId,
          deviceToken: mobileDevice?.deviceToken,
        }),
      });
      setStatusText(result?.message || "已撤回待合并引导。");
      applyPendingGuidanceFeedback(result, "已撤回待合并引导。", setStatusText);
      setGuidanceText("");
      setMobileGuidanceEditMode(false);
      await loadProtectedMobileView({ silent: true });
    } catch (error) {
      setErrorText(error?.message || "撤回失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  const loopName = mobileView?.loop?.name || "移动端任务";
  const processStatus = mobileView?.processStatus || {};
  const headline = processStatus.headline || mobileView?.suggestedAction || statusText;
  const threadTitle = mobileView?.thread?.title || mobileView?.thread?.threadId || "未绑定线程";
  const mobileProductionObservation = mobileProductionStatus?.sections?.find(
    (section) => section.label === "真实运行观察",
  );
  const mobileClosedLoopEvidence = mobileProductionStatus?.closedLoopEvidence || {};
  const mobileGuidanceEvidence = mobileProductionStatus?.guidanceEvidence || {};
  const mobileClosedLoopCount = Math.max(
    0,
    Number(mobileClosedLoopEvidence.current ?? mobileProductionObservation?.counters?.closedLoops ?? 0),
  );
  const mobileClosedLoopTarget = Math.max(1, Number(mobileClosedLoopEvidence.target ?? 2));
  const mobileGuidanceEvidenceCount = Math.max(0, Number(mobileGuidanceEvidence.current ?? 0));
  const mobileGuidanceEvidenceTarget = Math.max(1, Number(mobileGuidanceEvidence.target ?? 1));
  const mobileProductionFocus = buildProductionFocusSummary({
    productionStatus: mobileProductionStatus,
    productionPreflight: mobileProductionPreflight,
    productionObservation: mobileProductionObservation,
    closedLoopCount: mobileClosedLoopCount,
    closedLoopTarget: mobileClosedLoopTarget,
    guidanceEvidenceCount: mobileGuidanceEvidenceCount,
    guidanceEvidenceTarget: mobileGuidanceEvidenceTarget,
  });
  const mobileModelPipeline = buildModelPipelineSummary(processStatus);
  const mobileProductionTarget = formatProductionTarget(
    mobileProductionPreflight?.target || mobileProductionStatus?.target,
  );
  const mobileStatusRows = [
    mobileProductionFocus.summary ? ["生产判断", mobileProductionFocus.summary] : null,
    mobileModelPipeline.headline ? ["模型链路", mobileModelPipeline.headline] : null,
    mobileProductionTarget ? ["验证目标", mobileProductionTarget] : null,
  ].filter(Boolean);
  const mobileStatusDetails = [
    mobileProductionFocus.attention ? ["当前要留意", mobileProductionFocus.attention] : null,
    mobileProductionFocus.nextAction ? ["生产建议", mobileProductionFocus.nextAction] : null,
    mobileModelPipeline.detail ? ["模型说明", mobileModelPipeline.detail] : null,
  ].filter(Boolean);

  return (
    <main className="mobile-task-shell">
      <header className="mobile-task-header">
        <span>codex-loop</span>
        <h1>{loopName}</h1>
        <p>{headline}</p>
        <div className="mobile-task-status-line">
          <strong>{statusText}</strong>
          <span>{threadTitle}</span>
        </div>
      </header>

      {errorText ? <div className="error-banner">{errorText}</div> : null}

      {!mobileDevice ? (
        <section className="mobile-task-pairing">
          <h2>绑定这台电脑</h2>
          <p>在桌面控制台生成扫码绑定后，把扫码内容粘贴到这里；绑定后下次不用重复扫码。</p>
          <textarea
            rows={4}
            value={pairingPayload}
            placeholder="粘贴扫码内容，例如 codex-loop://pair?sessionId=...&code=..."
            onChange={(event) => setPairingPayload(event.target.value)}
          />
          <div className="mobile-task-pairing-grid">
            <input
              value={sessionId}
              placeholder="配对会话"
              onChange={(event) => setSessionId(event.target.value)}
            />
            <input
              value={pairingCode}
              placeholder="配对码"
              onChange={(event) => setPairingCode(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={submitting}
            onClick={() => void confirmPairing()}
          >
            确认绑定
          </button>
        </section>
      ) : (
        <>
          <section className="mobile-task-panel">
            {mobileStatusRows.map(([label, value]) => (
              <div className="mobile-task-panel-row" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
            {mobileStatusDetails.length ? (
              <details className="mobile-task-panel-details">
                <summary>查看判断依据</summary>
                <div className="mobile-task-panel-detail-list">
                  {mobileStatusDetails.map(([label, value]) => (
                    <p key={label}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </p>
                  ))}
                </div>
              </details>
            ) : null}
            <div className="mobile-task-panel-row">
              <span>当前状态</span>
              <strong>{processStatus.monitorLabel || mobileView?.loop?.modeLabel || "监控中"}</strong>
            </div>
            <div className="mobile-task-panel-row">
              <span>下一步</span>
              <strong>{processStatus.nextAction || mobileView?.suggestedAction || "等待下一轮更新"}</strong>
            </div>
            {processStatus.latestInstructionSourceLabel ? (
              <div className="mobile-task-panel-row">
                <span>最近指令</span>
                <strong>{processStatus.latestInstructionSourceLabel}</strong>
              </div>
            ) : null}
            {processStatus.latestCodexSummarySourceLabel ? (
              <div className="mobile-task-panel-row">
                <span>回复摘要</span>
                <strong>{processStatus.latestCodexSummarySourceLabel}</strong>
              </div>
            ) : null}
            {processStatus.lastMergedGuidanceStatus ? (
              <div className="mobile-task-panel-row">
                <span>已合并补充</span>
                <strong>{processStatus.lastMergedGuidancePreview || processStatus.lastMergedGuidanceLabel}</strong>
              </div>
            ) : null}
            {mobileView?.pendingGuidance?.hasPending ? (
              <div className="mobile-task-panel-row">
                <span>待合并</span>
                <div className="mobile-task-pending-actions">
                  {mobileView.pendingGuidance.statusLabel ? (
                    <em>{mobileView.pendingGuidance.statusLabel}</em>
                  ) : null}
                  <strong>{mobileView.pendingGuidance.preview || mobileView.pendingGuidance.text}</strong>
                  {mobileView.pendingGuidance.statusDetail || mobileView.pendingGuidance.userMessage ? (
                    <small>{mobileView.pendingGuidance.statusDetail || mobileView.pendingGuidance.userMessage}</small>
                  ) : null}
                  <div className="mobile-task-pending-buttons">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={submitting}
                      aria-label={`${mobileView.pendingGuidance.actionLabel || "等待发送"}，编辑待合并引导`}
                      onClick={() => {
                        setGuidanceText(mobileView.pendingGuidance.text || "");
                        setMobileGuidanceEditMode(true);
                      }}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={submitting}
                      onClick={() => void clearMobileGuidance()}
                    >
                      撤回
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <MobileConversationTimeline mobileView={mobileView} />

          <form
            className="mobile-task-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void saveMobileGuidance();
            }}
          >
            <textarea
              rows={3}
              value={guidanceText}
              placeholder="补充你要说的话 ,等 Codex 完成后合并，会等 Codex 当前任务完成再发送"
              onChange={(event) => setGuidanceText(event.target.value)}
            />
            {mobileGuidanceEditMode ? (
              <button
                type="button"
                className="ghost-button"
                disabled={submitting}
                onClick={() => {
                  setGuidanceText("");
                  setMobileGuidanceEditMode(false);
                }}
              >
                取消编辑
              </button>
            ) : null}
            <button
              type="submit"
              className="primary-button"
              disabled={submitting || !guidanceText.trim()}
            >
              {mobileGuidanceEditMode ? "保存修改" : "发送引导"}
            </button>
          </form>
        </>
      )}
    </main>
  );
}

function StatusSummaryPanel({
  modeText,
  continuationStatus,
  controllerStatus,
  codexWorkStatus,
  processStatus,
  currentLoopName,
  threadLabel,
  modelStatus,
  pollStatus,
  healthSummary,
  runtimeEvents,
  productionStatus,
  productionPreflight,
}) {
  const processDetail = processStatus?.detail || codexWorkStatus;
  const monitorText = processStatus?.monitorLabel || processStatus?.headline || continuationStatus;
  const statusHero = buildStatusHeroSummary({
    headline: processStatus?.headline || monitorText,
    detail: processStatus?.detail || codexWorkStatus,
    nextAction: processStatus?.nextAction,
  });
  const productionObservation = productionStatus?.sections?.find(
    (section) => section.label === "真实运行观测",
  );
  const readiness = productionStatus?.readiness || {};
  const maturity = productionStatus?.maturity || {};
  const productionTarget = formatProductionTarget(productionPreflight?.target || productionStatus?.target);
  const readinessLabel = maturity?.label || formatReadinessStage(readiness);
  const maturityPercent = Number(maturity?.percent);
  const maturityLabel = Number.isFinite(maturityPercent)
    ? `${readinessLabel} · ${maturityPercent}%`
    : readinessLabel;
  const maturityGaps = Array.isArray(maturity?.gaps) ? maturity.gaps.filter(Boolean) : [];
  const maturityGapText = maturityGaps.length
    ? maturityGaps.slice(0, 2).join("；")
    : maturity?.canLongRun
      ? "已达到长期运行基本证据。"
      : "等待更多真实闭环证据。";
  const closedLoopEvidence = productionStatus?.closedLoopEvidence || {};
  const closedLoopCount = Math.max(
    0,
    Number(closedLoopEvidence.current ?? productionObservation?.counters?.closedLoops ?? 0),
  );
  const closedLoopTarget = Math.max(1, Number(closedLoopEvidence.target ?? 2));
  const closedLoopProgress = Math.min(100, Math.round((closedLoopCount / closedLoopTarget) * 100));
  const closedLoopText = closedLoopEvidence.label ||
    (closedLoopCount >= closedLoopTarget
      ? "已达到长期运行基本证据"
      : `还差 ${closedLoopTarget - closedLoopCount} 轮真实闭环`);
  const guidanceEvidence = productionStatus?.guidanceEvidence || {};
  const guidanceEvidenceCount = Math.max(0, Number(guidanceEvidence.current ?? 0));
  const guidanceEvidenceTarget = Math.max(1, Number(guidanceEvidence.target ?? 1));
  const guidanceEvidenceText = guidanceEvidence.label ||
    (guidanceEvidenceCount >= guidanceEvidenceTarget
      ? "已观察到用户补充合并证据"
      : "还差 1 次用户补充合并证据");
  const closedLoopEvidencePlan = closedLoopEvidence.evidencePlan || {};
  const fallbackEvidencePlanSteps = [
    { label: "确认目标", detail: "确认当前任务、工作区和线程就是要继续验证的对象。" },
    { label: "发送一轮", detail: "只触发一次真实循环或手动发送一次引导，不连续追发。" },
    { label: "等待 Codex 完成", detail: "Codex 未完成前不要追加发送。" },
    { label: "NPC 复盘", detail: "等待产品经理、测试人员、真实用户视角完成复盘。" },
    { label: "重新检查", detail: "重新查看生产状态，确认真实闭环是否达到 2 轮。" },
  ];
  const evidencePlanSteps = Array.isArray(closedLoopEvidencePlan.steps) && closedLoopEvidencePlan.steps.length
    ? closedLoopEvidencePlan.steps.filter(Boolean)
    : fallbackEvidencePlanSteps;
  const evidencePlanText = evidencePlanSteps.length
    ? evidencePlanSteps
        .map((step) => `${step.label || "下一步"}：${step.detail || ""}`.trim())
        .join("；")
    : closedLoopEvidencePlan.summary || "";
  const preflightLabel = productionPreflight?.canDispatch
    ? "可以启动"
    : productionPreflight?.status === "waiting"
      ? "等待中"
      : productionPreflight
        ? "先别启动"
        : "";
  const preflightDetail = productionPreflight?.nextAction || productionPreflight?.summary || "";
  const productionLabel =
    productionStatus?.status === "passed"
      ? "可继续"
      : productionStatus?.status === "waiting"
        ? "等待中"
        : productionStatus?.status
          ? "需要留意"
          : "";
  const productionDetail =
    productionObservation?.status === "stale"
      ? productionStatus?.nextAction ||
        "真实运行观测已过期，需要重新生成运行记录后再判断长期稳定性。"
      : productionObservation?.summary ||
        productionStatus?.nextAction ||
        "等待形成 2 轮真实闭环后，再作为长期运行基本证据。";
  const readinessDetail = readiness.summary || readiness.nextAction || productionDetail;
  const productionStageSummary = summarizeVisibleText(
    maturity?.summary || readinessDetail,
    "等待更多真实闭环证据。",
    76,
  );
  const productionObservationSummary = summarizeVisibleText(
    productionDetail,
    productionObservation?.status === "stale" ? "真实运行观测已过期。" : "等待形成新的真实观测。",
    76,
  );
  const longRunDecision = buildLongRunDecision({
    hasProductionStatus: Boolean(productionStatus),
    closedLoopCount,
    closedLoopTarget,
    guidanceEvidenceCount,
    guidanceEvidenceTarget,
  });
  const productionFocus = buildProductionFocusSummary({
    productionStatus,
    productionPreflight,
    productionObservation,
    closedLoopCount,
    closedLoopTarget,
    guidanceEvidenceCount,
    guidanceEvidenceTarget,
  });
  const modelPipeline = buildModelPipelineSummary(processStatus);
  const verificationStatus = processStatus?.supervisorVerificationStatus || "";
  const verificationLabel =
    processStatus?.supervisorVerificationLabel ||
    (verificationStatus === "failed"
      ? "未通过"
      : verificationStatus === "passed"
        ? "已通过"
        : verificationStatus === "running"
          ? "进行中"
          : "");
  const verificationText =
    verificationLabel || processStatus?.supervisorVerificationAction || "";
  const rows = [
    productionStatus ? ["longrun", longRunDecision] : null,
    ["当前", `${modeText} · ${monitorText}`],
    ["说明", processDetail],
    processStatus?.nextAction ? ["下一步", processStatus.nextAction] : null,
  ].filter(Boolean);
  const primaryLabels = new Set(["当前", "说明", "下一步"]);
  const detailRows = [
    productionFocus.summary ? ["生产判断", productionFocus.summary] : null,
    productionFocus.attention ? ["当前要留意", productionFocus.attention] : null,
    productionFocus.nextAction ? ["生产建议", productionFocus.nextAction] : null,
    modelPipeline.headline ? ["模型链路", modelPipeline.headline] : null,
    modelPipeline.detail ? ["模型说明", modelPipeline.detail] : null,
    productionTarget ? ["验证目标", productionTarget] : null,
    productionPreflight ? ["启动预检", `${preflightLabel} · ${preflightDetail}`] : null,
    productionStatus ? ["生产阶段", `${maturityLabel} · ${productionStageSummary}`] : null,
    productionStatus ? ["生产观测", `${productionLabel} · ${productionObservationSummary}`] : null,
    controllerStatus?.label
      ? [
          "自动循环",
          controllerStatus?.detail
            ? `${controllerStatus.label}：${controllerStatus.detail}`
            : controllerStatus.label,
        ]
      : null,
    processStatus?.latestInstructionSourceLabel
      ? [
          "最近指令",
          [
            processStatus.latestInstructionSourceLabel,
            processStatus.latestInstructionSourceDetail,
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
    processStatus?.latestCodexSummarySourceLabel
      ? [
          "回复摘要",
          [
            processStatus.latestCodexSummarySourceLabel,
            processStatus.latestCodexSummarySourceDetail,
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
    verificationText ? ["独立验收", verificationText] : null,
    processStatus?.holdReason ? ["判断", processStatus.holdReason] : null,
    processStatus?.hasPendingGuidance
      ? [
          "待合并补充",
          [
            processStatus?.pendingGuidancePreview || "已记录",
            processStatus?.pendingGuidanceMergeLabel,
            processStatus?.pendingGuidanceMergeDetail,
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
    processStatus?.lastMergedGuidanceStatus
      ? [
          "已合并补充",
          [
            processStatus.lastMergedGuidanceLabel,
            processStatus.lastMergedGuidancePreview,
            processStatus.lastMergedGuidanceDetail,
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
    processStatus?.hasSupervisorReview
      ? ["监督复盘", processStatus?.supervisorReview || "已完成监督复盘"]
      : null,
    processStatus?.supervisorPerspectiveRows?.length
      ? [
          "NPC 视角",
          processStatus.supervisorPerspectiveRows
            .map((row) => `${row.label}：${row.text}`)
            .join("；"),
        ]
      : null,
    processStatus?.hasSupervisorReview
      ? ["下一条指令", processStatus?.supervisorInstructionPreview || "等待生成下一条指令"]
      : null,
    processStatus?.needsIndependentVerification
      ? ["验收建议", processStatus?.acceptanceFocusPreview || "建议先做独立验收"]
      : null,
    processStatus?.verificationCommands?.length
      ? [
          "验证命令",
          processStatus?.verificationCommandPreview ||
            processStatus.verificationCommands.join(" · "),
        ]
      : null,
    productionStatus?.title
      ? [
          "生产成熟度",
          [
            maturityLabel,
            productionStatus.status === "passed" ? "可继续使用" : "需要留意",
            productionStatus.nextAction
              ? `${productionStatus.nextActionLabel || "下一步建议"}：${productionStatus.nextAction}`
              : "",
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
    productionStatus?.maturity ? ["剩余缺口", maturityGapText] : null,
    productionStatus
      ? [
          "长跑提示",
          closedLoopCount >= closedLoopTarget
            ? "已经具备长跑基础证据，可以继续观察更长时间稳定性。"
            : `距离可长跑还差 ${Math.max(0, closedLoopTarget - closedLoopCount)} 轮真实闭环证据。`,
        ]
      : null,
    productionStatus?.guidanceEvidence
      ? [
          "补充合并证据",
          `${guidanceEvidenceCount}/${guidanceEvidenceTarget} · ${guidanceEvidenceText}。${guidanceEvidence.summary || "确认用户补充引导会等 Codex 完成后由本地模型 / NPC 合并。"}`
        ]
      : null,
    evidencePlanText
      ? ["下一轮验证", `${closedLoopEvidencePlan.summary || "按真实闭环验证计划推进。"} ${evidencePlanText}`]
      : null,
    productionPreflight?.title
      ? [
          "真实循环前预检",
          [
            preflightLabel,
            productionPreflight.summary,
            productionPreflight.nextAction,
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
    productionStatus?.sections?.length
      ? [
          "最近生产检查",
          productionStatus.sections
            .slice(0, 3)
            .map((section) =>
              [section.label, section.summary].filter(Boolean).join("："),
            )
            .join(" · "),
        ]
      : null,
    productionObservation
      ? [
          "真实运行观测",
          [
            productionObservation.status === "stale" ? "已过期" : productionObservation.summary,
            productionObservation.nextAction,
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
    processStatus?.supervisorVerificationEvidenceCount
      ? [
          "截图证据",
          processStatus?.supervisorVerificationEvidencePreview ||
            `${processStatus.supervisorVerificationEvidenceCount} 个截图证据`,
        ]
      : null,
    ["停止条件", processStatus?.stopLimit || "未设置停止条件"],
    ["线程", threadLabel],
    ["模型", modelStatus],
    ["健康提示", healthSummary || "当前没有明显异常。"],
    ["刷新状态", pollStatus],
  ].filter(Boolean);
  const primaryRows = rows.filter(([label]) => primaryLabels.has(label));
  if (productionStatus) {
    primaryRows.unshift(["longrun", longRunDecision]);
  }

  return (
    <div className="status-summary-panel">
      <div className="status-summary-hero">
        <div className="status-summary-hero-block">
          <span>这一轮在做什么</span>
          <strong>{statusHero.headline}</strong>
          <p>{statusHero.detail}</p>
        </div>
        <div className="status-summary-hero-block">
          <span>你下一步该做什么</span>
          <strong>{statusHero.nextAction}</strong>
        </div>
      </div>
      {primaryRows.map(([label, value]) => (
        <div className="status-summary-row" key={label}>
          <span>{presentSharedStatusRowLabel(label)}</span>
          <strong>{value}</strong>
        </div>
      ))}
      {productionStatus ? (
        <div className="closed-loop-evidence">
          <div>
            <span>闭环证据</span>
            <strong>{closedLoopCount}/{closedLoopTarget} · {closedLoopText}</strong>
          </div>
          <div className="closed-loop-evidence-metrics">
            <div className="closed-loop-evidence-metric">
              <span>已完成闭环</span>
              <strong>{closedLoopCount}/{closedLoopTarget}</strong>
            </div>
            <div className="closed-loop-evidence-metric">
              <span>补充合并证据</span>
              <strong>{guidanceEvidenceCount}/{guidanceEvidenceTarget}</strong>
            </div>
          </div>
          <div className="closed-loop-evidence-bar" aria-hidden="true">
            <span style={{ width: `${closedLoopProgress}%` }} />
          </div>
        </div>
      ) : null}
      <details className="status-detail-fold">
        <summary>
          <span>更多状态</span>
          <strong>生产判断、模型链路、线程和运行记录</strong>
        </summary>
        <LoopProgressPanel
          processStatus={processStatus}
          runtimeEvents={runtimeEvents}
          healthSummary={healthSummary}
        />
        {detailRows.map(([label, value]) => (
          <div className="status-summary-row" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
        <RuntimeEventList events={runtimeEvents} />
      </details>
    </div>
  );
}

const StatusSummaryPanelV2 = StatusSummaryPanel;

function ConversationDetailBlocks({ blocks = [] }) {
  const visibleBlocks = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (!visibleBlocks.length) {
    return null;
  }

  const detailLabelFallback = (block) => {
    if (block.displayLabel || block.summary) {
      return formatValue(block.displayLabel || block.summary, "查看详情");
    }
    if (block.kind === "script_snippet") {
      return "脚本内容 · 1 段脚本";
    }
    return "查看详情";
  };

  const detailMetaFallback = (block) => {
    const parts = [
      formatValue(block.countLabel, ""),
      formatValue(block.summary, ""),
    ].filter(Boolean);
    return parts.join(" · ");
  };

  return (
    <div className="conversation-detail-list">
      {visibleBlocks.map((block, index) => (
        <details
          className="conversation-detail-block"
          key={`${block.kind || "detail"}-${index}`}
          open={block.collapsedByDefault === false}
        >
          <summary>
            <span className="conversation-detail-heading">
              <span className="conversation-detail-kind">
                {getConversationDetailKindLabel(block.kind)}
              </span>
              <span className="conversation-detail-label">
                {formatValue(getConversationDetailLabel(block), "查看详情")}
              </span>
            </span>
            {getConversationDetailMeta(block) ? (
              <span className="conversation-detail-meta">{getConversationDetailMeta(block)}</span>
            ) : null}
          </summary>
          {Array.isArray(block.copyTargets) && block.copyTargets.length ? (
            <div className="conversation-detail-actions">
              {block.copyTargets.map((target, targetIndex) => (
                <button
                  type="button"
                  key={`${target.kind || "copy"}-${targetIndex}`}
                  onClick={(event) => {
                    event.preventDefault();
                    copyTextToClipboard(target.value);
                  }}
                >
                  {formatValue(target.label, target.kind === "command" ? "复制命令" : "复制文件")}
                </button>
              ))}
            </div>
          ) : null}
          <pre className="conversation-detail-body">{formatValue(block.text, "")}</pre>
        </details>
      ))}
    </div>
  );
}

function RuntimeEventList({ events = [] }) {
  const visibleEvents = dedupeRuntimeEventsForDisplay(events, 4);
  if (!visibleEvents.length) {
    return null;
  }

  return (
    <div className="runtime-event-list">
      <div className="runtime-event-heading">运行记录</div>
      {visibleEvents.map((event, index) => (
        <article
          className={`runtime-event-item ${event.tone === "danger" ? "is-danger" : ""}`}
          key={`${event.at || index}-${event.type || "event"}`}
        >
          <span>{formatTime(event.at, "刚刚")}</span>
          <strong className="runtime-event-title">{formatValue(event.title, "运行记录")}</strong>
          {event.detail ? <p>{event.detail}</p> : null}
        </article>
      ))}
    </div>
  );
}

function ConversationTimeline({
  entries,
  latestCodexUser,
  latestCodexAssistant,
  latestPrompt,
  latestPromptAt,
  pendingGuidance,
  pendingGuidanceAt,
  pendingGuidanceText,
  setPendingGuidanceText,
  pendingGuidanceEditMode,
  submitting,
  onSavePendingGuidance,
  onCancelPendingGuidanceEdit,
  onClearPendingGuidance,
  onEditPendingGuidance,
  onSendPendingGuidance,
  guidanceStatusMessage,
  fallbackEntries,
}) {
  const baseConversationEntries = entries.length
    ? entries
    : [
        latestCodexAssistant
          ? { ...latestCodexAssistant, label: "Codex 回复", role: "assistant" }
          : null,
        latestCodexUser
          ? { ...latestCodexUser, label: "codex-loop 指令", role: "user" }
          : null,
      ].filter(Boolean);
  const conversationEntries = dedupeConversationEntries(baseConversationEntries.filter(Boolean));

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

  const savedPendingGuidanceText = formatValue(pendingGuidance, "");
  if (savedPendingGuidanceText) {
    conversationEntries.push({
      at: pendingGuidanceAt,
      role: "guidance",
      text: savedPendingGuidanceText,
      preview: savedPendingGuidanceText,
      label: "你的补充",
      statusLabel: "待下一轮合并",
    });
  }

  const uniqueConversationEntries = dedupeConversationEntries(conversationEntries);

  uniqueConversationEntries.sort((a, b) => {
    const left = Date.parse(a.at || "");
    const right = Date.parse(b.at || "");
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return left - right;
  });

  const fallbackConversation = !uniqueConversationEntries.length && fallbackEntries.length
    ? fallbackEntries.map((entry) => ({
        at: entry.at,
        role: "assistant",
        text: entry.summary,
        preview: entry.summary,
        label: "本地记录",
      }))
    : [];
  const visibleEntries = uniqueConversationEntries.length ? uniqueConversationEntries : fallbackConversation;
  const latestEntry = visibleEntries.at(-1) || {};
  const conversationBottomRef = useRef(null);

  useEffect(() => {
    conversationBottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [visibleEntries.length, latestEntry.at, latestEntry.role, pendingGuidanceText, pendingGuidance]);

  return (
    <div className="conversation-timeline">
      {visibleEntries.length ? visibleEntries.map((entry, index) => {
        const isGuidance = entry.role === "guidance";
        const isLoopMessage = entry.role === "user" || entry.role === "loop" || isGuidance;
        const rowClassName = isGuidance
          ? "conversation-row is-guidance"
          : isLoopMessage
            ? "conversation-row is-loop"
            : "conversation-row is-codex";
        const fullText = formatValue(entry.text, isLoopMessage ? latestPrompt : "");
        const previewText = formatValue(entry.preview, fullText);
        const summary = summarizeVisibleText(previewText || fullText, "暂无内容", isLoopMessage ? 180 : 320);
        const bubble = (
          <details
            className="conversation-bubble"
            open={shouldOpenConversationEntry({
              entry,
              fullText,
              isLoopMessage,
              isGuidance,
              index,
              total: visibleEntries.length,
            })}
          >
              <summary>
                <span className="conversation-meta-line">
                  <span className="conversation-role">
                    {getConversationRoleLabel(entry.role)}
                  </span>
                  <span className="conversation-meta">
                    {entry.statusLabel || formatTime(entry.at, "未知时间")}
                  </span>
                </span>
                <strong>{summary}</strong>
                <span className="conversation-actions">
                  <em>
                    {getConversationActionLabel({
                      hasText: Boolean(fullText),
                      isGuidance,
                      isLoop: isLoopMessage,
                    })}
                  </em>
                  {fullText ? (
                    <button
                      className="conversation-copy-button"
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        copyTextToClipboard(fullText);
                      }}
                    >
                      复制全文
                    </button>
                  ) : null}
                </span>
              </summary>
              {fullText ? <MarkdownMessage text={fullText} /> : null}
              <ConversationDetailBlocks blocks={entry.detailBlocks} />
          </details>
        );
        return (
          <article
            className={rowClassName}
            key={`${entry.at || index}-${entry.role}-${index}`}
          >
            {isGuidance ? (
              <div className="pending-guidance-queued">
                {bubble}
                <div className="pending-guidance-tools" aria-label="待发送补充操作">
                  <IconButton
                    label="发送引导"
                    disabled={submitting}
                    onClick={() => void onSendPendingGuidance?.()}
                  >
                    <SendIcon />
                  </IconButton>
                  <IconButton
                    label="编辑补充"
                    disabled={submitting}
                    onClick={() => onEditPendingGuidance?.(fullText)}
                  >
                    <PencilIcon />
                  </IconButton>
                  <IconButton
                    label="删除补充"
                    tone="danger"
                    disabled={submitting}
                    onClick={() => void onClearPendingGuidance?.()}
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              </div>
            ) : (
              bubble
            )}
          </article>
        );
      }) : (
        <div className="conversation-empty">
          绑定线程并开始循环后，这里会像 Codex 对话一样展示 codex-loop 发出的指令和 Codex 的回复。
        </div>
      )}
      {guidanceStatusMessage ? (
        <div className="conversation-inline-status">{guidanceStatusMessage}</div>
      ) : null}
      <PendingGuidanceComposer
        pendingGuidanceText={pendingGuidanceText}
        setPendingGuidanceText={setPendingGuidanceText}
        pendingGuidanceEditMode={pendingGuidanceEditMode}
        submitting={submitting}
        onSavePendingGuidance={onSavePendingGuidance}
        onCancelPendingGuidanceEdit={onCancelPendingGuidanceEdit}
      />
      <div className="conversation-bottom-anchor" ref={conversationBottomRef} aria-hidden="true" />
    </div>
  );
}

function normalizeConversationText(entry) {
  return formatValue(entry?.text || entry?.preview || entry?.summary || "", "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeConversationEntries(entries = []) {
  const byContent = new Map();

  entries.filter(Boolean).forEach((entry, index) => {
    const role = entry.role === "guidance" ? "guidance" : entry.role === "user" ? "user" : "assistant";
    const text = normalizeConversationText(entry);
    const key = text ? `${role}:${text}` : `${role}:empty:${index}`;
    const existing = byContent.get(key);
    const currentTime = Date.parse(entry.at || "");
    const existingTime = Date.parse(existing?.at || "");

    if (
      !existing ||
      (Number.isFinite(currentTime) && (!Number.isFinite(existingTime) || currentTime >= existingTime))
    ) {
      byContent.set(key, entry);
    }
  });

  return [...byContent.values()];
}

function shouldOpenConversationEntry({ fullText, isLoopMessage, isGuidance, index, total }) {
  if (isLoopMessage || isGuidance) {
    return false;
  }

  const text = formatValue(fullText, "");
  if (!text) {
    return false;
  }

  const isLatest = index === total - 1;
  return isLatest && text.length <= 700;
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
  if (snapshot?.thread?.continuationStatus === "reviewing") {
    return "Codex 已完成，正在等待本地监督复盘。";
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
  creationMode = "task",
  projectCreationDraft = null,
}) {
  const currentQuestion = assistantState?.currentQuestion;
  const draft = assistantState?.draft || {};
  const plan = draft.plan || {};
  const messages = assistantState?.messages || [];
  const projectMode = creationMode === "project";

  return (
    <div className="sidebar-form assistant-pane">
      <h3>{projectMode ? "创建项目和首个任务" : "创建任务"}</h3>
      <p className="sidebar-help">
        {projectMode
          ? "先确认项目路径和项目名，再把任务收纳到这个项目下。"
          : projectCreationDraft?.projectName
            ? `将直接在项目「${projectCreationDraft.projectName}」下创建任务；先确认任务名和分支。`
            : "先确认项目、任务名和分支，再开始循环。"}
      </p>

      {projectCreationDraft?.projectName ? (
        <div className="assistant-prefill-hint">
          <strong>已选项目</strong>
          <p>
            {projectCreationDraft.projectName}
            {projectCreationDraft.workspaceRoot ? ` · ${projectCreationDraft.workspaceRoot}` : ""}
          </p>
        </div>
      ) : null}

      {currentQuestion ? (
        <>
          <div className="assistant-thread">
            <DetailCard meta="当前步骤" title="继续填写" body={currentQuestion.prompt} quiet />
            <ThreadIdHelpCard compact />

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

      {!currentQuestion ? (
        <div className="assistant-empty-state">
          <strong>开始新建任务</strong>
          <p>这里不会展示历史任务。点击下面按钮，从空白流程创建一个新任务。</p>
          <button
            type="button"
            className="primary-button"
            disabled={submitting}
            onClick={() => void onReset()}
          >
            开始新建任务
          </button>
        </div>
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
  loopSupervisorForm,
  setLoopSupervisorForm,
  automationStatus,
  launcherPhase,
  launcherWebUrl,
  remoteAccessStatus,
  remoteTransport,
  ollamaModels,
  promptGeneratorStatus,
  conversationLanguage,
  healthIssues,
  latestProgress,
  snapshot,
  submitting,
  withSubmit,
  activeManageSection,
  setActiveManageSection,
  currentLoopName,
  currentLoop,
  visibleLoops,
  onDeleteLoop,
}) {
  const isDispatching = snapshot?.thread?.continuationStatus === "dispatching";
  const isReviewing = snapshot?.thread?.continuationStatus === "reviewing";
  const isFinalizing = snapshot?.state?.stopRequested || snapshot?.state?.finalizeRequested;
  const isRunning = snapshot?.state?.mode === "running";
  const runningHeadline = isFinalizing
    ? "正在收尾"
    : isDispatching
      ? "已发送，等待 Codex 完成"
      : isReviewing
        ? "监督复盘中"
        : isRunning
        ? "循环运行中"
        : "当前任务已停止";
  const runningDescription = isFinalizing
    ? "不会再发送新指令，等待当前轮结束后停止。"
    : isDispatching
      ? "Codex 正在处理当前轮，完成前不会继续追发。"
      : isReviewing
        ? "本地模型正在监督复盘，完成前不发送下一条。"
        : isRunning
        ? "系统会等待 Codex 完整结束一轮，再决定是否继续发送。"
        : "需要继续时点击开始循环；如需本地模型参与，请先开启全局 Ollama。";
  const stopLimitSummary =
    snapshot?.state?.budgets &&
    (snapshot.state.budgets.maxMinutes ||
      snapshot.state.budgets.maxTokens ||
      snapshot.state.budgets.finalizeLeadMinutes ||
      snapshot.state.budgets.finalizeLeadTokens)
      ? `当前：${snapshot?.mobileView?.processStatus?.stopLimit || "已设置停止条件"}`
      : "当前：未设置停止条件";
  const thinkingStateClass = isFinalizing
    ? "is-finalizing"
    : isDispatching || isReviewing || isRunning
      ? "is-active"
      : "is-idle";
  const canDeleteCurrentLoop = Boolean(currentLoop?.id) && visibleLoops.some((loop) => loop.id !== currentLoop?.id);
  const remoteStatusSummary =
    remoteAccessStatus?.statusText ||
    (remoteAccessStatus?.mobileReachable ? "手机查看入口已可用。" : "手机查看入口还需要再确认。");
  const remoteNextStep =
    remoteAccessStatus?.nextAction ||
    (remoteAccessStatus?.mobileReachable ? "需要时再展开连接细节查看地址。" : "先展开连接细节，按提示处理地址或网络。");
  const hasConnectionDetails = Boolean(
    remoteAccessStatus?.url ||
      launcherWebUrl ||
      remoteTransport ||
      remoteAccessStatus?.warning ||
      remoteAccessStatus?.mobileUrlHint,
  );

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
            优先填写项目路径和 Codex 窗口名自动匹配；线程 ID 可留空。自动匹配失败时，再手动填写线程 ID。
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
            <span>项目路径</span>
            <input
              value={threadForm.workspaceRoot}
              placeholder="例如 E:\\2026\\your-project"
              onChange={(event) =>
                setThreadForm((current) => ({
                  ...current,
                  workspaceRoot: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>Codex 窗口名</span>
            <input
              value={threadForm.windowTitle}
              placeholder="输入 Codex 左侧看到的窗口标题关键词"
              onChange={(event) =>
                setThreadForm((current) => ({
                  ...current,
                  windowTitle: event.target.value,
                  threadTitle: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>线程 ID 可留空</span>
            <input
              value={threadForm.threadId}
              placeholder="自动匹配失败时再填写"
              onChange={(event) =>
                setThreadForm((current) => ({
                  ...current,
                  threadId: event.target.value,
                }))
              }
            />
          </label>
          <ThreadIdHelpCard />
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
        open={
          activeManageSection === "automation" ||
          activeManageSection === "ollama" ||
          activeManageSection === "npc" ||
          activeManageSection === "budgets"
        }
        onToggle={(event) => {
          if (
            event.currentTarget.open &&
            activeManageSection !== "ollama" &&
            activeManageSection !== "npc" &&
            activeManageSection !== "budgets"
          ) {
            setActiveManageSection("automation");
          }
        }}
      >
        <summary>默认规则</summary>
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
                    supervisor: {
                      roleTraits: settingsForm.supervisorRoleTraits,
                      testingRules: settingsForm.supervisorTestingRules,
                      acceptanceCriteria: settingsForm.supervisorAcceptanceCriteria,
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
              await requestJson("/budgets", {
                method: "POST",
                body: JSON.stringify({
                  maxMinutes: Number(settingsForm.maxMinutes),
                  maxTokens: Number(settingsForm.maxTokens),
                  finalizeLeadMinutes: Number(settingsForm.finalizeLeadMinutes),
                  finalizeLeadTokens: Number(settingsForm.finalizeLeadTokens),
                }),
              });
            });
          }}
        >
          <p className="sidebar-help">
            这里是工作区默认规则。没有填写当前任务专用设置时，会先继承这里的语言、本地模型和默认监督偏好。
          </p>
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
            <p className="settings-note">{stopLimitSummary}</p>
            <div className="settings-grid">
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={Boolean(settingsForm.promptGeneratorEnabled)}
                  onChange={(event) =>
                    setSettingsForm((current) => ({
                      ...current,
                      promptGeneratorEnabled: event.target.checked,
                    }))
                  }
                />
                <span>开启后作为默认能力提供给各个任务</span>
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

          <details
            className="workspace-details"
            open={activeManageSection === "npc"}
            onToggle={(event) => {
              if (event.currentTarget.open) setActiveManageSection("npc");
            }}
          >
            <summary>NPC 角色</summary>
            <p className="sidebar-help">
              定义 codex-loop 默认的产品经理、测试人员和真实用户偏好；当前任务如果有专用规则，会在这里的基础上覆盖。
            </p>
            <div className="settings-grid">
              <label>
                <span>角色特性</span>
                <textarea
                  rows={3}
                  value={settingsForm.supervisorRoleTraits}
                  onChange={(event) =>
                    setSettingsForm((current) => ({
                      ...current,
                      supervisorRoleTraits: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>测试规则</span>
                <textarea
                  rows={3}
                  value={settingsForm.supervisorTestingRules}
                  onChange={(event) =>
                    setSettingsForm((current) => ({
                      ...current,
                      supervisorTestingRules: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>验收标准</span>
                <textarea
                  rows={3}
                  value={settingsForm.supervisorAcceptanceCriteria}
                  onChange={(event) =>
                    setSettingsForm((current) => ({
                      ...current,
                      supervisorAcceptanceCriteria: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
          </details>

          <details
            className="workspace-details"
            open={activeManageSection === "budgets"}
            onToggle={(event) => {
              if (event.currentTarget.open) setActiveManageSection("budgets");
            }}
          >
            <summary>循环停止条件</summary>
            <p className="sidebar-help">
              到达限制后不会再发送下一条指令；如果 Codex 正在处理，会等当前轮结束后收尾。
            </p>
            <div className="settings-grid">
              <label>
                <span>最长运行时间（分钟）</span>
                <input
                  type="number"
                  min="1"
                  value={settingsForm.maxMinutes}
                  onChange={(event) =>
                    setSettingsForm((current) => ({
                      ...current,
                      maxMinutes: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>最大 token 预算</span>
                <input
                  type="number"
                  min="1"
                  value={settingsForm.maxTokens}
                  onChange={(event) =>
                    setSettingsForm((current) => ({
                      ...current,
                      maxTokens: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>提前收尾时间（分钟）</span>
                <input
                  type="number"
                  min="0"
                  value={settingsForm.finalizeLeadMinutes}
                  onChange={(event) =>
                    setSettingsForm((current) => ({
                      ...current,
                      finalizeLeadMinutes: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>提前收尾 token</span>
                <input
                  type="number"
                  min="0"
                  value={settingsForm.finalizeLeadTokens}
                  onChange={(event) =>
                    setSettingsForm((current) => ({
                      ...current,
                      finalizeLeadTokens: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
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
            保存默认规则
          </button>
        </form>
      </details>

      <details
        className="sidebar-disclosure"
        open={activeManageSection === "loop-npc"}
        onToggle={(event) => {
          if (event.currentTarget.open) setActiveManageSection("loop-npc");
        }}
      >
        <summary>当前任务 NPC</summary>
        <form
          className="sidebar-form"
          onSubmit={(event) => {
            event.preventDefault();
            void withSubmit(async () => {
              await requestJson("/loop-supervisor", {
                method: "POST",
                body: JSON.stringify(loopSupervisorForm),
              });
            });
          }}
        >
          <p className="sidebar-help">
            当前任务专用：补充这个项目自己的测试要求、验收规则和监督风格，不会改掉全局默认。
          </p>
          <div className="settings-grid">
            <label>
              <span>项目角色特性</span>
              <textarea
                rows={3}
                value={loopSupervisorForm.roleTraits}
                placeholder="例如：像挑剔真实用户一样验收移动端体验，不允许状态含糊。"
                onChange={(event) =>
                  setLoopSupervisorForm((current) => ({
                    ...current,
                    roleTraits: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>项目测试规则</span>
              <textarea
                rows={3}
                value={loopSupervisorForm.testingRules}
                placeholder="例如：每轮完成后先看移动端、历史记录和下一步引导是否清楚。"
                onChange={(event) =>
                  setLoopSupervisorForm((current) => ({
                    ...current,
                    testingRules: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>项目验收标准</span>
              <textarea
                rows={3}
                value={loopSupervisorForm.acceptanceCriteria}
                placeholder="例如：手机上 10 秒内能判断 Codex 是否正在处理、是否需要用户介入。"
                onChange={(event) =>
                  setLoopSupervisorForm((current) => ({
                    ...current,
                    acceptanceCriteria: event.target.value,
                  }))
                }
              />
            </label>
          </div>
          <button type="submit" className="primary-button" disabled={submitting}>
            保存当前任务 NPC
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
            <Metric label="最近进展" value={latestProgress} />
            <Metric label="手机查看" value={remoteAccessStatus?.mobileReachable ? "已就绪" : "待确认"} />
            <Metric
              label="健康状态"
              value={healthIssues.length ? `${healthIssues.length} 个提示` : "当前正常"}
            />
          </div>
          <p className="sidebar-help">{remoteStatusSummary}</p>
          <p className="sidebar-help">{remoteNextStep}</p>
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
          {hasConnectionDetails ? (
            <details className="workspace-details">
              <summary>连接细节</summary>
              <div className="detail-stack">
                <Metric label="连接方式" value={remoteTransport || "未识别"} />
                <Metric label="控制台地址" value={launcherWebUrl || "未提供"} />
                {remoteAccessStatus?.url ? (
                  <DetailCard
                    meta="远程入口"
                    title={remoteAccessStatus.url}
                    body="如果你需要在别的设备上查看状态，再使用这个地址。"
                    quiet
                  />
                ) : null}
                {remoteAccessStatus?.mobileUrlHint ? (
                  <DetailCard
                    meta="手机建议地址"
                    title={remoteAccessStatus.mobileUrlHint}
                    body="当默认地址在手机上打不开时，优先试这个地址。"
                    quiet
                  />
                ) : null}
                {remoteAccessStatus?.warning ? (
                  <DetailCard
                    meta="连接提醒"
                    title="需要留意"
                    body={remoteAccessStatus.warning}
                    quiet
                  />
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </details>

      <details
        className="sidebar-disclosure"
        open={activeManageSection === "task-actions"}
        onToggle={(event) => {
          if (event.currentTarget.open) setActiveManageSection("task-actions");
        }}
      >
        <summary>当前任务操作</summary>
        <div className="sidebar-form">
          <p className="sidebar-help">
            删除后不会保留这个任务的绑定和循环记录。若删除后项目为空，可在项目菜单里继续新建任务或删除空项目。
          </p>
          <button
            type="button"
            className="danger-button"
            disabled={!canDeleteCurrentLoop || submitting}
            title={
              canDeleteCurrentLoop
                ? `删除当前任务「${currentLoopName}」`
                : "至少还需要保留一个任务；请先新建或切换到其他任务。"
            }
            onClick={() => void onDeleteLoop(currentLoop)}
          >
            删除当前任务
          </button>
          {!canDeleteCurrentLoop ? (
            <p className="sidebar-help">
              当前只剩这一个任务，暂时不能直接删除。请先新建一个任务，或切换到其他任务后再删除它。
            </p>
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
  projectForm,
  setProjectForm,
  onCreateProject,
  onSubmit,
  onBack,
  onReset,
  creationMode = "task",
  projectCreationDraft = null,
}) {
  const projectMode = creationMode === "project";
  return (
    <section className="workspace-focus">
      <div className="workspace-focus-head">
        <span className="workspace-focus-eyebrow">{projectMode ? "新建项目" : "新建任务"}</span>
        <h1>{projectMode ? "先建立项目，再添加任务" : "新建一个任务"}</h1>
        <p>
          {projectMode
            ? "项目用来收纳同一工作区下的多个任务。当前会先创建项目下的第一个任务。"
            : projectCreationDraft?.projectName
              ? `当前会直接在项目「${projectCreationDraft.projectName}」下新建任务。`
              : "这里只显示新建流程，不会混入已经创建的任务。"}
        </p>
      </div>

      {projectMode ? (
        <ProjectCreationPanel
          projectForm={projectForm}
          setProjectForm={setProjectForm}
          submitting={submitting}
          onCreateProject={onCreateProject}
        />
      ) : (
        <LoopCreationAssistantPane
          assistantState={assistantState}
          assistantAnswer={assistantAnswer}
          setAssistantAnswer={setAssistantAnswer}
          submitting={submitting}
          onSubmit={onSubmit}
          onBack={onBack}
          onReset={onReset}
          creationMode={creationMode}
          projectCreationDraft={projectCreationDraft}
        />
      )}
    </section>
  );
}

function ProjectCreationPanel({
  projectForm,
  setProjectForm,
  submitting,
  onCreateProject,
}) {
  return (
    <form className="sidebar-form project-creation-panel" onSubmit={onCreateProject}>
      <h3>创建项目</h3>
      <p className="sidebar-help">
        项目用于收纳同一工作区下的多个任务。先创建项目，之后可以继续在这个项目下创建任务。
      </p>
      <label>
        <span>项目名称</span>
        <input
          value={projectForm.projectName}
          onChange={(event) =>
            setProjectForm((current) => ({
              ...current,
              projectName: event.target.value,
            }))
          }
          placeholder="例如 codex-loop"
        />
      </label>
      <label>
        <span>项目路径</span>
        <input
          value={projectForm.workspaceRoot}
          onChange={(event) =>
            setProjectForm((current) => ({
              ...current,
              workspaceRoot: event.target.value,
            }))
          }
          placeholder="例如 E:\\2026\\codex-loop"
        />
      </label>
      <button type="submit" className="primary-button" disabled={submitting || !projectForm.projectName.trim()}>
        {submitting ? "正在创建" : "创建项目"}
      </button>
    </form>
  );
}

function ManageWorkspaceView(props) {
  const currentLoopName = formatValue(
    props.snapshot?.config?.loopName || props.snapshot?.thread?.threadTitle,
    "当前任务",
  );
  return (
    <section className="workspace-focus">
      <div className="workspace-focus-head">
        <span className="workspace-focus-eyebrow">当前任务设置</span>
        <h1>调整「{currentLoopName}」</h1>
        <p>这里展示的是当前任务的绑定、运行方式和本任务专用规则，不再混成全局说明。</p>
      </div>

      <ManagePane {...props} currentLoopName={currentLoopName} />
    </section>
  );
}

function HelpWorkspaceView() {
  const guides = [
    {
      title: "任务循环是什么",
      body: "任务循环会把一个 Codex 线程变成可持续推进的开发任务：等待 Codex 完成当前轮，再结合项目规则、本地模型和你的补充生成下一条指令。",
    },
    {
      title: "如何创建任务",
      body: "进入创建页，按提示填写项目、目标、工作区和绑定线程。填错时可以返回上一步，也可以从头重写。",
    },
    {
      title: "如何绑定线程",
      body: "在目标 Codex 窗口询问 threadId，把返回的编号保存到任务里。绑定后，首页会显示当前任务和已绑定线程。",
    },
    {
      title: "如何开启本地模型增强",
      body: "进入设置，打开 Ollama 接入并选择模型。开启后，所有任务默认会把 Codex 回复交给本地模型整理，再生成下一轮指令。",
    },
    {
      title: "如何安全停止与关闭服务",
      body: "停止会先让当前轮收尾，不再发送新指令。关闭控制台会结束本地服务；如果任务仍在运行，系统会先提醒。",
    },
    {
      title: "遇到异常时先看哪里",
      body: "先看首页状态和对话记录底部：那里会显示最新 Codex 回复、codex-loop 发出的指令，以及等待合并的用户补充。",
    },
  ];

  return (
    <section className="workspace-focus">
      <div className="workspace-focus-head">
        <span className="workspace-focus-eyebrow">帮助</span>
        <h1>使用 codex-loop</h1>
        <p>这里保留上手说明，首页只显示当前任务、状态、对话记录和常用操作。</p>
      </div>

      <div className="help-guide-list">
        {guides.map((guide) => (
          <article className="help-guide-item" key={guide.title}>
            <strong>{guide.title}</strong>
            <p>{guide.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function DashboardHome({
  currentLoop,
  snapshot,
  modeText,
  continuationStatus,
  controllerStatus,
  launcherPhase,
  pollStatus,
  pollState,
  submitting,
  handleDashboardAction,
  setActiveSidebarPane,
  setActiveManageSection,
  onRequestShutdown,
  threadLabel,
  heroThreadLabel,
  latestSummary,
  transcriptEntries,
  latestPrompt,
  mobileView,
  processStatus,
  productionStatus,
  productionPreflight,
  settingsForm,
  healthIssues,
  uiError,
  guidanceStatusMessage,
  pendingGuidanceText,
  setPendingGuidanceText,
  pendingGuidanceEditMode,
  setPendingGuidanceEditMode,
  onSavePendingGuidance,
  onClearPendingGuidance,
  onSendPendingGuidance,
  remoteAccessStatus,
  launcherWebUrl,
  devicePairingSession,
  devicePairingLoading,
  devicePairingError,
  onCreateDevicePairingSession,
  onRevokePairedDevice,
}) {
  const projectTitle = formatValue(
    currentLoop?.projectName || snapshot?.config?.projectName,
    "当前项目",
  );
  const loopTitle = formatValue(
    currentLoop?.name || snapshot?.config?.loopName,
    "当前任务",
  );
  const codexConversation = snapshot?.codexConversation || {};
  const latestCodexUser = codexConversation.latestUser || null;
  const latestCodexAssistant = codexConversation.latestAssistant || null;
  const sharedConversationItems = mobileView?.conversationItems || [];
  const codexConversationEntries = sharedConversationItems.length
    ? sharedConversationItems
    : [...(codexConversation.entries || []).slice(0, 10)].reverse();
  const visibleTranscriptEntries = transcriptEntries.filter(isUsefulTranscriptEntry).slice(0, 4);
  const isDispatching = snapshot?.thread?.continuationStatus === "dispatching";
  const isReviewing = snapshot?.thread?.continuationStatus === "reviewing";
  const isFinalizing = snapshot?.state?.stopRequested || snapshot?.state?.finalizeRequested;
  const isRunning = snapshot?.state?.mode === "running";
  const healthSummary = healthIssues.length ? healthIssues.join("\n") : "当前没有明显异常。";
  const modelStatus = settingsForm.promptGeneratorEnabled === "auto"
    ? "自动接入 Ollama · " + settingsForm.promptGeneratorModel
    : settingsForm.promptGeneratorEnabled
      ? "已开启 · " + settingsForm.promptGeneratorModel
      : "未开启";
  const runningHeadline = processStatus?.headline || (isFinalizing
    ? "正在收尾"
    : isDispatching
      ? "已发送，等待 Codex 完成"
      : isReviewing
        ? "监督复盘中"
        : isRunning
        ? "循环运行中"
        : snapshot?.thread?.threadId
          ? "手动监控中"
          : "等待启动");
  const runningDescription = processStatus?.detail || (isFinalizing
    ? "不会再发送新指令，等待当前轮结束后停止。"
    : isDispatching
      ? "Codex 正在处理当前轮，完成前不会继续追发。"
      : isReviewing
        ? "本地模型正在监督复盘，完成前不发送下一条。"
        : isRunning
        ? "系统会等待 Codex 完整完成一轮，再决定是否继续。"
        : snapshot?.thread?.threadId
          ? "当前不会自动续跑；你可以先查看记录，或手动发送一条补充引导。"
          : "还没有绑定目标线程；先完成绑定，再决定是否开始循环。");
  const thinkingStateClass = isFinalizing
    ? "is-finalizing"
    : isDispatching || isReviewing || isRunning
      ? "is-active"
      : "is-idle";
  const codexWorkStatus = isFinalizing
    ? "正在收尾，当前轮结束后停止"
    : isDispatching
      ? "Codex 正在处理，暂不发送下一条"
      : isReviewing
        ? "本地模型正在监督复盘，完成前不发送下一条"
        : isRunning
        ? "等待下一轮循环指令"
        : snapshot?.thread?.threadId
          ? "当前仅手动监控，不会自动发送"
          : "尚未绑定线程";
  const latestVisibleSummary = summarizeVisibleText(
    snapshot?.thread?.latestCodexSummary || latestSummary,
    "等待第一轮可见进展",
  );
  const statusLine = `${runningHeadline} · ${heroThreadLabel}`;
  const savedPendingGuidance = snapshot?.thread?.pendingUserGuidance || "";
  const runtimeEvents = snapshot?.runtimeEvents || [];
  const canStartAutomaticLoop = Boolean(snapshot?.thread?.threadId) && !isRunning && !isDispatching && !isReviewing && !isFinalizing;
  async function handleEditPendingGuidance(text) {
    setPendingGuidanceText(formatValue(text, ""));
    setPendingGuidanceEditMode(true);
  }

  return (
    <>
      <section className="workspace-hero">
        <div className="workspace-hero-copy">
          <span className="workspace-hero-project">{projectTitle}</span>
          <h1>{loopTitle}</h1>
          <div className="workspace-status-row">
            <StatusPill
              text={processStatus?.monitorLabel || modeText}
              tone={processStatus?.monitorTone || "soft"}
              active={processStatus?.monitorTone === "active"}
            />
            <StatusPill
              text={processStatus?.headline || continuationStatus}
              tone={snapshot?.thread?.continuationStatus === "error" ? "danger" : "soft"}
              active={isDispatching || isReviewing}
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
                disabled={submitting || !canStartAutomaticLoop}
                title={canStartAutomaticLoop ? "开始自动循环" : "请先绑定线程，或等待当前状态结束后再启动自动循环"}
                onClick={() => void handleDashboardAction("start-loop")}
              >
                {isRunning || isDispatching || isReviewing || isFinalizing ? "循环处理中" : "开始自动循环"}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={submitting}
                onClick={() => void handleDashboardAction("stop-loop")}
              >
                停止
              </button>
            </div>
            <details className="workspace-more-actions">
              <summary>更多操作</summary>
              <div className="workspace-more-action-list">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={submitting}
                  onClick={() => void handleDashboardAction("open-create")}
                >
                  新建任务
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
            </details>
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
          <MobileAccessFold
            remoteAccessStatus={remoteAccessStatus}
            launcherWebUrl={launcherWebUrl}
            pairingSession={devicePairingSession}
            pairingLoading={devicePairingLoading}
            pairingError={devicePairingError}
            onCreatePairingSession={onCreateDevicePairingSession}
            onRevokePairedDevice={onRevokePairedDevice}
          />
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
              pendingGuidance={savedPendingGuidance}
              pendingGuidanceAt={snapshot?.thread?.pendingUserGuidanceAt}
              pendingGuidanceText={pendingGuidanceText}
              setPendingGuidanceText={setPendingGuidanceText}
              pendingGuidanceEditMode={pendingGuidanceEditMode}
              submitting={submitting}
              onSavePendingGuidance={onSavePendingGuidance}
              onCancelPendingGuidanceEdit={() => {
                setPendingGuidanceText("");
                setPendingGuidanceEditMode(false);
              }}
              onClearPendingGuidance={onClearPendingGuidance}
              onEditPendingGuidance={handleEditPendingGuidance}
              onSendPendingGuidance={onSendPendingGuidance}
              guidanceStatusMessage={guidanceStatusMessage}
              fallbackEntries={visibleTranscriptEntries}
            />
          </Section>
        </div>

        <aside className="workspace-secondary">
          <Section title="状态" desc={latestVisibleSummary}>
            <StatusSummaryPanelV2
              modeText={modeText}
              continuationStatus={continuationStatus}
              controllerStatus={controllerStatus}
              codexWorkStatus={codexWorkStatus}
              processStatus={processStatus}
              productionStatus={productionStatus}
              productionPreflight={productionPreflight}
              currentLoopName={loopTitle}
              threadLabel={threadLabel}
              modelStatus={modelStatus}
              pollStatus={pollStatus}
              healthSummary={healthSummary}
              runtimeEvents={runtimeEvents}
            />
          </Section>
        </aside>
      </div>
    </>
  );
}
function DesktopConsoleApp() {
  const [snapshot, setSnapshot] = useState(null);
  const [mobileView, setMobileView] = useState(null);
  const [launcherStatus, setLauncherStatus] = useState(null);
  const [remoteAccessStatus, setRemoteAccessStatus] = useState(null);
  const [devicePairingSession, setDevicePairingSession] = useState(null);
  const [devicePairingLoading, setDevicePairingLoading] = useState(false);
  const [devicePairingError, setDevicePairingError] = useState("");
  const [automationStatus, setAutomationStatus] = useState(null);
  const [controllerStatus, setControllerStatus] = useState(null);
  const [productionStatus, setProductionStatus] = useState(null);
  const [productionPreflight, setProductionPreflight] = useState(null);
  const [ollamaModels, setOllamaModels] = useState([]);
  const [assistantState, setAssistantState] = useState(null);
  const [assistantAnswer, setAssistantAnswer] = useState("");
  const [projectForm, setProjectForm] = useState({ projectName: "", workspaceRoot: "" });
  const [loopRegistry, setLoopRegistry] = useState({ currentLoopId: "", projects: [], loops: [] });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uiError, setUiError] = useState("");
  const [guidanceStatusMessage, setGuidanceStatusMessage] = useState("");
  const [pendingGuidanceText, setPendingGuidanceText] = useState("");
  const [pendingGuidanceEditMode, setPendingGuidanceEditMode] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const [sidebarOpen, setSidebarOpen] = useState(getInitialSidebarOpen);
  const [activeSidebarPane, setActiveSidebarPane] = useState("loops");
  const [creationMode, setCreationMode] = useState("task");
  const [activeManageSection, setActiveManageSection] = useState("automation");
  const [selectedLoopId, setSelectedLoopId] = useState("");
  const [loopMenuOpenId, setLoopMenuOpenId] = useState("");
  const [projectCreationDraft, setProjectCreationDraft] = useState(null);
  const activeSidebarPaneRef = useRef(activeSidebarPane);
  const creationModeRef = useRef(creationMode);
  const [threadForm, setThreadForm] = useState({
    workspaceName: "",
    threadTitle: "",
    workspaceRoot: "",
    windowTitle: "",
    threadId: "",
    note: "",
    singleThreadMode: true,
  });
  const [settingsForm, setSettingsForm] = useState({
    conversationLanguage: "zh-CN",
    intervalMinutes: "10",
    promptGeneratorEnabled: "auto",
    promptGeneratorModel: "qwen2.5:7b",
    promptGeneratorBaseUrl: "http://127.0.0.1:11434",
    supervisorRoleTraits: DEFAULT_SUPERVISOR_FORM.roleTraits,
    supervisorTestingRules: DEFAULT_SUPERVISOR_FORM.testingRules,
    supervisorAcceptanceCriteria: DEFAULT_SUPERVISOR_FORM.acceptanceCriteria,
    maxMinutes: "180",
    maxTokens: "120000",
    finalizeLeadMinutes: "20",
    finalizeLeadTokens: "15000",
  });
  const [loopSupervisorForm, setLoopSupervisorForm] = useState({
    roleTraits: "",
    testingRules: "",
    acceptanceCriteria: "",
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
        nextSnapshot,
        nextLoops,
      ] = await Promise.all([
        requestJson("/snapshot"),
        requestJson("/loops"),
      ]);

      const [
        nextAutomationStatus,
        nextMobile,
        nextLauncherStatus,
        nextRemoteAccessStatus,
        nextControllerStatus,
        nextProductionStatus,
        nextProductionPreflight,
        nextOllamaModels,
        nextAssistantState,
      ] = await Promise.all([
        requestJson("/automation").catch(() => automationStatus || { connected: false }),
        requestJson("/mobile").catch(() => mobileView || { processStatus: null, transcriptEntries: [] }),
        requestJson("/launcher-status").catch(() => launcherStatus || { phase: "idle" }),
        requestJson("/remote-access").catch(() => remoteAccessStatus || {}),
        requestJson("/controller-status").catch(
          () =>
            controllerStatus || {
              running: false,
              label: "未运行",
              detail: "自动循环状态暂不可用。",
            },
        ),
        requestJson("/production-status").catch(() => productionStatus || null),
        requestJson("/production-preflight").catch(() => productionPreflight || null),
        requestJson("/ollama/models").catch(() => ({ models: [] })),
        requestJson("/loop-creation-assistant").catch(() => assistantState || null),
      ]);

      setAutomationStatus(nextAutomationStatus);
      setSnapshot(nextSnapshot);
      setLoopRegistry(nextLoops);
      setMobileView(nextMobile);
      setLauncherStatus(nextLauncherStatus);
      setRemoteAccessStatus(nextRemoteAccessStatus);
      setControllerStatus(nextControllerStatus);
      setProductionStatus(nextProductionStatus);
      setProductionPreflight(nextProductionPreflight);
      setOllamaModels(nextOllamaModels.models || []);
      if (
        !(
          activeSidebarPaneRef.current === "create" &&
          creationModeRef.current === "task" &&
          nextAssistantState?.status === "completed"
        )
      ) {
        setAssistantState(nextAssistantState);
      }
      setSelectedLoopId((current) => {
        const selected = pickVisibleLoop(nextLoops.loops || [], current || nextLoops.currentLoopId);
        return selected?.id || nextLoops.currentLoopId || "";
      });
      setThreadForm({
        workspaceName: nextSnapshot.thread.workspaceName || "",
        threadTitle: nextSnapshot.thread.threadTitle || "",
        workspaceRoot:
          nextSnapshot.thread.workspaceRoot ||
          nextSnapshot.loop?.workspaceRoot ||
          nextSnapshot.paths?.workspaceRoot ||
          "",
        windowTitle:
          nextSnapshot.thread.windowTitle ||
          nextSnapshot.thread.threadTitle ||
          "",
        threadId: nextSnapshot.thread.threadId || "",
        note: nextSnapshot.thread.note || "",
        singleThreadMode: Boolean(nextSnapshot.thread.singleThreadMode),
      });
      const loopSupervisor = nextSnapshot.loop?.supervisor || {};
      const loopHasSupervisor = Boolean(
        loopSupervisor.roleTraits ||
          loopSupervisor.testingRules ||
          loopSupervisor.acceptanceCriteria,
      );
      const resolvedConversation = nextSnapshot.profile?.resolved?.conversation || {};
      const overrideConversation = nextSnapshot.profile?.overrides?.conversation || {};
      const globalSupervisor =
        overrideConversation.supervisor ||
        (!loopHasSupervisor
          ? resolvedConversation.supervisor || DEFAULT_SUPERVISOR_FORM
          : DEFAULT_SUPERVISOR_FORM);
      setSettingsForm({
        conversationLanguage:
          resolvedConversation.language || "zh-CN",
        intervalMinutes: String(nextAutomationStatus?.intervalMinutes || 10),
        promptGeneratorEnabled:
          resolvedConversation.promptGenerator?.enabled === "auto"
            ? "auto"
            : Boolean(resolvedConversation.promptGenerator?.enabled),
        promptGeneratorModel:
          resolvedConversation.promptGenerator?.model || "qwen2.5:7b",
        promptGeneratorBaseUrl:
          resolvedConversation.promptGenerator?.baseUrl || "http://127.0.0.1:11434",
        supervisorRoleTraits: globalSupervisor.roleTraits || "",
        supervisorTestingRules: globalSupervisor.testingRules || "",
        supervisorAcceptanceCriteria: globalSupervisor.acceptanceCriteria || "",
        maxMinutes: String(nextSnapshot.state?.budgets?.maxMinutes ?? 180),
        maxTokens: String(nextSnapshot.state?.budgets?.maxTokens ?? 120000),
        finalizeLeadMinutes: String(nextSnapshot.state?.budgets?.finalizeLeadMinutes ?? 20),
        finalizeLeadTokens: String(nextSnapshot.state?.budgets?.finalizeLeadTokens ?? 15000),
      });
      setLoopSupervisorForm({
        roleTraits: loopSupervisor.roleTraits || "",
        testingRules: loopSupervisor.testingRules || "",
        acceptanceCriteria: loopSupervisor.acceptanceCriteria || "",
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
    activeSidebarPaneRef.current = activeSidebarPane;
  }, [activeSidebarPane]);

  useEffect(() => {
    creationModeRef.current = creationMode;
  }, [creationMode]);

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

  async function savePendingGuidance(text) {
    const cleanText = formatValue(text, "").trim();
    if (!cleanText) {
      return;
    }

    await withSubmit(async () => {
      const result = await requestJson("/pending-guidance", {
        method: "POST",
        body: JSON.stringify({
          text: cleanText,
          replace: pendingGuidanceEditMode,
        }),
      });
      applyPendingGuidanceFeedback(
        result,
        pendingGuidanceEditMode
          ? "已更新下一轮补充。"
          : "已记录下一轮补充，会在安全时机合并。",
        setGuidanceStatusMessage,
      );
      setPendingGuidanceText("");
      setPendingGuidanceEditMode(false);
    });
  }

  async function clearPendingGuidance() {
    await withSubmit(async () => {
      const result = await requestJson("/pending-guidance", {
        method: "DELETE",
      });
      applyPendingGuidanceFeedback(result, "已撤回待合并引导。", setGuidanceStatusMessage);
      setPendingGuidanceText("");
      setPendingGuidanceEditMode(false);
    });
  }

  async function sendPendingGuidance() {
    await withSubmit(async () => {
      const result = await requestJson("/send-guidance", {
        method: "POST",
      });
      applyPendingGuidanceFeedback(
        result,
        "已发出下一轮补充，正在等待 Codex 完成当前任务。",
        setGuidanceStatusMessage,
      );
      setPendingGuidanceText("");
      setPendingGuidanceEditMode(false);
    });
  }

  async function createDevicePairingSession() {
    const mobileBaseUrl =
      remoteAccessStatus?.mobileAppUrl ||
      remoteAccessStatus?.primaryMobileUrl ||
      remoteAccessStatus?.mobileUrlHint ||
      remoteAccessStatus?.url ||
      remoteAccessStatus?.publicBaseUrl ||
      "";
    setDevicePairingLoading(true);
    setDevicePairingError("");

    try {
      const nextSession = await requestJson("/device-pairing/session", {
        method: "POST",
        body: JSON.stringify({ mobileBaseUrl }),
      });
      setDevicePairingSession(nextSession);
    } catch (error) {
      setDevicePairingError(error?.message || "生成扫码绑定失败，请稍后重试。");
    } finally {
      setDevicePairingLoading(false);
    }
  }

  async function revokePairedDevice(device) {
    const deviceName = device?.name || "这台手机";
    const confirmed = window.confirm(
      `确认撤销 ${deviceName} 的长期绑定吗？撤销后这台手机需要重新扫码才能访问。`,
    );
    if (!confirmed) {
      return;
    }

    setDevicePairingError("");
    await withSubmit(async () => {
      await requestJson("/device-pairing/device", {
        method: "DELETE",
        body: JSON.stringify({
          deviceId: device?.id,
          reason: "用户在控制台撤销绑定",
        }),
      });
      setDevicePairingSession(null);
    });
  }

  async function createProjectFromForm(event) {
    event.preventDefault();
    const projectName = formatValue(projectForm.projectName, "").trim();
    const workspaceRoot = formatValue(projectForm.workspaceRoot, "").trim();
    if (!projectName) {
      return;
    }

    await withSubmit(async () => {
      await requestJson("/projects", {
        method: "POST",
        body: JSON.stringify({
          projectName,
          workspaceRoot,
        }),
      });
      setProjectForm({ projectName: "", workspaceRoot: "" });
      setActiveSidebarPane("loops");
    });
  }

  const loopGroups = useMemo(
    () => groupLoopsByProject(filterVisibleLoops(loopRegistry.loops || []), loopRegistry.projects || []),
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
  const processStatus = mobileView?.processStatus || null;
  const strategy = mobileView?.strategy || {
    contextCard: {},
    rhythmCard: {},
    guardrailCard: {},
  };
  const healthIssues = (snapshot?.health?.issues || []).map(translateHealthIssue);
  const bindingNote = mobileView?.bindingNote || "尚未生成";
  const suggestedAction = mobileView?.suggestedAction || "等待下一步";
  const launcherPhase = resolveLauncherPhaseText(launcherStatus, snapshot, pollState);
  const automationSchedule = automationStatus?.connected
    ? `${automationStatus.intervalMinutes} 分钟`
    : "未连接";
  const conversationLanguage = settingsForm.conversationLanguage === "en" ? "英文" : "中文优先";
  const promptGeneratorStatus = settingsForm.promptGeneratorEnabled === "auto"
    ? `自动接入 Ollama · ${settingsForm.promptGeneratorModel}`
    : settingsForm.promptGeneratorEnabled
      ? `已启用 · ${settingsForm.promptGeneratorModel}`
      : "已关闭本地模型";
  const remoteTransport = remoteAccessStatus?.recommendedTransport || "tailscale";
  const launcherWebUrl = launcherStatus?.webUrl || launcherStatus?.webBaseUrl || "未提供";
  const latestProgress = formatValue(
    processStatus?.realtimeRecentActionLabel ||
      processStatus?.realtimePhaseLabel ||
      processStatus?.headline ||
      mobileView?.summary?.recentSummary,
    "暂无",
  );
  const pollStatus = pollState.syncing
    ? "同步中"
    : pollState.failedCount > 0
      ? `重试 ${pollState.failedCount}`
      : pollState.lastSuccessAt
        ? `更新于 ${formatTime(pollState.lastSuccessAt)}`
        : "等待首次同步";
  const threadTitle =
    snapshot?.thread?.threadTitle || snapshot?.thread?.workspaceName || "尚未绑定可见窗口";
  const boundThreadId = snapshot?.thread?.threadId || "";
  const threadLabel = boundThreadId
    ? `${threadTitle}（${boundThreadId}）`
    : threadTitle;
  const heroThreadLabel = boundThreadId
    ? `${threadTitle}（${shortThreadId(boundThreadId)}）`
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
  const showingCreationPane = activeSidebarPane === "create";

  async function openCreatePane(nextCreationMode = "task") {
    setCreationMode(nextCreationMode);
    setActiveSidebarPane("create");
    setLoopMenuOpenId("");

    if (nextCreationMode === "project") {
      setProjectCreationDraft(null);
    }

    if (nextCreationMode === "task") {
      setAssistantState(null);
      void withSubmit(async () => {
        const nextAssistantState = await requestJson("/loop-creation-assistant/reset", {
          method: "POST",
          body: JSON.stringify({}),
        });
        setAssistantState(nextAssistantState);
        setAssistantAnswer("");
      });
    }
  }

  async function openTaskCreationForProject(project = {}) {
    const projectName = formatValue(project.name || project.projectName, "").trim();
    const workspaceRoot = formatValue(project.workspaceRoot, "").trim();

    setProjectCreationDraft({
      projectName,
      workspaceRoot,
    });
    setAssistantState(null);
    setAssistantAnswer("");
    setCreationMode("task");
    setActiveSidebarPane("create");
    setLoopMenuOpenId("");

    await withSubmit(async () => {
      const nextAssistantState = await requestJson("/loop-creation-assistant/reset", {
        method: "POST",
        body: JSON.stringify({
          projectName,
          workspaceRoot,
        }),
      });
      setAssistantState(nextAssistantState);
    });
  }

  async function deleteProjectFromSidebar(project = {}) {
    const projectName = formatValue(project.name || project.projectName, "").trim();
    if (!projectName) {
      return;
    }
    const confirmed = window.confirm(`确认删除空项目「${projectName}」吗？删除后不会保留这个项目分组。`);
    if (!confirmed) {
      return;
    }

    await withSubmit(async () => {
      await requestJson("/projects/delete", {
        method: "POST",
        body: JSON.stringify({ projectName }),
      });
      setLoopMenuOpenId("");
    });
  }

  async function switchLoop(loopId) {
    if (!loopId) {
      return;
    }
    setSelectedLoopId(loopId);
    setActiveSidebarPane("loops");
    setLoopMenuOpenId("");
    await requestJson("/loops/select", {
      method: "POST",
      body: JSON.stringify({ loopId }),
    });
  }

  async function deleteLoopFromSidebar(loop = {}) {
    const loopId = formatValue(loop.id, "").trim();
    const loopName = formatValue(loop.name || loop.loopName, "当前任务");
    if (!loopId) {
      return;
    }

    const alternativeLoop = visibleLoops.find((item) => item.id !== loopId);
    if (!alternativeLoop) {
      throw new Error("当前只剩这一个任务，请先新建一个任务后再删除。");
    }

    const confirmed = window.confirm(`确认删除任务「${loopName}」吗？删除后不会保留这个任务的绑定和循环记录。`);
    if (!confirmed) {
      return;
    }

    await withSubmit(async () => {
      if (loopId === (currentLoop?.id || loopRegistry.currentLoopId)) {
        await switchLoop(alternativeLoop.id);
      }
      await requestJson("/loops/delete", {
        method: "POST",
        body: JSON.stringify({ loopId }),
      });
      setLoopMenuOpenId("");
      setActiveSidebarPane("loops");
    });
  }

  async function handleDashboardAction(actionId) {
    if (actionId === "open-manage") {
      setActiveSidebarPane("manage");
      return;
    }

    if (actionId === "open-create") {
      await openCreatePane("task");
      return;
    }

    if (actionId === "start-loop") {
      await withSubmit(async () => {
        const preflight = await requestJson("/production-preflight");
        setProductionPreflight(preflight);
        if (!preflight.canDispatch) {
          throw new Error(preflight.nextAction || preflight.summary || "暂不建议启动真实循环。");
        }
        await requestJson("/start", { method: "POST" });
      });
      return;
    }

    if (actionId === "stop-loop") {
      await withSubmit(async () => {
        await requestJson("/stop", {
          method: "POST",
          body: JSON.stringify({
            reason: "用户在控制台点击停止",
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
          {sidebarOpen ? <strong>codex-loop</strong> : <strong className="mobile-only-label">codex-loop</strong>}
        </div>

        {sidebarOpen ? (
          <>
            <div className="sidebar-action-grid">
              <button
                type="button"
                aria-label="新建项目"
                className={`sidebar-action-button ${
                  activeSidebarPane === "create" && creationMode === "project" ? "is-active" : ""
                }`}
                onClick={() => void openCreatePane("project")}
              >
                <span className="sidebar-action-icon" aria-hidden="true">＋</span>
                <span>创建项目</span>
              </button>
              <button
                type="button"
                aria-label="新建任务"
                className={`sidebar-action-button ${
                  activeSidebarPane === "create" && creationMode === "task" ? "is-active" : ""
                }`}
                onClick={() => void openCreatePane("task")}
              >
                <span className="sidebar-action-icon" aria-hidden="true">＋</span>
                <span>创建任务</span>
              </button>
            </div>

            {!showingCreationPane ? (
              <div className="sidebar-projects" aria-label="项目任务导航">
                <div className="sidebar-projects-head">
                  <span>项目与任务</span>
                  <span>{visibleLoops.length} 个任务</span>
                </div>
                <div className="sidebar-loop-groups">
                  {loopGroups.map((project) => {
                    const projectName = project.name;
                    const loops = project.loops || [];
                    const collapsed = collapsedProjects[projectName];
                    const projectMenuId = buildProjectMenuId(projectName);
                    return (
                      <div key={projectName} className="sidebar-group">
                        <div
                          className="sidebar-project-row"
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setLoopMenuOpenId((current) => (current === projectMenuId ? "" : projectMenuId));
                          }}
                        >
                          <button
                            type="button"
                            className="sidebar-group-toggle"
                            aria-expanded={!collapsed}
                            onClick={() =>
                              setCollapsedProjects((current) => ({
                                ...current,
                                [projectName]: !current[projectName],
                              }))
                            }
                            onContextMenu={(event) => {
                              event.preventDefault();
                              setLoopMenuOpenId((current) => (current === projectMenuId ? "" : projectMenuId));
                            }}
                          >
                            <span className="sidebar-project-title">{projectName}</span>
                            <span className="sidebar-project-chevron" aria-hidden="true">
                              {collapsed ? "+" : "-"}
                            </span>
                          </button>
                          <div className="sidebar-project-tools">
                            <button
                              type="button"
                              className="loop-tool-button"
                              aria-label={`管理项目 ${projectName}`}
                              title="更多"
                              onClick={() =>
                                setLoopMenuOpenId((current) => (current === projectMenuId ? "" : projectMenuId))
                              }
                            >
                              <span aria-hidden="true">...</span>
                            </button>
                            {loopMenuOpenId === projectMenuId ? (
                              <div className="loop-context-menu">
                                <button
                                  type="button"
                                  onClick={() => void openTaskCreationForProject(project)}
                                >
                                  在这个项目下新建任务
                                </button>
                                {project.isEmpty ? (
                                  <button
                                    type="button"
                                    onClick={() => void deleteProjectFromSidebar(project)}
                                  >
                                    删除这个项目
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>

                        {!collapsed ? (
                          <div className="sidebar-loop-list">
                            {project.isEmpty ? (
                              <div className="sidebar-empty-project">还没有任务</div>
                            ) : null}
                            {loops.map((loop) => {
                              const isActive = loop.id === (currentLoop?.id || loopRegistry.currentLoopId);
                              return (
                                <div key={loop.id} className={`sidebar-loop-item ${isActive ? "is-active" : ""}`}>
                                  <button
                                    type="button"
                                    className="sidebar-loop-main"
                                    onClick={() => withSubmit(async () => {
                                      await switchLoop(loop.id);
                                    })}
                                  >
                                    <span className="sidebar-loop-name">{loop.name}</span>
                                  </button>

                                  <div className="sidebar-loop-tools">
                                    <button
                                      type="button"
                                      className="loop-tool-button"
                                      aria-label={`管理任务 ${loop.name}`}
                                      title="更多"
                                      onClick={() =>
                                        setLoopMenuOpenId((current) => (current === loop.id ? "" : loop.id))
                                      }
                                    >
                                      <span aria-hidden="true">...</span>
                                    </button>
                                    {loopMenuOpenId === loop.id ? (
                                      <div className="loop-context-menu">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setActiveManageSection("thread");
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
                                          onClick={() => void deleteLoopFromSidebar(loop)}
                                        >
                                          删除这个任务
                                        </button>
                                        ) : (
                                          <button
                                            type="button"
                                            disabled
                                            title="当前正在查看的任务不能直接删除，请先切换到别的任务。"
                                          >
                                            当前任务暂不能删除
                                          </button>
                                        )}
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
            ) : (
              <div className="sidebar-create-focus">
                <strong>{creationMode === "project" ? "正在新建项目" : "正在新建任务"}</strong>
                <p>这里不会展示已经创建的任务。创建完成后再回到项目列表查看。</p>
              </div>
            )}

            <div className="sidebar-footer">
              <button
                type="button"
                className={`sidebar-footer-button ${activeSidebarPane === "help" ? "is-active" : ""}`}
                onClick={() => {
                  setActiveSidebarPane("help");
                  setLoopMenuOpenId("");
                }}
              >
                <span className="sidebar-footer-icon" aria-hidden="true">?</span>
                <span>帮助</span>
              </button>
              <button
                type="button"
                className={`sidebar-footer-button ${activeSidebarPane === "manage" ? "is-active" : ""}`}
                onClick={() => {
                  setActiveManageSection("ollama");
                  setActiveSidebarPane("manage");
                  setLoopMenuOpenId("");
                }}
              >
                <span className="sidebar-footer-icon" aria-hidden="true">⚙</span>
                <span>设置</span>
              </button>
            </div>
          </>
        ) : (
          <div className="sidebar-collapsed-list">
            <button
              type="button"
              aria-label="新建项目"
              className={`collapsed-loop-pill ${
                activeSidebarPane === "create" && creationMode === "project" ? "is-active" : ""
              }`}
              onClick={() => void openCreatePane("project")}
              title="新建项目"
            >
              <span>项目</span>
              <span className="mobile-only-label">新建项目</span>
            </button>
            <button
              type="button"
              aria-label="新建任务"
              className={`collapsed-loop-pill ${
                activeSidebarPane === "create" && creationMode === "task" ? "is-active" : ""
              }`}
              onClick={() => void openCreatePane("task")}
              title="新建任务"
            >
              <span>新建</span>
              <span className="mobile-only-label">新建任务</span>
            </button>
            {!showingCreationPane ? (
              <>
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
                    title={loop.name}
                  >
                    <span>{loop.name.slice(0, 2)}</span>
                    <span className="mobile-only-label">{loop.name}</span>
                  </button>
                ))}
              </>
            ) : null}
            <button
              type="button"
              className={`collapsed-loop-pill ${activeSidebarPane === "help" ? "is-active" : ""}`}
              onClick={() => setActiveSidebarPane("help")}
              title="帮助"
            >
              <span>帮</span>
              <span className="mobile-only-label">帮助</span>
            </button>
            <button
              type="button"
              className={`collapsed-loop-pill ${activeSidebarPane === "manage" ? "is-active" : ""}`}
              onClick={() => {
                setActiveManageSection("ollama");
                setActiveSidebarPane("manage");
              }}
              title="设置"
            >
              <span>⚙</span>
              <span className="mobile-only-label">设置</span>
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
            projectForm={projectForm}
            setProjectForm={setProjectForm}
            onCreateProject={createProjectFromForm}
            onSubmit={() =>
              withSubmit(async () => {
                const nextAssistantState = await requestJson("/loop-creation-assistant/reply", {
                  method: "POST",
                  body: JSON.stringify({ answer: assistantAnswer }),
                });
                setAssistantState(nextAssistantState);
                setAssistantAnswer("");
                if (nextAssistantState?.status === "completed") {
                  setActiveSidebarPane("loops");
                  setLoopMenuOpenId("");
                }
              })
            }
            onBack={() =>
              withSubmit(async () => {
                const nextAssistantState = await requestJson("/loop-creation-assistant/back", {
                  method: "POST",
                });
                setAssistantState(nextAssistantState);
                setAssistantAnswer("");
              })
            }
            onReset={() =>
              withSubmit(async () => {
                const nextAssistantState = await requestJson("/loop-creation-assistant/reset", {
                  method: "POST",
                  body: JSON.stringify({}),
                });
                setAssistantState(nextAssistantState);
                setAssistantAnswer("");
                setProjectCreationDraft(null);
              })
            }
            creationMode={creationMode}
            projectCreationDraft={projectCreationDraft}
          />
        ) : null}

        {activeSidebarPane === "help" ? <HelpWorkspaceView /> : null}

        {activeSidebarPane === "manage" ? (
          <ManageWorkspaceView
            threadForm={threadForm}
            setThreadForm={setThreadForm}
            settingsForm={settingsForm}
            setSettingsForm={setSettingsForm}
            loopSupervisorForm={loopSupervisorForm}
            setLoopSupervisorForm={setLoopSupervisorForm}
            automationStatus={automationStatus}
            launcherPhase={launcherPhase}
            launcherWebUrl={launcherWebUrl}
            remoteAccessStatus={remoteAccessStatus}
            remoteTransport={remoteTransport}
            ollamaModels={ollamaModels}
            promptGeneratorStatus={promptGeneratorStatus}
            conversationLanguage={conversationLanguage}
            healthIssues={healthIssues}
            latestProgress={latestProgress}
            snapshot={snapshot}
            submitting={submitting}
            withSubmit={withSubmit}
            activeManageSection={activeManageSection}
            setActiveManageSection={setActiveManageSection}
            currentLoop={currentLoop}
            visibleLoops={visibleLoops}
            onDeleteLoop={deleteLoopFromSidebar}
          />
        ) : null}

        {activeSidebarPane === "loops" ? (
            <DashboardHome
              currentLoop={currentLoop}
              snapshot={snapshot}
              modeText={modeText}
              continuationStatus={continuationStatus}
              controllerStatus={controllerStatus}
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
            heroThreadLabel={heroThreadLabel}
            latestSummary={latestSummary}
            changeSummary={changeSummary}
            suggestedAction={suggestedAction}
            transcriptEntries={transcriptEntries}
            latestPrompt={latestPrompt}
            mobileView={mobileView}
            processStatus={processStatus}
            productionStatus={productionStatus}
            productionPreflight={productionPreflight}
            mobileSummary={mobileSummary}
            bindingNote={bindingNote}
            strategy={strategy}
            settingsForm={settingsForm}
            healthIssues={healthIssues}
            uiError={uiError}
            guidanceStatusMessage={guidanceStatusMessage}
            pendingGuidanceText={pendingGuidanceText}
            setPendingGuidanceText={setPendingGuidanceText}
            pendingGuidanceEditMode={pendingGuidanceEditMode}
            setPendingGuidanceEditMode={setPendingGuidanceEditMode}
            onSavePendingGuidance={savePendingGuidance}
            onClearPendingGuidance={clearPendingGuidance}
            onSendPendingGuidance={sendPendingGuidance}
            remoteAccessStatus={remoteAccessStatus}
            launcherWebUrl={launcherWebUrl}
            devicePairingSession={devicePairingSession}
            devicePairingLoading={devicePairingLoading}
            devicePairingError={devicePairingError}
            onCreateDevicePairingSession={createDevicePairingSession}
            onRevokePairedDevice={revokePairedDevice}
          />
        ) : null}

        
      </section>
    </main>
  );
}

export function App() {
  if (typeof window !== "undefined" && window.location.pathname === "/mobile") {
    return <MobileTaskApp />;
  }

  return <DesktopConsoleApp />;
}
