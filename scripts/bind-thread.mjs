import path from "node:path";

import { saveThreadBinding } from "../app/server/lib/runtime-store.mjs";
import { resolveWorkspaceAndLoopRoot } from "./lib/workspace-context.mjs";

async function main() {
  const { workspaceRoot } = await resolveWorkspaceAndLoopRoot(process.cwd());
  const workspaceName =
    process.env.CODEX_LOOP_WORKSPACE_NAME || path.basename(workspaceRoot);
  const threadTitle = process.env.CODEX_LOOP_THREAD_TITLE || "未绑定线程";
  const threadId = process.env.CODEX_LOOP_THREAD_ID || "";
  const note = process.env.CODEX_LOOP_THREAD_NOTE || "";
  const heartbeatAutomation = process.env.CODEX_LOOP_HEARTBEAT_ID || "";
  const singleThreadMode =
    String(process.env.CODEX_LOOP_SINGLE_THREAD || "true").toLowerCase() !==
    "false";

  const snapshot = await saveThreadBinding(workspaceRoot, {
    workspaceName,
    threadTitle,
    threadId,
    note,
    heartbeatAutomation,
    singleThreadMode,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        threadId: snapshot.thread.threadId,
        threadTitle: snapshot.thread.threadTitle,
        workspaceName: snapshot.thread.workspaceName,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
