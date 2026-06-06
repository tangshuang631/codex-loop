import { exportLoopSummary } from "../app/server/lib/runtime-store.mjs";

async function main() {
  const summary = await exportLoopSummary(process.cwd());
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
