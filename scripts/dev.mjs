import path from "node:path";
import { spawn } from "node:child_process";
import { findAvailablePortPair, normalizePort } from "../app/server/lib/network.mjs";
import { writeLauncherStatus } from "../app/server/lib/launcher-status.mjs";

function run(command, args, extraEnv = {}, handlers = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    handlers.onStdout?.(chunk.toString("utf8"));
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    handlers.onStderr?.(chunk.toString("utf8"));
  });

  child.on("error", (error) => {
    handlers.onError?.(error);
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });

  child.on("exit", (code) => {
    handlers.onExit?.(code);
    if (code && code !== 0) {
      process.exitCode = code;
    }
  });

  return child;
}

async function main() {
  const host = (process.env.CODEX_LOOP_HOST || "127.0.0.1").trim();
  const preferredPort = normalizePort(process.env.CODEX_LOOP_PORT, 3000);
  const preferredWebPort = normalizePort(process.env.CODEX_LOOP_WEB_PORT, 3001);
  let apiPort = preferredPort;
  let webPort = preferredWebPort;
  try {
    const resolvedPorts = await findAvailablePortPair(host, {
      apiPreferredPort: preferredPort,
      webPreferredPort: preferredWebPort,
      attempts: 50,
    });
    apiPort = resolvedPorts.apiPort;
    webPort = resolvedPorts.webPort;
  } catch (error) {
    await writeLauncherStatus(process.cwd(), {
      phase: "failed",
      host,
      apiPort: preferredPort,
      webPort: preferredWebPort,
      apiBaseUrl: `http://${host}:${preferredPort}/api`,
      webUrl: `http://${host}:${preferredWebPort}`,
      serverReady: false,
      webReady: false,
      note: "本地端口不可用，开发控制台未能启动。",
      error: error.message,
    });
    throw error;
  }
  const apiBaseUrl = `http://${host}:${apiPort}/api`;
  const webUrl = `http://${host}:${webPort}`;
  let serverReady = false;
  let webReady = false;
  let shuttingDown = false;

  async function syncLauncherStatus(patch = {}) {
    await writeLauncherStatus(process.cwd(), {
      host,
      apiPort,
      webPort,
      apiBaseUrl,
      webUrl,
      shuttingDown: false,
      shutdownRequestedAt: "",
      shutdownReason: "",
      serverReady,
      webReady,
      ...patch,
    });
  }

  await syncLauncherStatus({
    phase: "starting",
    launcherPid: process.pid,
    note: "正在启动 codex-loop 控制台。",
  });

  async function markReadyPhase() {
    if (serverReady && webReady) {
      await syncLauncherStatus({
        phase: "ready",
        note: "前后端已就绪，可以开始查看和控制循环。",
        error: "",
      });
      return;
    }

    if (serverReady) {
      await syncLauncherStatus({
        phase: "server_ready",
        note: "后端已启动，正在等待前端控制台就绪。",
        error: "",
      });
      return;
    }

    if (webReady) {
      await syncLauncherStatus({
        phase: "web_ready",
        note: "前端已启动，正在等待后端服务就绪。",
        error: "",
      });
    }
  }

  const server = run("node", ["app/server/index.mjs"], {
    CODEX_LOOP_HOST: host,
    CODEX_LOOP_PORT: String(apiPort),
  }, {
    onStdout(text) {
      if (text.includes("codex_loop server listening on")) {
        serverReady = true;
        void markReadyPhase();
      }
    },
    onError(error) {
      void syncLauncherStatus({
        phase: "failed",
        note: "后端服务启动失败。",
        error: error.message,
      });
    },
    onExit(code) {
      if (shuttingDown) {
        return;
      }
      void syncLauncherStatus({
        phase: "failed",
        note: "后端服务已退出。",
        error: code ? `server exited with code ${code}` : "server exited unexpectedly",
      });
    },
  });

  await syncLauncherStatus({
    phase: "starting",
    launcherPid: process.pid,
    serverPid: server.pid || 0,
    note: "正在启动 codex-loop 控制台。",
  });

  const viteEntry = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
  const web = run("node", [viteEntry, "--config", "app/web/vite.config.mjs", "--host", host, "--port", String(webPort)], {
    VITE_CODEX_LOOP_API_BASE: apiBaseUrl,
  }, {
    onStdout(text) {
      if (text.includes("Local:") || /ready in .*ms/i.test(text)) {
        webReady = true;
        void markReadyPhase();
      }
    },
    onError(error) {
      void syncLauncherStatus({
        phase: "failed",
        note: "前端控制台启动失败。",
        error: error.message,
      });
    },
    onExit(code) {
      if (shuttingDown) {
        return;
      }
      void syncLauncherStatus({
        phase: "failed",
        note: "前端控制台已退出。",
        error: code ? `web exited with code ${code}` : "web exited unexpectedly",
      });
    },
  });

  await syncLauncherStatus({
    phase: "starting",
    launcherPid: process.pid,
    serverPid: server.pid || 0,
    webPid: web.pid || 0,
    note: "正在启动 codex-loop 控制台。",
  });

  function shutdown() {
    shuttingDown = true;
    void syncLauncherStatus({
      phase: "stopped",
      launcherPid: process.pid,
      serverPid: server.pid || 0,
      webPid: web.pid || 0,
      shuttingDown: false,
      note: "开发控制台已停止。",
      error: "",
    });
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
