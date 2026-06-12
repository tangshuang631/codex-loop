import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import {
  buildProductionFocusSummary,
  buildModelPipelineSummary,
  buildStatusHeroSummary,
  buildLongRunDecision,
  getConversationActionLabel,
  getConversationDetailKindLabel,
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

const DEVICE_KEY = "codex-loop-mobile-device";
const MOBILE_SNAPSHOT_KEY = "codex-loop-mobile-snapshot";
const MOBILE_SNAPSHOT_VERSION = 1;
const MOBILE_SNAPSHOT_MAX_AGE_MS = 1000 * 60 * 30;
const FAST_POLL_MS = 3000;
const POLL_MS = 8000;
const DEGRADED_POLL_MS = 20000;
const REQUEST_TIMEOUT_MS = 8000;
const API_BASE = (import.meta.env.VITE_CODEX_LOOP_API_BASE || "/api").replace(/\/$/, "");

function apiUrl(path) {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

async function requestJson(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl(path), {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(data.error || data.message || "请求失败，请稍后重试。");
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("连接超时，请确认 codex-loop 服务仍在运行。");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function presentConnectionError(error) {
  const message = asText(error?.message || error, "同步失败，请稍后重试。");
  if (/设备未绑定|令牌|重新扫码/.test(message)) {
    return message;
  }
  if (/Failed to fetch|NetworkError|fetch/i.test(message)) {
    return "暂时连不上 codex-loop 服务，请确认电脑在线、服务已启动。";
  }
  return message;
}

function readDevice() {
  try {
    const raw = window.localStorage.getItem(DEVICE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDevice(device) {
  if (!device?.deviceId || !device?.deviceToken) {
    window.localStorage.removeItem(DEVICE_KEY);
    return;
  }
  window.localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
}

function readCachedSnapshot(deviceId = "") {
  try {
    const raw = window.localStorage.getItem(MOBILE_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.deviceId !== deviceId) return null;
    if (parsed.version !== MOBILE_SNAPSHOT_VERSION) return null;
    if (!parsed.mobile || !parsed.lastSuccessAt) return null;
    if (!parsed.snapshotSignature) return null;
    const cachedAt = Date.parse(parsed.lastSuccessAt);
    if (!Number.isFinite(cachedAt)) return null;
    if (Date.now() - cachedAt > MOBILE_SNAPSHOT_MAX_AGE_MS) {
      clearCachedSnapshot();
      return null;
    }
    const sanitizedMobile = sanitizeCachedMobileView(parsed.mobile);
    if (!sanitizedMobile) return null;
    parsed.mobile = sanitizedMobile;
    return parsed;
  } catch {
    return null;
  }
}

function saveCachedSnapshot(deviceId, snapshot) {
  if (!deviceId || !snapshot?.mobile) return;
  const snapshotSignature = buildMobileSnapshotSignature(snapshot.mobile);
  if (!snapshotSignature) return;
  window.localStorage.setItem(
    MOBILE_SNAPSHOT_KEY,
    JSON.stringify({
      version: MOBILE_SNAPSHOT_VERSION,
      deviceId,
      mobile: snapshot.mobile,
      productionStatus: snapshot.productionStatus || null,
      productionPreflight: snapshot.productionPreflight || null,
      lastSuccessAt: snapshot.lastSuccessAt || "",
      snapshotSignature,
    }),
  );
}

function clearCachedSnapshot() {
  window.localStorage.removeItem(MOBILE_SNAPSHOT_KEY);
}

function parsePairingText(value) {
  const text = String(value || "").trim();
  if (!text) return {};
  try {
    const url = new URL(text);
    return {
      sessionId: url.searchParams.get("sessionId") || "",
      pairingCode: url.searchParams.get("code") || "",
    };
  } catch {
    const sessionId = text.match(/sessionId\s*=\s*([^\s&]+)/i)?.[1] || "";
    const pairingCode = text.match(/(?:code|pairingCode)\s*=\s*([^\s&]+)/i)?.[1] || "";
    return { sessionId, pairingCode };
  }
}

function readPairingQuery() {
  try {
    const url = new URL(window.location.href);
    return {
      sessionId: url.searchParams.get("sessionId") || "",
      pairingCode: url.searchParams.get("code") || "",
    };
  } catch {
    return {};
  }
}

function clearPairingQueryFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("sessionId") && !url.searchParams.has("code")) {
      return;
    }
    url.searchParams.delete("sessionId");
    url.searchParams.delete("code");
    window.history.replaceState({}, document.title, url.toString());
  } catch {
    // 浏览器不支持时保持现状，不阻塞绑定主链。
  }
}

function canUseBarcodeDetector() {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

async function readBarcodeFromVideoFrame(video) {
  if (!video || !canUseBarcodeDetector()) {
    return "";
  }
  const detector = new window.BarcodeDetector({
    formats: ["qr_code"],
  });
  const codes = await detector.detect(video);
  return asText(codes?.[0]?.rawValue, "");
}

function formatTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function asText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function presentMonitorText(value, fallback = "") {
  const text = asText(value, fallback);
  if (!text) return "";
  return text
    .replace(/本地模型\s*\/\s*NPC/g, "本地模型监督流程")
    .replace(/NPC\s*\/\s*Ollama/g, "本地模型监督流程")
    .replace(/Ollama/g, "本地模型")
    .replace(/NPC/g, "监督流程");
}

function copyText(text) {
  const value = asText(text);
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

function compactText(value, length = 180) {
  const text = asText(value).replace(/\s+/g, " ");
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}…`;
}

function isNearViewportBottom(element, threshold = 160) {
  if (!element) return true;
  const rect = element.getBoundingClientRect();
  return rect.top - window.innerHeight <= threshold;
}

function parseComparableTime(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function getConversationTailAt(mobileView) {
  const items = buildConversationItemsFromMobileView(mobileView);
  const latestAt = items.reduce((max, item) => {
    const at = parseComparableTime(item?.at);
    return at > max ? at : max;
  }, 0);
  return latestAt ? new Date(latestAt).toISOString() : "";
}

function getConversationCount(mobileView) {
  return buildConversationItemsFromMobileView(mobileView).length;
}

function buildMobileSnapshotSignature(mobileView) {
  if (!mobileView || typeof mobileView !== "object") return "";
  const pendingAt = asText(mobileView?.pendingGuidance?.at);
  const mergedAt = asText(mobileView?.processStatus?.lastMergedGuidanceAt);
  const lastDispatchAt = asText(mobileView?.processStatus?.lastDispatchAt || mobileView?.thread?.lastDispatchAt);
  const conversationTailAt = getConversationTailAt(mobileView);
  const latestEventType = asText(mobileView?.processStatus?.latestEventType);
  return [pendingAt, mergedAt, lastDispatchAt, conversationTailAt, latestEventType].join("|");
}

function sanitizeCachedMobileView(mobileView) {
  if (!mobileView || typeof mobileView !== "object") return null;

  const pending = mobileView.pendingGuidance;
  if (!pending?.hasPending) {
    return mobileView;
  }

  const pendingAt = parseComparableTime(pending.at);
  const mergedAt = parseComparableTime(mobileView?.processStatus?.lastMergedGuidanceAt);
  const latestEventType = asText(mobileView?.processStatus?.latestEventType);
  const hasPendingGuidance = mobileView?.processStatus?.hasPendingGuidance;
  const shouldClearPending =
    !asText(pending.text) ||
    hasPendingGuidance === false ||
    latestEventType === "pending_guidance_cleared" ||
    (pendingAt > 0 && mergedAt > 0 && mergedAt >= pendingAt);

  if (!shouldClearPending) {
    return mobileView;
  }

  return {
    ...mobileView,
    pendingGuidance: {
      ...pending,
      text: "",
      preview: "",
      hasPending: false,
      status: "",
      statusLabel: "",
      statusDetail: "",
      userMessage: "",
      actionLabel: "",
    },
  };
}

function hasMeaningfulPendingGuidance(mobileView) {
  const pending = mobileView?.pendingGuidance || {};
  return pending.hasPending === true && Boolean(asText(pending.text || pending.preview));
}

function presentPendingGuidanceStatus(result, fallback = "已记录下一轮补充。") {
  const pending = result?.pendingGuidance;
  const primary = asText(result?.message);
  if (primary) {
    return primary;
  }
  if (!pending || typeof pending !== "object") {
    return fallback;
  }

  const statusLabel = asText(pending.statusLabel);
  const detail = asText(pending.userMessage) || asText(pending.statusDetail);

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

function buildLocalGuidanceConversationItem({
  text,
  pending,
  at = new Date().toISOString(),
}) {
  const value = asText(text);
  if (!value) return null;
  return {
    role: "guidance",
    at,
    text: value,
    preview: pending?.preview || compactText(value, 120),
  };
}

function mergeConversationItemsWithPending(mobileView, pending, fallbackText = "") {
  if (!mobileView || typeof mobileView !== "object") return mobileView;
  const currentItems = Array.isArray(mobileView.conversationItems) ? mobileView.conversationItems : [];
  const nextText = asText(pending?.text || fallbackText);
  if (!pending?.hasPending || !nextText) {
    return currentItems.filter((item) => item?.role !== "guidance");
  }

  const nextAt = asText(pending?.at) || new Date().toISOString();
  const nextItem = buildLocalGuidanceConversationItem({
    text: nextText,
    pending,
    at: nextAt,
  });
  const withoutGuidance = currentItems.filter((item) => item?.role !== "guidance");
  return [...withoutGuidance, nextItem].filter(Boolean);
}

function applyPendingGuidanceToMobileView(mobileView, pending, fallbackText = "") {
  if (!mobileView || typeof mobileView !== "object" || !pending) return mobileView;
  const nextPending = {
    ...pending,
    text: asText(pending.text || fallbackText),
    preview: asText(pending.preview || pending.text || fallbackText),
    hasPending: pending.hasPending === true,
  };

  return {
    ...mobileView,
    pendingGuidance: nextPending,
    processStatus: {
      ...(mobileView.processStatus || {}),
      hasPendingGuidance: nextPending.hasPending,
      pendingGuidancePreview: nextPending.hasPending ? nextPending.preview : "",
    },
    conversationItems: mergeConversationItemsWithPending(
      mobileView,
      nextPending,
      fallbackText,
    ),
  };
}

function resolvePollInterval(connectionState, mobileView) {
  if (connectionState === "degraded") {
    return DEGRADED_POLL_MS;
  }

  const processState = asText(mobileView?.processStatus?.state);
  const hasPendingGuidance = mobileView?.pendingGuidance?.hasPending === true;
  const isRealtimePhase = [
    "codex_working",
    "supervisor_reviewing",
    "monitoring",
  ].includes(processState);

  if (isRealtimePhase || hasPendingGuidance) {
    return FAST_POLL_MS;
  }

  return POLL_MS;
}

function shortThreadId(threadId = "") {
  const value = asText(threadId);
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function presentProcessStageLabel(state = "") {
  const labels = {
    waiting_next_turn: "等待下一轮",
    codex_working: "Codex 处理中",
    supervisor_reviewing: "监督复盘中",
    monitoring: "监控模式",
    budget_blocked: "已到限制",
    health_blocked: "需先处理问题",
    error: "发送失败",
  };
  return labels[state] || "状态同步中";
}

function deriveRealtimeStageSnapshot(mobileView) {
  const process = mobileView?.processStatus || {};
  const runtimeEvents = Array.isArray(mobileView?.runtimeEvents)
    ? mobileView.runtimeEvents.filter(Boolean)
    : [];
  const latestEventType = asText(process.latestEventType);
  const latestEventTitle = asText(runtimeEvents[0]?.title);
  const latestEventDetail = asText(runtimeEvents[0]?.detail || runtimeEvents[0]?.fullDetail);
  const promptGenerationWarning = asText(process.latestInstructionSourceDetail);
  const waitingDurationLabel = asText(process.waitingDurationLabel);
  const serverPhaseLabel = asText(process.realtimePhaseLabel);
  const serverPhaseDetail = asText(process.realtimePhaseDetail);
  const serverPhaseTone = asText(process.realtimePhaseTone);
  const serverActionLabel = asText(process.realtimeRecentActionLabel);
  const serverActionDetail = asText(process.realtimeRecentActionDetail);

  if (serverPhaseLabel || serverPhaseDetail || serverActionLabel || serverActionDetail) {
    return {
      label: serverPhaseLabel || presentProcessStageLabel(process.state),
      detail:
        serverPhaseDetail ||
        asText(process.detail) ||
        latestEventDetail ||
        "正在同步这一轮的最新进展。",
      tone: serverPhaseTone || process.monitorTone || "soft",
      eventLabel:
        serverActionLabel ||
        latestEventTitle ||
        asText(process.headline) ||
        "已同步最近动作",
      eventDetail:
        serverActionDetail ||
        latestEventDetail ||
        asText(process.nextAction) ||
        "等待下一条进展。",
    };
  }

  if (process.state === "supervisor_reviewing") {
    return {
      label: "监督复盘中",
      detail:
        presentMonitorText(process.detail) ||
        presentMonitorText(latestEventDetail) ||
        "本地模型监督流程正在结合最新回复决定下一步。",
      tone: process.monitorTone || "active",
      eventLabel: latestEventTitle || "监督复盘中",
      eventDetail: latestEventDetail || asText(process.nextAction),
    };
  }

  if (process.state === "codex_working") {
    if (latestEventType === "codex_followup_dispatching") {
      return {
        label: "刚发出，待送达确认",
        detail:
          presentMonitorText(latestEventDetail) ||
          presentMonitorText(promptGenerationWarning) ||
          "这一条引导已经开始发送，正在等桌面端确认已送达 Codex。",
        tone: "queued",
        eventLabel: latestEventTitle || "正在发送下一轮指令",
        eventDetail:
          presentMonitorText(latestEventDetail) ||
          "先不要重复发送，等桌面端确认送达后再继续观察。",
      };
    }

    if (
      latestEventType === "codex_followup_sent_waiting" ||
      latestEventType === "codex_followup_dispatched"
    ) {
      return {
        label: "已送达，等 Codex 完成",
        detail:
          presentMonitorText(latestEventDetail) ||
          presentMonitorText(process.detail) ||
          `${waitingDurationLabel ? `${waitingDurationLabel}。` : ""}上一条已经送达，正在等 Codex 完成当前轮。`,
        tone: process.monitorTone || "active",
        eventLabel: latestEventTitle || "正在等待 Codex 回复",
        eventDetail:
          presentMonitorText(latestEventDetail) ||
          "这一轮已经送达，不会追加发送，避免打断 Codex。",
      };
    }

    return {
      label: "Codex 处理中",
      detail:
        presentMonitorText(process.detail) ||
        presentMonitorText(latestEventDetail) ||
        "Codex 正在处理当前轮，完成前不会追加发送。",
      tone: process.monitorTone || "active",
      eventLabel: latestEventTitle || "Codex 正在处理",
      eventDetail: presentMonitorText(latestEventDetail) || presentMonitorText(process.nextAction),
    };
  }

  if (process.state === "waiting_next_turn") {
    return {
      label: "可继续下一轮",
      detail:
        presentMonitorText(process.detail) ||
        presentMonitorText(latestEventDetail) ||
        "当前没有阻塞，可以继续观察或准备下一轮引导。",
      tone: process.monitorTone || "ready",
      eventLabel: latestEventTitle || asText(process.headline) || "等待下一轮",
      eventDetail:
        presentMonitorText(latestEventDetail) ||
        presentMonitorText(process.nextAction) ||
        "确认方向后再决定是否继续发送。",
    };
  }

  return {
    label: presentProcessStageLabel(process.state),
    detail: presentProcessStageDetail(process),
    tone: process.monitorTone || "soft",
    eventLabel: latestEventTitle || asText(process.headline) || "已同步最近动作",
    eventDetail:
      presentMonitorText(latestEventDetail) ||
      presentMonitorText(process.latestEventType) ||
      `最近更新 ${formatTime(process.lastDispatchAt || mobileView?.thread?.lastDispatchAt)}`,
  };
}

function presentProcessStageDetail(process = {}) {
  return (
    presentMonitorText(process.detail) ||
    presentMonitorText(process.holdReason) ||
    presentMonitorText(process.nextAction) ||
    "正在同步这一轮的最新进展。"
  );
}

function buildRealtimeStageRows(mobileView) {
  const process = mobileView?.processStatus || {};
  const pending = mobileView?.pendingGuidance || {};
  const stageSnapshot = deriveRealtimeStageSnapshot(mobileView);
  const rows = [
    {
      label: "当前阶段",
      value: presentMonitorText(stageSnapshot.label),
      detail: presentMonitorText(stageSnapshot.detail),
      tone: stageSnapshot.tone,
    },
  ];

  if (process.latestEventType || process.lastDispatchAt || mobileView?.thread?.lastDispatchAt) {
    rows.push({
      label: "最近动作",
      value: presentMonitorText(stageSnapshot.eventLabel),
      detail: presentMonitorText(stageSnapshot.eventDetail),
      tone: stageSnapshot.tone,
    });
  }

  if (pending.hasPending) {
    rows.push({
      label: "补充引导",
      value: asText(pending.statusLabel, "待下一轮合并"),
      detail:
        presentMonitorText(pending.userMessage) ||
        presentMonitorText(pending.statusDetail) ||
        "会等 Codex 当前轮完成后再交给本地模型监督流程合并。",
      tone: "queued",
    });
  } else if (process.lastMergedGuidanceStatus) {
    rows.push({
      label: "补充引导",
      value: asText(process.lastMergedGuidanceLabel, "已合并补充"),
      detail:
        asText(process.lastMergedGuidanceDetail) ||
        asText(process.lastMergedGuidancePreview) ||
        "最近一条补充已经并入下一轮指令。",
      tone: "merged",
    });
  }

  return rows;
}

function buildRealtimeEvents(mobileView) {
  const events = Array.isArray(mobileView?.runtimeEvents) ? mobileView.runtimeEvents.filter(Boolean) : [];
  return events.slice(0, 3).map((event, index) => ({
    id: `${event.at || index}-${event.type || "event"}`,
    title: presentMonitorText(event.title, "最近进展"),
    detail:
      presentMonitorText(event.detail) ||
      presentMonitorText(event.fullDetail) ||
      "等待下一条进展。",
    at: event.at,
    tone: event.tone || "normal",
  }));
}

function presentStatusRowLabel(label) {
  if (label === "longrun") {
    return "长跑判断";
  }
  return label;
}

function trimPathToken(token) {
  return asText(token).replace(/[),.;，。；）]+$/u, "");
}

function looksLikeFilePath(token) {
  const value = trimPathToken(token);
  return (
    /^[A-Za-z]:[\\/][^\s]+/.test(value) ||
    /^\.{1,2}[\\/][^\s]+/.test(value) ||
    /^\/[^\s]+/.test(value) ||
    /^(?:app|scripts|docs|tests|runtime|settings)[\\/][^\s]+/.test(value)
  );
}

function InlineMessageText({ text }) {
  const value = asText(text);
  if (!value) return null;

  const pattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\)|[A-Za-z]:[\\/][^\s`，。；：、（）()<>"]+|\.{1,2}[\\/][^\s`，。；：、（）()<>"]+|\/[^\s`，。；：、（）()<>"]+|(?:app|scripts|docs|tests|runtime|settings)[\\/][^\s`，。；：、（）()<>"]+)/g;
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
            title="复制路径"
            onClick={() => copyText(pathText)}
            onContextMenu={(event) => {
              event.preventDefault();
              copyText(pathText);
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
  const value = asText(text);
  if (!value) return null;
  const blocks = splitMarkdownBlocks(value);

  const renderText = (blockText, blockIndex) => {
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
  };

  return (
    <div className="markdown-message">
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <figure className="markdown-code-block" key={`code-${index}`}>
            <figcaption>
              <span>{block.lang || "代码"}</span>
              <button type="button" onClick={() => copyText(block.content)}>
                复制
              </button>
            </figcaption>
            <pre>{block.content}</pre>
          </figure>
        ) : (
          <React.Fragment key={`text-${index}`}>{renderText(block.content, index)}</React.Fragment>
        ),
      )}
    </div>
  );
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
    asText(target.threadTitle || target.workspaceName || target.runId),
    asText(target.workspaceRoot),
    shortThreadId(target.threadId),
  ].filter(Boolean).join(" / ");
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = [entry.role, entry.at || "", compactText(entry.text, 240)].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildConversation(mobileView) {
  return buildConversationItemsFromMobileView(mobileView);

  if (mobileView?.conversationItems?.length) {
    return dedupe(mobileView.conversationItems).sort((a, b) => {
      const left = Date.parse(a.at || "");
      const right = Date.parse(b.at || "");
      if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
      if (!Number.isFinite(left)) return 1;
      if (!Number.isFinite(right)) return -1;
      return left - right;
    });
  }

  const mirrored = mobileView?.codexConversation?.entries || [];
  if (mirrored.length) {
    return dedupe(mirrored);
  }

  const entries = [];
  const latestPrompt = asText(mobileView?.latestPrompt);
  if (latestPrompt) {
    entries.push({
      role: "user",
      at: mobileView?.thread?.lastDispatchAt || "",
      text: latestPrompt,
      preview: latestPrompt,
    });
  }

  for (const item of mobileView?.transcriptEntries || []) {
    const text = asText(item.summary || item.note);
    if (!text) continue;
    entries.push({
      role: "assistant",
      at: item.at,
      text,
      preview: text,
    });
  }

  for (const event of mobileView?.runtimeEvents || []) {
    const text = asText(event.detail || event.title);
    if (!text) continue;
    entries.push({
      role: event.type?.includes("dispatch") ? "user" : "assistant",
      at: event.at,
      text,
      preview: text,
    });
  }

  return dedupe(entries).sort((a, b) => {
    const left = Date.parse(a.at || "");
    const right = Date.parse(b.at || "");
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return left - right;
  });
}

function PairingView({ onPaired }) {
  const pairingQuery = readPairingQuery();
  const [payload, setPayload] = useState("");
  const [sessionId, setSessionId] = useState(pairingQuery.sessionId || "");
  const [pairingCode, setPairingCode] = useState(pairingQuery.pairingCode || "");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerSupported] = useState(canUseBarcodeDetector());
  const [scannerState, setScannerState] = useState("idle");
  const autoConfirmAttemptedRef = useRef(false);
  const fallbackDetailsRef = useRef(null);
  const videoRef = useRef(null);
  const scannerStreamRef = useRef(null);
  const scannerFrameRef = useRef(0);
  const parsed = parsePairingText(payload);
  const finalSessionId = sessionId || parsed.sessionId || "";
  const finalPairingCode = pairingCode || parsed.pairingCode || "";

  useEffect(() => {
    if (!pairingQuery.sessionId || !pairingQuery.pairingCode) {
      return;
    }
    setSessionId(pairingQuery.sessionId);
    setPairingCode(pairingQuery.pairingCode);
  }, [pairingQuery.sessionId, pairingQuery.pairingCode]);

  async function confirmPairingWith(sessionValue, codeValue, { auto = false } = {}) {
    if (!sessionValue || !codeValue) {
      fallbackDetailsRef.current?.setAttribute("open", "true");
      setMessage("请先扫描二维码；如果不能扫码，请展开备用方式并填写绑定信息。");
      return;
    }

    setSubmitting(true);
    setMessage(auto ? "正在确认绑定…" : "");
    try {
      const result = await requestJson("/device-pairing/confirm", {
        method: "POST",
        body: JSON.stringify({
          sessionId: sessionValue,
          pairingCode: codeValue,
          deviceName: "手机监控",
        }),
      });
      const device = {
        deviceId: result.device?.id,
        deviceToken: result.deviceToken,
        deviceName: result.device?.name || "手机监控",
      };
      saveDevice(device);
      clearPairingQueryFromUrl();
      onPaired(device);
    } catch (error) {
      setMessage(error.message || "绑定失败，请重新扫码。");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (!pairingQuery.sessionId || !pairingQuery.pairingCode) {
      return;
    }
    if (autoConfirmAttemptedRef.current) {
      return;
    }
    autoConfirmAttemptedRef.current = true;
    void confirmPairingWith(pairingQuery.sessionId, pairingQuery.pairingCode, {
      auto: true,
    });
  }, [pairingQuery.pairingCode, pairingQuery.sessionId]);

  useEffect(() => {
    return () => {
      if (scannerFrameRef.current) {
        window.cancelAnimationFrame(scannerFrameRef.current);
      }
      if (scannerStreamRef.current) {
        scannerStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    if (!scannerOpen || !scannerSupported) {
      if (scannerFrameRef.current) {
        window.cancelAnimationFrame(scannerFrameRef.current);
        scannerFrameRef.current = 0;
      }
      if (scannerStreamRef.current) {
        scannerStreamRef.current.getTracks().forEach((track) => track.stop());
        scannerStreamRef.current = null;
      }
      return;
    }

    let cancelled = false;

    async function startScanner() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setScannerState("unsupported");
        setMessage("当前浏览器不支持相机扫码，请使用无法扫码时的备用方式。");
        return;
      }

      setScannerState("requesting");
      setMessage("");

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        scannerStreamRef.current = stream;
        setScannerState("scanning");
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const tick = async () => {
          if (cancelled || !videoRef.current) {
            return;
          }
          try {
            const rawValue = await readBarcodeFromVideoFrame(videoRef.current);
            if (rawValue) {
              setPayload(rawValue);
              const nextParsed = parsePairingText(rawValue);
              if (nextParsed.sessionId) {
                setSessionId(nextParsed.sessionId);
              }
              if (nextParsed.pairingCode) {
                setPairingCode(nextParsed.pairingCode);
              }
              setScannerOpen(false);
              setScannerState("resolved");
              setMessage("已识别二维码，确认后即可完成绑定。");
              return;
            }
          } catch {
            setScannerState("error");
            setMessage("扫码暂时失败，请稍后重试，或使用无法扫码时的备用方式。");
            setScannerOpen(false);
            return;
          }
          scannerFrameRef.current = window.requestAnimationFrame(() => {
            void tick();
          });
        };

        scannerFrameRef.current = window.requestAnimationFrame(() => {
          void tick();
        });
      } catch {
        setScannerState("denied");
        setMessage("无法打开相机，请允许相机权限，或使用无法扫码时的备用方式。");
        setScannerOpen(false);
      }
    }

    void startScanner();

    return () => {
      cancelled = true;
      if (scannerFrameRef.current) {
        window.cancelAnimationFrame(scannerFrameRef.current);
        scannerFrameRef.current = 0;
      }
      if (scannerStreamRef.current) {
        scannerStreamRef.current.getTracks().forEach((track) => track.stop());
        scannerStreamRef.current = null;
      }
    };
  }, [scannerOpen, scannerSupported]);

  async function confirmPairing() {
    await confirmPairingWith(finalSessionId, finalPairingCode);
  }

  function openFallbackPairing() {
    setScannerOpen(false);
    fallbackDetailsRef.current?.setAttribute("open", "true");
    fallbackDetailsRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  return (
    <main className="mobile-shell pairing-shell">
      <section className="hero">
        <span>codex-loop</span>
        <h1>绑定这台电脑</h1>
        <p>扫码长期绑定后，手机就能查看任务进程、历史对话，并发送下一轮引导。</p>
      </section>

      <section className="pairing-panel">
        {pairingQuery.sessionId && pairingQuery.pairingCode ? (
          <p className="notice">已从绑定链接带入配对信息，确认后即可长期绑定这台电脑。</p>
        ) : null}
        <div className="pairing-primary-actions">
          <button
            type="button"
            disabled={!scannerSupported || submitting}
            onClick={() => setScannerOpen((current) => !current)}
          >
            扫描二维码绑定
          </button>
          <button type="button" className="quiet" onClick={openFallbackPairing}>
            无法扫码
          </button>
        </div>
        <p className="pairing-primary-hint">
          {scannerSupported
            ? "推荐直接扫描桌面端“移动端使用”里生成的二维码。"
            : "当前浏览器暂不支持相机扫码，请使用桌面端显示的绑定链接。"}
        </p>
        {scannerOpen ? (
          <div className="pairing-scanner">
            <div className="pairing-scanner-head">
              <strong>扫描二维码绑定</strong>
              <span>
                {scannerState === "requesting"
                  ? "正在请求相机权限"
                  : scannerState === "scanning"
                    ? "请把二维码放进取景框"
                    : "准备打开相机"}
              </span>
            </div>
            <video ref={videoRef} className="pairing-scanner-video" playsInline muted />
          </div>
        ) : null}
        <details className="pairing-fallback" ref={fallbackDetailsRef}>
          <summary>无法扫码时使用</summary>
          <p>只有在相机不可用或扫码失败时才需要填写这里。</p>
          <label>
            <span>绑定链接或二维码内容</span>
            <textarea
              value={payload}
              rows={5}
              placeholder="粘贴桌面端“移动端使用”里显示的绑定链接或二维码内容。"
              onChange={(event) => setPayload(event.target.value)}
            />
          </label>
          <div className="pairing-grid">
            <label>
              <span>会话编号</span>
              <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
            </label>
            <label>
              <span>确认码</span>
              <input value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} />
            </label>
          </div>
        </details>
        {message ? <p className="notice danger">{message}</p> : null}
        <button type="button" disabled={submitting} onClick={() => void confirmPairing()}>
          确认绑定
        </button>
      </section>
    </main>
  );
}

function StatusBlock({ mobileView, productionStatus, productionPreflight, statusText }) {
  const process = mobileView?.processStatus || {};
  const realtimeStageRows = buildRealtimeStageRows(mobileView);
  const realtimeEvents = buildRealtimeEvents(mobileView);
  const statusHero = buildStatusHeroSummary({
    headline: process.headline || mobileView?.summary?.recentSummary,
    detail: process.detail || mobileView?.suggestedAction,
    nextAction: process.nextAction || mobileView?.suggestedAction,
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
  const closedLoopText = closedLoopEvidence.label ||
    (closedLoopCount >= closedLoopTarget
      ? "已达到长期运行基本证据"
      : `还差 ${closedLoopTarget - closedLoopCount} 轮真实闭环`);
  const guidanceEvidence = productionStatus?.guidanceEvidence || {};
  const longRunHint = closedLoopCount >= closedLoopTarget
    ? "已经具备长跑基础证据，可以继续观察更长时间稳定性。"
    : `距离可长跑还差 ${Math.max(0, closedLoopTarget - closedLoopCount)} 轮真实闭环证据。`;
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
    { label: "监督复盘", detail: "等待产品经理、测试人员、真实用户视角完成复盘。" },
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
          ? "需留意"
          : "";
  const productionDetail =
    productionObservation?.status === "stale"
      ? productionStatus?.nextAction ||
        "真实运行观测已过期，请重新运行生产观测，或重新启动一次真实任务生成新的进展证据。"
      : productionStatus?.nextAction || productionObservation?.summary || "";
  const readinessDetail = readiness.summary || readiness.nextAction || productionDetail;
  const productionStageSummary = compactText(maturity?.summary || readinessDetail, 110) || "等待更多真实闭环证据。";
  const productionObservationSummary =
    compactText(
      productionDetail,
      110,
    ) || (productionObservation?.status === "stale" ? "真实运行观测已过期。" : "等待形成新的真实观测。");
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
  const modelPipeline = buildModelPipelineSummary(process);
  const rows = [
    ["当前状态", process.monitorLabel || mobileView?.loop?.modeLabel || "监控中"],
    ["下一步", process.nextAction || mobileView?.suggestedAction || "等待下一轮更新"],
    process.supervisorPerspectiveSummary ? ["监督结论", process.supervisorPerspectiveSummary] : null,
    process.supervisorVerificationLabel || process.supervisorVerificationStatus
      ? ["当前验收", process.supervisorVerificationLabel || process.supervisorVerificationStatus]
      : null,
    hasMeaningfulPendingGuidance(mobileView)
      ? ["待合并引导", process.pendingGuidancePreview || mobileView?.pendingGuidance?.preview]
      : null,
  ].filter(Boolean);
  const details = [
    productionFocus.attention ? ["当前要留意", productionFocus.attention] : null,
    productionFocus.nextAction ? ["生产建议", productionFocus.nextAction] : null,
    productionFocus.summary ? ["生产判断", productionFocus.summary] : null,
    modelPipeline.detail ? ["本地监督", modelPipeline.detail] : null,
    productionTarget ? ["验证目标", productionTarget] : null,
    productionStatus ? ["生产阶段", `${maturityLabel} · ${productionStageSummary}`] : null,
    productionStatus
      ? [
          "生产成熟度",
          [
            maturityLabel,
            productionStatus.title || "生产状态摘要",
            productionStatus.nextAction || productionObservation?.summary,
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
    productionStatus?.maturity ? ["剩余缺口", maturityGapText] : null,
    productionStatus ? ["长跑提示", longRunHint] : null,
    productionStatus?.guidanceEvidence
      ? [
          "补充合并证据",
          `${guidanceEvidenceCount}/${guidanceEvidenceTarget} · ${presentMonitorText(guidanceEvidenceText)}。${presentMonitorText(guidanceEvidence.summary) || "确认用户补充引导会等 Codex 完成后由本地模型监督流程合并。"}`,
        ]
      : null,
    evidencePlanText
      ? ["下一轮验证", `${closedLoopEvidencePlan.summary || "按真实闭环验证计划推进。"} ${evidencePlanText}`]
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
    productionPreflight
      ? [
          "启动预检",
          [
            preflightLabel,
            productionPreflight.summary,
            productionPreflight.nextAction,
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
    process.holdReason ? ["等待原因", process.holdReason] : null,
    process.pendingGuidancePreview || mobileView?.pendingGuidance?.preview
      ? ["待合并引导", process.pendingGuidancePreview || mobileView?.pendingGuidance?.preview]
      : null,
    process.lastMergedGuidanceStatus
      ? [
          "已合并补充",
          [
            process.lastMergedGuidanceLabel,
            process.lastMergedGuidancePreview,
            process.lastMergedGuidanceDetail,
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
    process.supervisorVerificationLabel || process.supervisorVerificationStatus
      ? ["独立验收", process.supervisorVerificationLabel || process.supervisorVerificationStatus]
      : null,
    process.supervisorPerspectiveRows?.length
      ? [
          "监督视角",
          process.supervisorPerspectiveRows
            .map((row) => `${presentMonitorText(row.label)}：${presentMonitorText(row.text)}`)
            .join("；"),
        ]
      : null,
    process.supervisorVerificationAction ? ["验收动作", process.supervisorVerificationAction] : null,
    process.supervisorVerificationEvidencePreview || process.supervisorVerificationEvidenceCount
      ? [
          "视觉证据",
          process.supervisorVerificationEvidencePreview ||
            `${process.supervisorVerificationEvidenceCount} 条视觉证据`,
        ]
      : null,
    process.latestInstructionSourceDetail ? ["整理来源", process.latestInstructionSourceDetail] : null,
    process.latestCodexSummarySourceLabel || process.latestCodexSummarySourceDetail
      ? [
          "回复摘要",
          [
            process.latestCodexSummarySourceLabel,
            process.latestCodexSummarySourceDetail,
          ]
            .filter(Boolean)
            .join("："),
        ]
      : null,
  ].filter((row) => row && asText(row[1]));

  return (
    <section className="status-block">
      <div className="status-hero">
        <div className="status-hero-block">
          <span>这一轮在做什么</span>
          <strong>{presentMonitorText(statusHero.headline)}</strong>
          <p>{presentMonitorText(statusHero.detail)}</p>
        </div>
        <div className="status-hero-block">
          <span>你下一步该做什么</span>
          <strong>{presentMonitorText(statusHero.nextAction)}</strong>
        </div>
      </div>
      <div className="status-head">
        <span>{statusText}</span>
        <strong>{presentMonitorText(process.headline || mobileView?.summary?.recentSummary, "正在同步任务状态")}</strong>
      </div>
      {realtimeStageRows.length ? (
        <div className="status-stage-strip" aria-label="当前进程节奏">
          {realtimeStageRows.map((row) => (
            <div className={`status-stage-item is-${row.tone || "soft"}`} key={row.label}>
              <span>{row.label}</span>
              <strong>{row.value}</strong>
              <p>{row.detail}</p>
            </div>
          ))}
        </div>
      ) : null}
      {rows.map(([label, value]) => (
        <div className="status-row" key={label}>
          <span>{presentSharedStatusRowLabel(label)}</span>
          <strong>{presentMonitorText(value)}</strong>
        </div>
      ))}
      {realtimeEvents.length ? (
        <div className="status-timeline">
          <div className="status-timeline-head">
            <span>最近进程</span>
            <strong>只保留最近关键动作，方便远程判断是否需要介入</strong>
          </div>
          <div className="status-timeline-list">
            {realtimeEvents.map((event) => (
              <div className={`status-timeline-item is-${event.tone || "normal"}`} key={event.id}>
                <div className="status-timeline-meta">
                  <span>{event.title}</span>
                  <time>{formatTime(event.at)}</time>
                </div>
                <strong>{event.detail}</strong>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {details.length ? (
        <details className="status-detail">
          <summary>状态细节</summary>
          <div className="status-detail-grid">
            {productionStatus ? (
              <>
                <div className="status-detail-row">
                  <span>长跑判断</span>
                  <strong>{longRunDecision}</strong>
                </div>
                <div className="status-detail-row">
                  <span>闭环证据</span>
                  <strong>{closedLoopCount}/{closedLoopTarget} · {closedLoopText}</strong>
                </div>
                <div className="status-detail-row">
                  <span>补充合并证据</span>
                  <strong>{guidanceEvidenceCount}/{guidanceEvidenceTarget} · {presentMonitorText(guidanceEvidenceText)}</strong>
                </div>
              </>
            ) : null}
            {details.map(([label, value]) => (
              <div className="status-detail-row" key={label}>
                <span>{label}</span>
                <strong>{compactText(presentMonitorText(value), 150)}</strong>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function ConversationDetailBlocks({ blocks = [] }) {
  const visibleBlocks = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (!visibleBlocks.length) return null;

  const detailLabel = (block) => {
    if (block.displayLabel || block.summary) {
      return asText(block.displayLabel || block.summary, "查看详情");
    }
    if (block.kind === "script_snippet") {
      return "脚本内容 · 1 段脚本";
    }
    return "查看详情";
  };

  const detailMeta = (block) => {
    const parts = [
      asText(block.countLabel),
      asText(block.summary),
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
                {asText(getConversationDetailLabel(block), "查看详情")}
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
                    copyText(target.value);
                  }}
                >
                  {asText(target.label, target.kind === "command" ? "复制命令" : "复制文件")}
                </button>
              ))}
            </div>
          ) : null}
          <pre className="conversation-detail-body">{asText(block.text)}</pre>
        </details>
      ))}
    </div>
  );
}

function ArchivedConversationPreview({ mobileView }) {
  const entries = useMemo(() => buildConversation(mobileView), [mobileView]);
  const bottomRef = useRef(null);
  const latestEntry = entries.at(-1);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [entries.length, latestEntry?.at, latestEntry?.role]);

  if (!entries.length) {
    return <section className="empty">还没有历史对话。绑定任务后，这里会显示 Codex 回复和 codex-loop 发出的指令。</section>;
  }

  return (
    <section className="conversation" aria-label="历史对话">
      <h2>历史对话</h2>
      {entries.map((entry, index) => {
        const isGuidance = entry.role === "guidance";
        const isLoop = entry.role === "user" || entry.role === "loop" || isGuidance;
        const text = asText(entry.text || entry.summary || entry.preview);
        const preview = compactText(entry.preview || text, isLoop ? 120 : 220);
        const roleLabel = getConversationRoleLabel(entry.role);
        return (
          <article
            className={isLoop ? "message is-loop" : "message is-codex"}
            key={`${entry.at || index}-${entry.role}-${index}`}
          >
            <details open={index >= entries.length - 2}>
              <summary>
                <span>{formatTime(entry.at)} · {isLoop ? "codex-loop" : "Codex"}</span>
                <strong>{compactText(entry.preview || text, isLoop ? 120 : 220)}</strong>
              </summary>
              <MarkdownMessage text={text} />
              <ConversationDetailBlocks blocks={entry.detailBlocks} />
            </details>
          </article>
        );
      })}
      <div ref={bottomRef} />
    </section>
  );
}

function Conversation({ mobileView, refreshNotice = "" }) {
  const entries = useMemo(() => buildConversation(mobileView), [mobileView]);
  const bottomRef = useRef(null);
  const autoFollowRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const latestEntry = entries.at(-1);

  useEffect(() => {
    const updateFollowState = () => {
      const nearBottom = isNearViewportBottom(bottomRef.current);
      autoFollowRef.current = nearBottom;
      setShowJumpToLatest((current) => (nearBottom ? false : current));
    };

    updateFollowState();
    window.addEventListener("scroll", updateFollowState, { passive: true });
    window.addEventListener("resize", updateFollowState);
    return () => {
      window.removeEventListener("scroll", updateFollowState);
      window.removeEventListener("resize", updateFollowState);
    };
  }, []);

  useEffect(() => {
    if (autoFollowRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
      setShowJumpToLatest(false);
      return;
    }
    setShowJumpToLatest(true);
  }, [entries.length, latestEntry?.at, latestEntry?.role]);

  if (!entries.length) {
    return <section className="empty">还没有历史对话。绑定任务后，这里会显示 Codex 回复和 codex-loop 发出的指令。</section>;
  }

  return (
    <section className="conversation" aria-label="历史对话">
      <div className="conversation-heading">
        <h2>历史对话</h2>
        {refreshNotice ? <p className="conversation-refresh-notice">{refreshNotice}</p> : null}
      </div>
      {showJumpToLatest ? (
        <button
          type="button"
          className="jump-to-latest"
          onClick={() => {
            autoFollowRef.current = true;
            setShowJumpToLatest(false);
            bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
          }}
        >
          查看最新
        </button>
      ) : null}
      {entries.map((entry, index) => {
        const isGuidance = entry.role === "guidance";
        const isLoop = entry.role === "user" || entry.role === "loop" || isGuidance;
        const text = asText(entry.text || entry.summary || entry.preview);
        const preview = compactText(entry.preview || text, isLoop ? 120 : 220);
        const roleLabel = getConversationRoleLabel(entry.role);
        const actionLabel = getConversationActionLabel({
          hasText: Boolean(text),
          isGuidance,
          isLoop,
        });

        return (
          <article
            className={isGuidance ? "message is-guidance" : isLoop ? "message is-loop" : "message is-codex"}
            key={`${entry.at || index}-${entry.role}-${index}`}
          >
            <details open={index >= entries.length - 2}>
              <summary>
                <span className="message-meta-line">
                  <span className="message-role">{roleLabel}</span>
                  <span>{formatTime(entry.at)}</span>
                </span>
                <strong>{preview}</strong>
                <span className="message-action-line">
                  <em>{actionLabel}</em>
                  {text ? (
                    <button
                      type="button"
                      className="message-copy-button"
                      onClick={(event) => {
                        event.preventDefault();
                        copyText(text);
                      }}
                    >
                      复制全文
                    </button>
                  ) : null}
                </span>
              </summary>
              <MarkdownMessage text={text} />
              <ConversationDetailBlocks blocks={entry.detailBlocks} />
            </details>
          </article>
        );
      })}
      <div ref={bottomRef} />
    </section>
  );
}

function PendingGuidance({ pending, onEdit, onClear, disabled }) {
  if (!pending?.hasPending) return null;
  return (
    <section className="pending-guidance">
      <div>
        <span>待合并</span>
        {pending.statusLabel ? <em>{pending.statusLabel}</em> : null}
        <strong>{pending.preview || pending.text}</strong>
        <p>
          {disabled
            ? "当前显示的是最近一次缓存结果，恢复连接后会以服务端状态为准。"
            : presentMonitorText(pending.statusDetail) ||
              presentMonitorText(pending.userMessage) ||
              "会等 Codex 完成后交给本地模型监督流程合并，不会打断当前任务。"}
        </p>
      </div>
      <div className="mini-actions">
        <button type="button" disabled={disabled} onClick={onEdit} aria-label={`${pending.actionLabel || "等待发送"}，编辑待合并引导`}>
          编辑
        </button>
        <button type="button" disabled={disabled} onClick={onClear} aria-label="撤回待合并引导">
          撤回
        </button>
      </div>
    </section>
  );
}

function GuidanceComposer({ value, setValue, editing, submitting, disabled, onCancel, onSubmit }) {
  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        value={value}
        rows={3}
        placeholder="补充你要说的话，等 Codex 完成后合并，会等 Codex 当前任务完成再发送"
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="composer-actions">
        {editing ? (
          <button type="button" className="quiet" disabled={submitting || disabled} onClick={onCancel}>
            取消
          </button>
        ) : null}
        <button type="submit" disabled={submitting || disabled || !value.trim()}>
          {editing ? "保存修改" : "发送引导"}
        </button>
      </div>
    </form>
  );
}

function GuidanceFeedback({ message = "", tone = "info" }) {
  const text = asText(message);
  if (!text) return null;
  return <p className={`notice guidance-feedback ${tone}`}>{text}</p>;
}

function TaskMonitorApp() {
  const [device, setDevice] = useState(readDevice);
  const [mobileView, setMobileView] = useState(null);
  const [productionStatus, setProductionStatus] = useState(null);
  const [productionPreflight, setProductionPreflight] = useState(null);
  const [statusText, setStatusText] = useState("正在连接");
  const [errorText, setErrorText] = useState("");
  const [connectionState, setConnectionState] = useState("connecting");
  const [lastSuccessAt, setLastSuccessAt] = useState("");
  const [guidance, setGuidance] = useState("");
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [guidanceFeedback, setGuidanceFeedback] = useState("");
  const [guidanceFeedbackTone, setGuidanceFeedbackTone] = useState("info");
  const [snapshotSource, setSnapshotSource] = useState("live");
  const [conversationRefreshNotice, setConversationRefreshNotice] = useState("");
  const lastSuccessAtRef = useRef("");
  const hasLastSnapshotRef = useRef(false);
  const loadInFlightRef = useRef(false);
  const lastSnapshotSignatureRef = useRef("");
  const previousSnapshotSourceRef = useRef("live");
  const noticeTimerRef = useRef(0);
  const guidanceFeedbackTimerRef = useRef(0);

  useEffect(() => {
    if (!device?.deviceId) {
      setMobileView(null);
      setProductionStatus(null);
      setProductionPreflight(null);
      setLastSuccessAt("");
      lastSuccessAtRef.current = "";
      hasLastSnapshotRef.current = false;
      lastSnapshotSignatureRef.current = "";
      previousSnapshotSourceRef.current = "live";
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = 0;
      }
      setConversationRefreshNotice("");
      setSnapshotSource("live");
      return;
    }

    const cached = readCachedSnapshot(device.deviceId);
    if (!cached) {
      return;
    }

    setMobileView(cached.mobile);
    setProductionStatus(cached.productionStatus || null);
    setProductionPreflight(cached.productionPreflight || null);
    setLastSuccessAt(cached.lastSuccessAt);
    lastSuccessAtRef.current = cached.lastSuccessAt;
    hasLastSnapshotRef.current = true;
    lastSnapshotSignatureRef.current = cached.snapshotSignature || "";
    previousSnapshotSourceRef.current = "cached";
    setStatusText("已载入最近结果");
    setConnectionState("connecting");
    setSnapshotSource("cached");
  }, [device?.deviceId]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current);
      }
      if (guidanceFeedbackTimerRef.current) {
        window.clearTimeout(guidanceFeedbackTimerRef.current);
      }
    };
  }, []);

  function presentGuidanceFeedback(message, tone = "info") {
    const text = asText(message);
    if (!text) return;
    setGuidanceFeedback(text);
    setGuidanceFeedbackTone(tone);
    if (guidanceFeedbackTimerRef.current) {
      window.clearTimeout(guidanceFeedbackTimerRef.current);
    }
    guidanceFeedbackTimerRef.current = window.setTimeout(() => {
      setGuidanceFeedback("");
      guidanceFeedbackTimerRef.current = 0;
    }, 6000);
  }

  useEffect(() => {
    if (!editing || connectionState !== "ready") {
      return;
    }

    const pending = mobileView?.pendingGuidance;
    if (!pending?.hasPending) {
      setGuidance("");
      setEditing(false);
      return;
    }

    const nextText = pending.text || "";
    if (nextText && nextText !== guidance) {
      setGuidance(nextText);
    }
  }, [mobileView?.pendingGuidance?.hasPending, mobileView?.pendingGuidance?.text, editing, guidance, connectionState]);

  async function load({ silent = false } = {}) {
    if (!device?.deviceId || !device?.deviceToken) return;
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    if (!silent) {
      setStatusText("正在同步");
    }
    setConnectionState((current) => (silent && current === "ready" ? current : "syncing"));
    try {
      const [result, production, preflight] = await Promise.all([
        requestJson("/mobile/view", {
          method: "POST",
          body: JSON.stringify({
            deviceId: device.deviceId,
            deviceToken: device.deviceToken,
          }),
        }),
        requestJson("/production-status").catch(() => null),
        requestJson("/production-preflight").catch(() => null),
      ]);
      setMobileView(result.mobile);
      setProductionStatus(production);
      setProductionPreflight(preflight);
      setErrorText("");
      setStatusText("已同步");
      setConnectionState("ready");
      setSnapshotSource("live");
      const syncedAt = new Date().toISOString();
      const nextSnapshotSignature = buildMobileSnapshotSignature(result.mobile);
      const restoredFromCached = previousSnapshotSourceRef.current === "cached";
      const cachedSignature = lastSnapshotSignatureRef.current;
      if (restoredFromCached && cachedSignature && nextSnapshotSignature && nextSnapshotSignature !== cachedSignature) {
        const previousConversationCount = mobileView ? getConversationCount(mobileView) : 0;
        const nextConversationCount = getConversationCount(result.mobile);
        const hasNewConversationItems = nextConversationCount > previousConversationCount;
        setConversationRefreshNotice(
          hasNewConversationItems
            ? "已切回实时状态，并收到新的聊天记录。"
            : "已切回实时状态，历史对话和待合并引导已按服务端最新结果更新。",
        );
        if (noticeTimerRef.current) {
          window.clearTimeout(noticeTimerRef.current);
        }
        noticeTimerRef.current = window.setTimeout(() => {
          setConversationRefreshNotice("");
          noticeTimerRef.current = 0;
        }, 6000);
      } else {
        setConversationRefreshNotice("");
      }
      lastSnapshotSignatureRef.current = nextSnapshotSignature;
      previousSnapshotSourceRef.current = "live";
      saveCachedSnapshot(device.deviceId, {
        mobile: result.mobile,
        productionStatus: production,
        productionPreflight: preflight,
        lastSuccessAt: syncedAt,
      });
      lastSuccessAtRef.current = syncedAt;
      hasLastSnapshotRef.current = true;
      setLastSuccessAt(syncedAt);
    } catch (error) {
      const message = presentConnectionError(error);
      setErrorText(message);
      setConnectionState("degraded");
      setSnapshotSource(hasLastSnapshotRef.current ? "cached" : "live");
      if (hasLastSnapshotRef.current) {
        previousSnapshotSourceRef.current = "cached";
      }
      setStatusText(hasLastSnapshotRef.current ? "连接波动" : "连接失效");
      if (/设备未绑定|令牌|重新扫码/.test(error.message || "")) {
        saveDevice(null);
        setDevice(null);
      }
    } finally {
      loadInFlightRef.current = false;
    }
  }

  useEffect(() => {
    void load();
  }, [device?.deviceId, device?.deviceToken]);

  useEffect(() => {
    if (!device?.deviceId || !device?.deviceToken) return undefined;
    const intervalMs = resolvePollInterval(connectionState, mobileView);
    const timer = window.setInterval(() => void load({ silent: true }), intervalMs);
    return () => window.clearInterval(timer);
  }, [device?.deviceId, device?.deviceToken, connectionState, mobileView]);

  useEffect(() => {
    if (!device?.deviceId || !device?.deviceToken) return undefined;

    const refreshNow = () => {
      if (document.visibilityState === "visible") {
        void load({ silent: true });
      }
    };

    const refreshOnFocus = () => {
      void load({ silent: true });
    };

    document.addEventListener("visibilitychange", refreshNow);
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener("online", refreshOnFocus);
    window.addEventListener("pageshow", refreshOnFocus);

    return () => {
      document.removeEventListener("visibilitychange", refreshNow);
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener("online", refreshOnFocus);
      window.removeEventListener("pageshow", refreshOnFocus);
    };
  }, [device?.deviceId, device?.deviceToken]);

  async function submitGuidance(event) {
    event.preventDefault();
    const text = guidance.trim();
    if (!text) return;
    setSubmitting(true);
    setErrorText("");
    try {
      const result = await requestJson("/mobile/guidance", {
        method: "POST",
        body: JSON.stringify({
          deviceId: device.deviceId,
          deviceToken: device.deviceToken,
          text,
          replace: editing,
        }),
      });
      setStatusText(
        presentPendingGuidanceStatus(
          result,
          "已记录下一轮补充，会在安全时机合并。",
        ),
      );
      presentGuidanceFeedback(
        presentPendingGuidanceStatus(
          result,
          "已记录下一轮补充，会在安全时机合并。",
        ),
      );
      if (result?.pendingGuidance) {
        setMobileView((current) => applyPendingGuidanceToMobileView(current, result.pendingGuidance, text));
      }
      setGuidance("");
      setEditing(false);
      await load({ silent: true });
    } catch (error) {
      setErrorText(error.message || "发送失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  async function clearGuidance() {
    setSubmitting(true);
    setErrorText("");
    try {
      const result = await requestJson("/mobile/guidance", {
        method: "DELETE",
        body: JSON.stringify({
          deviceId: device.deviceId,
          deviceToken: device.deviceToken,
        }),
      });
      setStatusText(presentPendingGuidanceStatus(result, "已撤回待合并引导。"));
      presentGuidanceFeedback(
        presentPendingGuidanceStatus(result, "已撤回待合并引导。"),
      );
      if (result?.pendingGuidance) {
        setMobileView((current) => applyPendingGuidanceToMobileView(current, result.pendingGuidance, ""));
      }
      setGuidance("");
      setEditing(false);
      await load({ silent: true });
    } catch (error) {
      setErrorText(error.message || "撤回失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  if (!device) {
    return <PairingView onPaired={setDevice} />;
  }

  const loopName = mobileView?.loop?.name || "当前任务";
  const threadName = mobileView?.thread?.title || mobileView?.thread?.threadId || "未绑定 Codex 窗口";
  const showingCachedSnapshot = snapshotSource === "cached" && connectionState !== "ready";
  const currentSnapshotSignature = mobileView ? buildMobileSnapshotSignature(mobileView) : "";
  const cachedSnapshotLooksStale = Boolean(
    showingCachedSnapshot &&
      currentSnapshotSignature &&
      lastSnapshotSignatureRef.current &&
      currentSnapshotSignature !== lastSnapshotSignatureRef.current,
  );
  const connectionBadge = connectionState === "ready"
    ? {
        tone: "live",
        label: "实时状态",
        detail: lastSuccessAt ? `已连上服务 · 最近同步 ${formatTime(lastSuccessAt)}` : "已连上服务",
      }
    : showingCachedSnapshot
      ? cachedSnapshotLooksStale
        ? {
            tone: "stale",
            label: "离线近况",
            detail: "当前缓存结果可能落后，恢复连接后会重新对齐历史和待合并引导。",
          }
        : {
            tone: "cached",
            label: "离线近况",
            detail: lastSuccessAtRef.current
              ? `暂时连不上服务，先显示 ${formatTime(lastSuccessAtRef.current)} 的最近结果`
              : "暂时连不上服务，先显示最近缓存结果",
          }
      : {
          tone: "syncing",
          label: connectionState === "syncing" ? "正在同步" : "正在连接",
          detail: connectionState === "syncing" ? "正在同步最新状态" : "正在尝试连接 codex-loop 服务",
        };
  const connectionHint =
    connectionState === "ready"
      ? lastSuccessAt
        ? `最近同步 ${formatTime(lastSuccessAt)}`
        : "已连接"
      : connectionState === "syncing"
        ? "正在同步最新状态"
        : lastSuccessAtRef.current
          ? `暂时连不上服务，先显示 ${formatTime(lastSuccessAtRef.current)} 的最近结果`
          : "暂时还没连上 codex-loop 服务";

  return (
    <main className="mobile-shell">
      <header className="topbar">
        <div>
          <span>codex-loop</span>
          <h1>{loopName}</h1>
          <p>{threadName}</p>
          <div className={`connection-badge is-${connectionBadge.tone}`}>
            <strong>{connectionBadge.label}</strong>
            <span>{connectionBadge.detail}</span>
          </div>
          <p>{connectionHint}</p>
        </div>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            saveDevice(null);
            clearCachedSnapshot();
            setDevice(null);
          }}
        >
          解绑
        </button>
      </header>

      {errorText ? <p className="notice danger">{errorText}</p> : null}
      {connectionState === "degraded" ? (
        <div className="notice warning">
          <div>
          <strong>连接有波动</strong>
          <p>
            {cachedSnapshotLooksStale
              ? "当前缓存结果可能已经落后于任务最新状态，恢复连接后会重新对齐历史和待合并引导。"
              : connectionHint}
          </p>
        </div>
        <button
          type="button"
            className="quiet"
            disabled={submitting}
            onClick={() => void load()}
          >
            立即重试
          </button>
        </div>
      ) : null}
      <GuidanceFeedback message={guidanceFeedback} tone={guidanceFeedbackTone} />
      <StatusBlock
        mobileView={mobileView}
        productionStatus={productionStatus}
        productionPreflight={productionPreflight}
        statusText={statusText}
      />
      <Conversation mobileView={mobileView} refreshNotice={conversationRefreshNotice} />
      <PendingGuidance
        pending={mobileView?.pendingGuidance}
        disabled={submitting || showingCachedSnapshot}
        onEdit={() => {
          setGuidance(mobileView?.pendingGuidance?.text || "");
          setEditing(true);
        }}
        onClear={() => void clearGuidance()}
      />
      <GuidanceComposer
        value={guidance}
        setValue={setGuidance}
        editing={editing}
        submitting={submitting}
        disabled={showingCachedSnapshot}
        onCancel={() => {
          setGuidance("");
          setEditing(false);
        }}
        onSubmit={submitGuidance}
      />
    </main>
  );
}

function registerMobileServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/mobile-app/mobile-sw.js").catch(() => {
      // 手机 App 壳增强失败时保持网页可用，不把安装能力变成主链路阻塞项。
    });
  });
}

registerMobileServiceWorker();
createRoot(document.getElementById("root")).render(<TaskMonitorApp />);
