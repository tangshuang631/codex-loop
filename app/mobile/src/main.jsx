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
const POLL_MS = 8000;
const API_BASE = (import.meta.env.VITE_CODEX_LOOP_API_BASE || "/api").replace(/\/$/, "");

function apiUrl(path) {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

async function requestJson(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || data.message || "请求失败，请稍后重试。");
  }
  return data;
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

function shortThreadId(threadId = "") {
  const value = asText(threadId);
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
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
  const [payload, setPayload] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const parsed = parsePairingText(payload);
  const finalSessionId = sessionId || parsed.sessionId || "";
  const finalPairingCode = pairingCode || parsed.pairingCode || "";

  async function confirmPairing() {
    if (!finalSessionId || !finalPairingCode) {
      setMessage("请粘贴桌面端扫码内容，或手动输入配对会话和配对码。");
      return;
    }

    setSubmitting(true);
    setMessage("");
    try {
      const result = await requestJson("/device-pairing/confirm", {
        method: "POST",
        body: JSON.stringify({
          sessionId: finalSessionId,
          pairingCode: finalPairingCode,
          deviceName: "手机监控",
        }),
      });
      const device = {
        deviceId: result.device?.id,
        deviceToken: result.deviceToken,
        deviceName: result.device?.name || "手机监控",
      };
      saveDevice(device);
      onPaired(device);
    } catch (error) {
      setMessage(error.message || "绑定失败，请重新扫码。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mobile-shell pairing-shell">
      <section className="hero">
        <span>codex-loop</span>
        <h1>绑定这台电脑</h1>
        <p>扫码长期绑定后，手机就能查看任务进程、历史对话，并发送下一轮引导。</p>
      </section>

      <section className="pairing-panel">
        <label>
          <span>扫码内容</span>
          <textarea
            value={payload}
            rows={5}
            placeholder="粘贴桌面端二维码内容，例如 codex-loop://pair?sessionId=...&code=..."
            onChange={(event) => setPayload(event.target.value)}
          />
        </label>
        <div className="pairing-grid">
          <label>
            <span>配对会话</span>
            <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
          </label>
          <label>
            <span>配对码</span>
            <input value={pairingCode} onChange={(event) => setPairingCode(event.target.value)} />
          </label>
        </div>
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
  const closedLoopProgress = Math.min(100, Math.round((closedLoopCount / closedLoopTarget) * 100));
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
          ? "需留意"
          : "";
  const productionDetail =
    productionObservation?.status === "stale"
      ? productionStatus?.nextAction ||
        "真实运行观测已过期，请重新运行 npm run production:observe，或重新启动一次真实任务生成新的运行记录。"
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
    productionStatus ? ["longrun", longRunDecision] : null,
    ["当前状态", process.monitorLabel || mobileView?.loop?.modeLabel || "监控中"],
    ["下一步", process.nextAction || mobileView?.suggestedAction || "等待下一轮更新"],
    productionFocus.summary ? ["生产判断", productionFocus.summary] : null,
    modelPipeline.headline ? ["模型链路", modelPipeline.headline] : null,
    productionTarget ? ["验证目标", productionTarget] : null,
    productionPreflight ? ["启动预检", `${preflightLabel} · ${preflightDetail}`] : null,
    productionStatus ? ["生产阶段", `${maturityLabel} · ${productionStageSummary}`] : null,
    productionStatus ? ["生产观测", `${productionLabel} · ${productionObservationSummary}`] : null,
    ["最近指令", process.latestInstructionSourceLabel || "等待生成"],
  ].filter(Boolean);
  const details = [
    productionFocus.attention ? ["当前要留意", productionFocus.attention] : null,
    productionFocus.nextAction ? ["生产建议", productionFocus.nextAction] : null,
    modelPipeline.detail ? ["模型说明", modelPipeline.detail] : null,
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
          `${guidanceEvidenceCount}/${guidanceEvidenceTarget} · ${guidanceEvidenceText}。${guidanceEvidence.summary || "确认用户补充引导会等 Codex 完成后由本地模型 / NPC 合并。"}`,
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
          "NPC 视角",
          process.supervisorPerspectiveRows
            .map((row) => `${row.label}：${row.text}`)
            .join("；"),
        ]
      : null,
    process.supervisorVerificationAction ? ["验收动作", process.supervisorVerificationAction] : null,
    process.supervisorVerificationEvidencePreview || process.supervisorVerificationEvidenceCount
      ? [
          "截图证据",
          process.supervisorVerificationEvidencePreview ||
            `${process.supervisorVerificationEvidenceCount} 个截图证据`,
        ]
      : null,
    process.latestInstructionSourceDetail ? ["模型来源", process.latestInstructionSourceDetail] : null,
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
          <strong>{statusHero.headline}</strong>
          <p>{statusHero.detail}</p>
        </div>
        <div className="status-hero-block">
          <span>你下一步该做什么</span>
          <strong>{statusHero.nextAction}</strong>
        </div>
      </div>
      <div className="status-head">
        <span>{statusText}</span>
        <strong>{process.headline || mobileView?.summary?.recentSummary || "正在同步任务状态"}</strong>
      </div>
      {rows.map(([label, value]) => (
        <div className="status-row" key={label}>
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
      {details.length ? (
        <details className="status-detail">
          <summary>状态细节</summary>
          <div className="status-detail-grid">
            {details.map(([label, value]) => (
              <div className="status-detail-row" key={label}>
                <span>{label}</span>
                <strong>{compactText(value, 150)}</strong>
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

function Conversation({ mobileView }) {
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
        <p>{pending.statusDetail || pending.userMessage || "会等 Codex 完成后交给本地模型 / NPC 合并，不会打断当前任务。"}</p>
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

function GuidanceComposer({ value, setValue, editing, submitting, onCancel, onSubmit }) {
  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        value={value}
        rows={3}
        placeholder="补充你要说的话，等 Codex 完成后合并，会等 Codex 当前任务完成再发送"
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="composer-actions">
        {editing ? (
          <button type="button" className="quiet" disabled={submitting} onClick={onCancel}>
            取消
          </button>
        ) : null}
        <button type="submit" disabled={submitting || !value.trim()}>
          {editing ? "保存修改" : "发送引导"}
        </button>
      </div>
    </form>
  );
}

function TaskMonitorApp() {
  const [device, setDevice] = useState(readDevice);
  const [mobileView, setMobileView] = useState(null);
  const [productionStatus, setProductionStatus] = useState(null);
  const [productionPreflight, setProductionPreflight] = useState(null);
  const [statusText, setStatusText] = useState("正在连接");
  const [errorText, setErrorText] = useState("");
  const [guidance, setGuidance] = useState("");
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function load({ silent = false } = {}) {
    if (!device?.deviceId || !device?.deviceToken) return;
    if (!silent) setStatusText("正在同步");
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
    } catch (error) {
      setErrorText(error.message || "同步失败，请重新扫码。");
      setStatusText("连接失效");
      if (/设备未绑定|令牌|重新扫码/.test(error.message || "")) {
        saveDevice(null);
        setDevice(null);
      }
    }
  }

  useEffect(() => {
    void load();
  }, [device?.deviceId, device?.deviceToken]);

  useEffect(() => {
    if (!device?.deviceId || !device?.deviceToken) return undefined;
    const timer = window.setInterval(() => void load({ silent: true }), POLL_MS);
    return () => window.clearInterval(timer);
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

  return (
    <main className="mobile-shell">
      <header className="topbar">
        <div>
          <span>codex-loop</span>
          <h1>{loopName}</h1>
          <p>{threadName}</p>
        </div>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            saveDevice(null);
            setDevice(null);
          }}
        >
          解绑
        </button>
      </header>

      {errorText ? <p className="notice danger">{errorText}</p> : null}
      <StatusBlock
        mobileView={mobileView}
        productionStatus={productionStatus}
        productionPreflight={productionPreflight}
        statusText={statusText}
      />
      <Conversation mobileView={mobileView} />
      <PendingGuidance
        pending={mobileView?.pendingGuidance}
        disabled={submitting}
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
