import path from "node:path";

import { scaffoldProjectAdapter } from "./lib/scaffold-project.mjs";
import { resolveWorkspaceAndLoopRoot } from "./lib/workspace-context.mjs";

async function main() {
  const { workspaceRoot, codexLoopRoot } = await resolveWorkspaceAndLoopRoot(
    process.cwd(),
  );
  const adapterId = process.env.CODEX_LOOP_ADAPTER_ID || path.basename(workspaceRoot);
  const displayName = process.env.CODEX_LOOP_DISPLAY_NAME || adapterId;

  const result = await scaffoldProjectAdapter({
    workspaceRoot,
    codexLoopRoot,
    adapterId,
    displayName,
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
