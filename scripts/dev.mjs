import { spawn } from "node:child_process";
import { findAvailablePort, normalizePort } from "../app/server/lib/network.mjs";

function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  child.on("error", (error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });

  child.on("exit", (code) => {
    if (code && code !== 0) {
      process.exitCode = code;
    }
  });

  return child;
}

async function main() {
  const host = process.env.CODEX_LOOP_HOST || "127.0.0.1";
  const preferredPort = normalizePort(process.env.CODEX_LOOP_PORT, 4318);
  const webPort = normalizePort(process.env.CODEX_LOOP_WEB_PORT, 4173);
  const apiPort = await findAvailablePort(host, preferredPort, 20);

  const server = run("node", ["app/server/index.mjs"], {
    CODEX_LOOP_HOST: host,
    CODEX_LOOP_PORT: String(apiPort),
  });

  const web = run("vite", ["--config", "app/web/vite.config.mjs", "--port", String(webPort)], {
    VITE_CODEX_LOOP_API_BASE: `http://${host}:${apiPort}/api`,
  });

  function shutdown() {
    server.kill();
    web.kill();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
