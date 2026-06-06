import path from "node:path";
import { spawn } from "node:child_process";
import { findAvailablePortPair, normalizePort } from "../app/server/lib/network.mjs";

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
  const preferredPort = normalizePort(process.env.CODEX_LOOP_PORT, 3000);
  const preferredWebPort = normalizePort(process.env.CODEX_LOOP_WEB_PORT, 3001);
  const { apiPort, webPort } = await findAvailablePortPair(host, {
    apiPreferredPort: preferredPort,
    webPreferredPort: preferredWebPort,
    attempts: 50,
  });

  const server = run("node", ["app/server/index.mjs"], {
    CODEX_LOOP_HOST: host,
    CODEX_LOOP_PORT: String(apiPort),
  });

  const viteEntry = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
  const web = run("node", [viteEntry, "--config", "app/web/vite.config.mjs", "--host", host, "--port", String(webPort)], {
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
