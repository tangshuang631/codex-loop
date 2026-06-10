import { fileURLToPath } from "node:url";
import path from "node:path";

import { readProductionStatusSummary as defaultReadProductionStatusSummary } from "./production-status.mjs";

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function findSection(status, label) {
  return (status.sections || []).find((section) => section.label === label) || {};
}

function formatTarget(target = {}) {
  return [
    text(target.threadTitle || target.workspaceName || target.runId, "当前任务"),
    text(target.workspaceRoot),
    text(target.threadId),
  ].filter(Boolean).join(" / ");
}

function buildEvidence(status) {
  const codeGateLabels = ["最近生产检查", "前端证据", "长跑节奏"];
  const evidence = [];
  const gatesPassed = codeGateLabels.every((label) => findSection(status, label).status === "passed");
  evidence.push(gatesPassed ? "代码闸门已通过。" : "代码闸门还没有全部通过。");

  const observation = findSection(status, "真实运行观测");
  if (status.readiness?.stage === "production") {
    evidence.push("真实运行已具备 2 轮闭环证据。");
  } else if (needsSupervisorRecovery(status)) {
    evidence.push("Codex 已有完成回复，但还缺少 NPC 监督复盘；请先运行 npm run production:recover 补齐监督复盘。");
  } else if (/1 轮/u.test(`${observation.summary || ""}\n${status.readiness?.summary || ""}`)) {
    evidence.push("真实运行已经观察到 1 轮闭环，还缺少第 2 轮连续闭环证据。");
  } else {
    evidence.push(observation.summary || "真实运行观测还不足。");
  }

  return evidence;
}

function needsSupervisorRecovery(status = {}) {
  const observation = findSection(status, "真实运行观测");
  const textBlock = [
    status.nextAction,
    status.readiness?.nextAction,
    status.readiness?.summary,
    observation.summary,
    observation.nextAction,
  ].filter(Boolean).join("\n");
  return /缺少\s*NPC\s*监督复盘|补齐监督复盘|production:recover/u.test(textBlock);
}

function derivePreflightStatus(status) {
  const stage = status.readiness?.stage || "";
  if (needsSupervisorRecovery(status)) return { status: "blocked", canDispatch: false };
  if (stage === "production") return { status: "ready", canDispatch: true };
  if (stage === "trial") return { status: "ready_with_attention", canDispatch: true };
  if (stage === "observing") return { status: "waiting", canDispatch: false };
  return { status: "blocked", canDispatch: false };
}

function isCurrentCodexThreadTarget(target = {}, currentCodexThreadId = "") {
  const targetThreadId = text(target.threadId);
  const currentThreadId = text(currentCodexThreadId);
  return Boolean(targetThreadId && currentThreadId && targetThreadId === currentThreadId);
}

export async function readProductionPreflightSummary({
  readProductionStatusSummary = defaultReadProductionStatusSummary,
  currentCodexThreadId = process.env.CODEX_THREAD_ID || "",
  now = new Date(),
} = {}) {
  const status = await readProductionStatusSummary({ now });
  const selfTarget = isCurrentCodexThreadTarget(status.target || {}, currentCodexThreadId);
  const decision = selfTarget
    ? { status: "blocked", canDispatch: false }
    : derivePreflightStatus(status);
  const targetLabel = formatTarget(status.target || {});
  const evidence = buildEvidence(status);
  if (selfTarget) {
    evidence.push("不能把当前线程作为目标，否则 codex-loop 会给自己发送循环指令。");
  }
  const stage = status.readiness?.stage || "";
  const targetAction = targetLabel
    ? `确认当前验证目标：${targetLabel}。`
    : "先确认当前验证目标。";
  const selfTargetSummary =
    "目标线程是当前 codex-loop 自己所在的 Codex 线程，不能启动真实循环。";
  const selfTargetNextAction =
    "请绑定另一个可见 Codex 窗口作为目标线程，再重新运行预检。";
  const supervisorRecovery = needsSupervisorRecovery(status);
  const recoverySummary =
    "Codex 已有完成回复，但还缺少 NPC 监督复盘，不能继续发送下一轮。";
  const recoveryNextAction =
    "请先运行 npm run production:recover 补齐监督复盘；该命令不会发送下一轮指令。";

  return {
    title: "codex-loop 真实循环前预检",
    status: decision.status,
    canDispatch: decision.canDispatch,
    generatedAt: now.toISOString(),
    target: status.target || {},
    readiness: status.readiness || {},
    summary:
      selfTarget
        ? selfTargetSummary
        : supervisorRecovery
          ? recoverySummary
        : stage === "production"
        ? "已具备长期运行基本证据，可以在人工观察下继续运行。"
        : stage === "trial"
          ? "代码闸门已通过，可以短时试用；继续前必须确认目标，并补齐第 2 轮真实闭环证据。"
          : stage === "observing"
            ? "真实任务仍在观察中，暂时不要重复发送下一轮。"
            : "预检未通过，暂不建议启动真实循环。",
    nextAction: selfTarget
      ? selfTargetNextAction
      : supervisorRecovery
        ? recoveryNextAction
      : decision.canDispatch
      ? `${targetAction}再启动真实任务，观察发送、Codex 完成和 NPC 复盘是否连续出现。`
      : status.nextAction || status.readiness?.nextAction || "先处理预检提示后再继续。",
    evidence,
    sourceStatus: status.status,
  };
}

async function main() {
  const report = await readProductionPreflightSummary();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.canDispatch) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
