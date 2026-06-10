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
  } else if (/1 轮/u.test(`${observation.summary || ""}\n${status.readiness?.summary || ""}`)) {
    evidence.push("真实运行已经观察到 1 轮闭环，还缺少第 2 轮连续闭环证据。");
  } else {
    evidence.push(observation.summary || "真实运行观测还不足。");
  }

  return evidence;
}

function derivePreflightStatus(status) {
  const stage = status.readiness?.stage || "";
  if (stage === "production") return { status: "ready", canDispatch: true };
  if (stage === "trial") return { status: "ready_with_attention", canDispatch: true };
  if (stage === "observing") return { status: "waiting", canDispatch: false };
  return { status: "blocked", canDispatch: false };
}

export async function readProductionPreflightSummary({
  readProductionStatusSummary = defaultReadProductionStatusSummary,
  now = new Date(),
} = {}) {
  const status = await readProductionStatusSummary({ now });
  const decision = derivePreflightStatus(status);
  const targetLabel = formatTarget(status.target || {});
  const evidence = buildEvidence(status);
  const stage = status.readiness?.stage || "";
  const targetAction = targetLabel
    ? `确认当前验证目标：${targetLabel}。`
    : "先确认当前验证目标。";

  return {
    title: "codex-loop 真实循环前预检",
    status: decision.status,
    canDispatch: decision.canDispatch,
    generatedAt: now.toISOString(),
    target: status.target || {},
    readiness: status.readiness || {},
    summary:
      stage === "production"
        ? "已具备长期运行基本证据，可以在人工观察下继续运行。"
        : stage === "trial"
          ? "代码闸门已通过，可以短时试用；继续前必须确认目标，并补齐第 2 轮真实闭环证据。"
          : stage === "observing"
            ? "真实任务仍在观察中，暂时不要重复发送下一轮。"
            : "预检未通过，暂不建议启动真实循环。",
    nextAction: decision.canDispatch
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
