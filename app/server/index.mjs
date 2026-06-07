import http from "node:http";

import { findAvailablePort, normalizePort } from "./lib/network.mjs";
import { buildHandler } from "./server.mjs";

const host = (process.env.CODEX_LOOP_HOST || "127.0.0.1").trim();
const preferredPort = normalizePort(process.env.CODEX_LOOP_PORT, 3000);
const hasExplicitPort = Boolean(process.env.CODEX_LOOP_PORT);
const shutdownToken = process.env.CODEX_LOOP_SHUTDOWN_TOKEN || "";

async function main() {
  const port = await findAvailablePort(host, preferredPort, 20, {
    strict: hasExplicitPort,
  });
  const server = http.createServer(buildHandler({ shutdownToken }));

  server.on("error", (error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    process.stdout.write(
      `codex_loop server listening on http://${host}:${port}\n`,
    );
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
