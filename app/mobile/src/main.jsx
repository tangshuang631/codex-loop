import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

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

function compactText(value, length = 180) {
  const text = asText(value).replace(/\s+/g, " ");
  if (text.length <= length) return text;
  return `${text.slice(0, length - 1)}…`;
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

function StatusBlock({ mobileView, statusText }) {
  const process = mobileView?.processStatus || {};
  const rows = [
    ["当前状态", process.monitorLabel || mobileView?.loop?.modeLabel || "监控中"],
    ["下一步", process.nextAction || mobileView?.suggestedAction || "等待下一轮更新"],
    ["最近指令", process.latestInstructionSourceLabel || "等待生成"],
  ];
  const details = [
    ["等待原因", process.holdReason],
    ["待合并引导", process.pendingGuidancePreview || mobileView?.pendingGuidance?.preview],
    ["独立验收", process.supervisorVerificationLabel || process.supervisorVerificationStatus],
    ["验收动作", process.supervisorVerificationAction],
    ["模型来源", process.latestInstructionSourceDetail],
  ].filter(([, value]) => asText(value));

  return (
    <section className="status-block">
      <div className="status-head">
        <span>{statusText}</span>
        <strong>{process.headline || mobileView?.summary?.recentSummary || "正在同步任务状态"}</strong>
      </div>
      {rows.map(([label, value]) => (
        <div className="status-row" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
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

function Conversation({ mobileView }) {
  const entries = useMemo(() => buildConversation(mobileView), [mobileView]);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [entries.length]);

  if (!entries.length) {
    return <section className="empty">还没有历史对话。绑定任务后，这里会显示 Codex 回复和 codex-loop 发出的指令。</section>;
  }

  return (
    <section className="conversation" aria-label="历史对话">
      <h2>历史对话</h2>
      {entries.map((entry, index) => {
        const isLoop = entry.role === "user";
        const text = asText(entry.text || entry.summary || entry.preview);
        return (
          <article className={isLoop ? "message is-loop" : "message is-codex"} key={`${entry.at || index}-${entry.role}-${index}`}>
            <details open={index >= entries.length - 2}>
              <summary>
                <span>{formatTime(entry.at)} · {isLoop ? "codex-loop" : "Codex"}</span>
                <strong>{compactText(entry.preview || text, isLoop ? 120 : 220)}</strong>
              </summary>
              <pre>{text}</pre>
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
        <strong>{pending.preview || pending.text}</strong>
        <p>会等 Codex 完成后合并，不会打断当前任务。</p>
      </div>
      <div className="mini-actions">
        <button type="button" disabled={disabled} onClick={onEdit} aria-label="编辑待合并引导">
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
  const [statusText, setStatusText] = useState("正在连接");
  const [errorText, setErrorText] = useState("");
  const [guidance, setGuidance] = useState("");
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function load({ silent = false } = {}) {
    if (!device?.deviceId || !device?.deviceToken) return;
    if (!silent) setStatusText("正在同步");
    try {
      const result = await requestJson("/mobile/view", {
        method: "POST",
        body: JSON.stringify({
          deviceId: device.deviceId,
          deviceToken: device.deviceToken,
        }),
      });
      setMobileView(result.mobile);
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
      setStatusText(result.message || "已保存补充引导");
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
      setStatusText(result.message || "已撤回待合并引导");
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
      <StatusBlock mobileView={mobileView} statusText={statusText} />
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

createRoot(document.getElementById("root")).render(<TaskMonitorApp />);
