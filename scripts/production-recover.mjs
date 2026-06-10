import { fileURLToPath } from "node:url";
import path from "node:path";

import { ensureSupervisorReview } from "../app/server/lib/runtime-store.mjs";

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

async function main() {
  const recovered = await ensureSupervisorReview(process.cwd());
  const result = buildResult(recovered);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
