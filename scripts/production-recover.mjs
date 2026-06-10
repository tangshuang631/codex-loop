import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ensureSupervisorReview,
  syncCodexThreadMirror,
} from "../app/server/lib/runtime-store.mjs";
import { buildProductionObservation } from "./production-observer.mjs";

function buildResult(snapshot) {
  return {
    title: "codex-loop 生产恢复",
    status: snapshot.reviewed ? "recovered" : "skipped",
    reviewed: Boolean(snapshot.reviewed),
    reason: snapshot.reason || "",
    safety: "本命令只补齐监督复盘，不会发送下一轮指令。",
    thread: {
      threadId: snapshot.thread?.threadId || "",
      threadTitle: snapshot.thread?.threadTitle || "",
      latestEventType: snapshot.thread?.latestEventType || "",
      lastSupervisorSource: snapshot.thread?.lastSupervisorSource || "",
      lastSupervisorReviewAt: snapshot.thread?.lastSupervisorReviewAt || "",
    },
    nextAction: snapshot.reviewed
      ? "请重新运行 npm run production:status，确认真实运行观测是否已恢复到可继续状态。"
      : "当前没有需要补复盘的完成结果；如状态仍异常，请查看 npm run production:observe 输出。",
  };
}

function findRecoveredCompletion(observation = {}) {
  const timeline = Array.isArray(observation.timeline) ? observation.timeline : [];
  const recovered = timeline.findLast((event) =>
    event?.type === "codex_followup_completed" &&
    event?.recoveredFromTimeout &&
    String(event?.detail || "").trim(),
  );
  if (recovered) {
    return {
      latestCodexSummary: String(recovered.detail || "").trim(),
      latestAssistantAt: recovered.at || "",
    };
  }

  return null;
}

export async function runProductionRecovery(
  startDir = process.cwd(),
  {
    ensureSupervisorReview: ensureReview = ensureSupervisorReview,
    buildProductionObservation: buildObservation = buildProductionObservation,
    syncCodexThreadMirror: syncThreadMirror = syncCodexThreadMirror,
  } = {},
) {
  const firstAttempt = await ensureReview(startDir);
  if (firstAttempt.reviewed) {
    return buildResult(firstAttempt);
  }

  const observation = await buildObservation({ root: startDir });
  const recoveredCompletion = findRecoveredCompletion(observation);
  if (!recoveredCompletion) {
    return buildResult(firstAttempt);
  }

  await syncThreadMirror(startDir, {
    ...recoveredCompletion,
    forceCompletion: true,
  });
  return buildResult(await ensureReview(startDir));
}

async function main() {
  const result = await runProductionRecovery(process.cwd());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
