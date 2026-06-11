import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLoop,
  createProject,
  deleteLoop,
  exportMobileView,
  exportLoopSummary,
  ensureSupervisorReview,
  getLoopCreationAssistantState,
  goBackLoopCreationAssistant,
  listLoops,
  readLoopSnapshot,
  replyLoopCreationAssistant,
  restartLoopCreationAssistant,
  selectLoop,
  recordHeartbeat,
  recordError,
  renameLoop,
  requestGracefulStop,
  runLoopTurn,
  sendPendingGuidanceOnce,
  clearPendingGuidance,
  savePendingGuidance,
  saveThreadBinding,
  startRun,
  syncCodexThreadMirror,
  updateBudgets,
  updateLoopSupervisor,
} from "./lib/runtime-store.mjs";
import { createLoopController } from "./lib/loop-controller.mjs";
import {
  readLauncherStatus,
  requestLauncherShutdown,
} from "./lib/launcher-status.mjs";
import { readRemoteAccessStatus } from "./lib/remote-access.mjs";
import {
  confirmDevicePairing,
  createDevicePairingSession,
  readDevicePairingStatus,
  revokePairedDevice,
  verifyPairedDevice,
} from "./lib/runtime-governance/device-pairing.mjs";
import { listOllamaModels as defaultListOllamaModels } from "./lib/ollama-model-store.mjs";
import {
  readAutomationStatusForThread,
      updateAutomationIntervalForThread,
} from "./lib/automation-store.mjs";
import { saveUserOverrides } from "./lib/adapter-store.mjs";
import { readProductionStatusSummary } from "../../scripts/production-status.mjs";
import { readProductionPreflightSummary } from "../../scripts/production-preflight.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "../..");
const DEFAULT_MOBILE_APP_DIR = path.join(REPO_ROOT, "dist", "mobile");
const DEFAULT_MOBILE_PUBLIC_DIR = path.join(REPO_ROOT, "app", "mobile", "public");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendText(response, statusCode, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
  });
  response.end(text);
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function resolveInside(rootDir, requestPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, requestPath.replace(/^[/\\]+/u, ""));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return "";
  }
  return target;
}

async function sendFile(response, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = contentTypes.get(ext) || "application/octet-stream";
  const content = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
  });
  response.end(content);
}

async function tryServeMobileApp(request, response, {
  mobileAppDir = DEFAULT_MOBILE_APP_DIR,
  mobilePublicDir = DEFAULT_MOBILE_PUBLIC_DIR,
} = {}) {
  const parsed = new URL(request.url || "/", "http://codex-loop.local");
  const pathname = decodeURIComponent(parsed.pathname);
  if (request.method !== "GET") {
    return false;
  }
  if (pathname !== "/mobile-app" && !pathname.startsWith("/mobile-app/")) {
    return false;
  }

  const relativePath =
    pathname === "/mobile-app" || pathname === "/mobile-app/"
      ? "index.html"
      : pathname.slice("/mobile-app/".length);
  const target = resolveInside(mobileAppDir, relativePath);
  if (target && (await fileExists(target))) {
    await sendFile(response, target);
    return true;
  }

  if (
    relativePath === "icon.svg" ||
    relativePath === "mobile-sw.js" ||
    relativePath === "manifest.webmanifest"
  ) {
    const fallback = resolveInside(mobilePublicDir, relativePath);
    if (fallback && (await fileExists(fallback))) {
      await sendFile(response, fallback);
      return true;
    }
  }

  if (relativePath === "index.html") {
    sendText(
      response,
      503,
      "移动端 App 还没有构建。请先运行 npm run build:mobile，然后重新打开 /mobile-app。",
    );
    return true;
  }

  sendText(response, 404, "Not found");
  return true;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isMobileGuidanceWaitError(error) {
  const message = error?.message || "";
  return (
    message.includes("Codex 正在处理当前轮") ||
    message.includes("本地模型正在复盘")
  );
}

function shouldDispatchMobileGuidanceOnce(snapshot) {
  if (!snapshot?.state) {
    return true;
  }

  return snapshot.state.mode !== "running" || snapshot.state.monitorOnly === true;
}

async function readDispatchPreflight(operations) {
  if (typeof operations.readProductionPreflight !== "function") {
    return { allowed: true, preflight: null, detail: "" };
  }

  const preflight = await operations.readProductionPreflight();
  const allowed = preflight.canDispatch !== false;
  const detail = preflight.nextAction || preflight.summary || "";
  return { allowed, preflight, detail };
}

function pickPendingGuidanceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  if (snapshot.pendingGuidance && typeof snapshot.pendingGuidance === "object") {
    return snapshot.pendingGuidance;
  }

  return null;
}

function buildPendingGuidanceResponse(snapshot, overrides = {}) {
  const pendingGuidance = pickPendingGuidanceSnapshot(snapshot);
  if (!pendingGuidance) {
    return null;
  }

  return {
    ...pendingGuidance,
    ...overrides,
  };
}

function blockedDispatchPayload({ preflight, detail, action = "发送下一轮" } = {}) {
  return {
    error: detail
      ? `暂不建议${action}：${detail}`
      : `暂不建议${action}。`,
    kind: "production_preflight_blocked",
    preflight,
  };
}

export function buildHandler({
  loopController = createLoopController(),
  mobileAppDir = DEFAULT_MOBILE_APP_DIR,
  mobilePublicDir = DEFAULT_MOBILE_PUBLIC_DIR,
  operations = {
      readLoopSnapshot,
      exportLoopSummary,
      exportMobileView,
      readLauncherStatus,
      listOllamaModels: async (startDir = process.cwd()) => {
        const snapshot = await readLoopSnapshot(startDir);
        const baseUrl =
          snapshot.profile?.resolved?.conversation?.promptGenerator?.baseUrl ||
          "http://127.0.0.1:11434";
        return defaultListOllamaModels({ baseUrl });
      },
      readRemoteAccessStatus: async () => {
        const launcherStatus = await readLauncherStatus();
        return readRemoteAccessStatus({
          launcherStatus,
          readPairingStatus: () => readDevicePairingStatus(process.cwd()),
        });
      },
      readDevicePairingStatus,
      createDevicePairingSession,
      confirmDevicePairing,
      revokePairedDevice,
      verifyPairedDevice,
      readAutomationStatus: async (startDir = process.cwd()) => {
        const snapshot = await readLoopSnapshot(startDir);
        return readAutomationStatusForThread(snapshot.thread);
      },
      readProductionStatus: readProductionStatusSummary,
      readProductionPreflight: readProductionPreflightSummary,
      shutdownLauncher: async (startDir = process.cwd(), payload = {}) => {
        const snapshot = await readLoopSnapshot(startDir);
        const activeLoopRunning =
          snapshot.state?.mode === "running" &&
          !snapshot.state?.stopRequested &&
          !snapshot.state?.finalizeRequested;

        let gracefulStop = null;
        if (payload.force !== true && activeLoopRunning) {
          gracefulStop = await requestGracefulStop(startDir, {
            reason: payload.reason || "launcher shutdown requested",
          });
        }

        const shutdown = await requestLauncherShutdown(startDir, {
          reason: payload.reason || "launcher shutdown requested",
          note: activeLoopRunning
            ? "已请求当前任务先优雅停止，随后关闭 codex-loop。"
            : "正在关闭 codex-loop 控制台。",
          delayMs: activeLoopRunning ? 900 : 350,
        });

        return {
          ok: true,
          activeLoopRunning,
          gracefulStop,
          shutdown,
        };
      },
      updateAutomationSettings: async (startDir = process.cwd(), payload = {}) => {
        const snapshot = await readLoopSnapshot(startDir);
        const intervalMinutes = Number(payload.intervalMinutes);
        if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
          throw new Error("intervalMinutes must be a positive number");
        }
        return updateAutomationIntervalForThread(snapshot.thread, intervalMinutes);
      },
      startRun,
      renameLoop,
      listLoops,
      createLoop,
      createProject,
      getLoopCreationAssistantState,
      goBackLoopCreationAssistant,
      restartLoopCreationAssistant,
      selectLoop,
      deleteLoop,
      replyLoopCreationAssistant,
      requestGracefulStop,
      runLoopTurn,
      sendPendingGuidanceOnce,
      ensureSupervisorReview,
      clearPendingGuidance,
      savePendingGuidance,
      updateBudgets,
      updateLoopSupervisor,
      saveThreadBinding,
      syncCodexThreadMirror,
      recordHeartbeat,
      recordError,
      saveUserOverrides,
  },
} = {}) {
  return async function handler(request, response) {
    if (!request.url) {
      sendJson(response, 400, { error: "Missing request URL" });
      return;
    }

    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    try {
      if (
        await tryServeMobileApp(request, response, {
          mobileAppDir,
          mobilePublicDir,
        })
      ) {
        return;
      }

      if (request.method === "GET" && request.url === "/api/health") {
        const snapshot = await operations.readLoopSnapshot(process.cwd());
        sendJson(response, 200, {
          ok: Boolean(snapshot.health?.ok),
          mode: snapshot.state.mode,
          continuationStatus: snapshot.thread.continuationStatus,
          issues: snapshot.health?.issues || [],
        });
        return;
      }

      if (request.method === "GET" && request.url === "/api/production-status") {
        sendJson(response, 200, await operations.readProductionStatus());
        return;
      }

      if (request.method === "GET" && request.url === "/api/production-preflight") {
        sendJson(response, 200, await operations.readProductionPreflight());
        return;
      }

      if (request.method === "GET" && request.url === "/api/snapshot") {
        sendJson(response, 200, await operations.readLoopSnapshot());
        return;
      }

      if (request.method === "GET" && request.url === "/api/summary") {
        sendJson(response, 200, await operations.exportLoopSummary());
        return;
      }

      if (request.method === "GET" && request.url === "/api/mobile") {
        sendJson(response, 200, await operations.exportMobileView());
        return;
      }

      if (request.method === "POST" && request.url === "/api/mobile/view") {
        const body = await readBody(request);
        const verification = await operations.verifyPairedDevice(process.cwd(), body);
        if (!verification.valid) {
          sendJson(response, 401, {
            valid: false,
            kind: "device_not_paired",
            error: verification.reason || "设备未绑定或令牌已失效，请重新扫码。",
          });
          return;
        }

        sendJson(response, 200, {
          valid: true,
          device: verification.device,
          mobile: await operations.exportMobileView(process.cwd()),
        });
        return;
      }

      if (request.method === "POST" && request.url === "/api/mobile/guidance") {
        const body = await readBody(request);
        const verification = await operations.verifyPairedDevice(process.cwd(), body);
        if (!verification.valid) {
          sendJson(response, 401, {
            valid: false,
            kind: "device_not_paired",
            error: verification.reason || "设备未绑定或令牌已失效，请重新扫码。",
          });
          return;
        }

        const result = await operations.savePendingGuidance(process.cwd(), {
          text: body.text,
          replace: body.replace === true,
          source: "mobile",
          deviceId: body.deviceId,
        });

        let dispatch = "queued";
        let dispatchResult = null;
        let pendingGuidance = buildPendingGuidanceResponse(result);
        let dispatchMessage = "已保存补充引导，会等 Codex 完成后合并。";

        const latestSnapshot =
          typeof operations.readLoopSnapshot === "function"
            ? await operations.readLoopSnapshot(process.cwd())
            : null;

        if (shouldDispatchMobileGuidanceOnce(latestSnapshot)) {
          const preflight = await readDispatchPreflight(operations);
          if (!preflight.allowed) {
            dispatchMessage = preflight.detail
              ? `已保存补充引导；${preflight.detail}`
              : "已保存补充引导；当前预检不建议发送下一轮。";
            sendJson(response, 200, {
              valid: true,
              device: verification.device,
              dispatch,
              message: dispatchMessage,
              result,
              pendingGuidance:
                buildPendingGuidanceResponse(latestSnapshot, {
                  userMessage: dispatchMessage,
                }) || pendingGuidance,
              dispatchResult,
              preflight: preflight.preflight,
            });
            return;
          }

          try {
            dispatchResult = await operations.sendPendingGuidanceOnce(process.cwd());
            dispatch = "sent";
            dispatchMessage = "已发送引导，正在等待 Codex 完成当前轮。";
          } catch (error) {
            if (!isMobileGuidanceWaitError(error)) {
              throw error;
            }
            dispatchMessage =
              error?.message ||
              "已保存补充引导；当前不能发送，会等 Codex 可以接收下一轮时再处理。";
          }
        } else {
          dispatchMessage =
            "自动循环正在运行，已保存补充引导，会在下一轮安全时机合并。";
        }

        sendJson(response, 200, {
          valid: true,
          device: verification.device,
          dispatch,
          message: dispatchMessage,
          result,
          pendingGuidance:
            buildPendingGuidanceResponse(latestSnapshot, {
              userMessage: dispatchMessage,
            }) || pendingGuidance,
          dispatchResult,
        });
        return;
      }

      if (request.method === "DELETE" && request.url === "/api/mobile/guidance") {
        const body = await readBody(request);
        const verification = await operations.verifyPairedDevice(process.cwd(), body);
        if (!verification.valid) {
          sendJson(response, 401, {
            valid: false,
            kind: "device_not_paired",
            error: verification.reason || "设备未绑定或令牌已失效，请重新扫码。",
          });
          return;
        }

        sendJson(response, 200, {
          valid: true,
          cleared: true,
          device: verification.device,
          message: "已撤回待合并引导。",
          result: await operations.clearPendingGuidance(process.cwd()),
        });
        return;
      }

      if (request.method === "GET" && request.url === "/api/launcher-status") {
        sendJson(response, 200, await operations.readLauncherStatus());
        return;
      }

      if (request.method === "GET" && request.url === "/api/remote-access") {
        sendJson(response, 200, await operations.readRemoteAccessStatus());
        return;
      }

      if (request.method === "GET" && request.url === "/api/device-pairing") {
        sendJson(
          response,
          200,
          await operations.readDevicePairingStatus(process.cwd()),
        );
        return;
      }

      if (
        request.method === "POST" &&
        request.url === "/api/device-pairing/session"
      ) {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.createDevicePairingSession(process.cwd(), body),
        );
        return;
      }

      if (
        request.method === "POST" &&
        request.url === "/api/device-pairing/confirm"
      ) {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.confirmDevicePairing(process.cwd(), body),
        );
        return;
      }

      if (
        request.method === "POST" &&
        request.url === "/api/device-pairing/verify"
      ) {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.verifyPairedDevice(process.cwd(), body),
        );
        return;
      }

      if (
        request.method === "DELETE" &&
        request.url === "/api/device-pairing/device"
      ) {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.revokePairedDevice(process.cwd(), body),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/api/ollama/models") {
        sendJson(response, 200, await operations.listOllamaModels(process.cwd()));
        return;
      }

      if (request.method === "GET" && request.url === "/api/automation") {
        sendJson(response, 200, await operations.readAutomationStatus(process.cwd()));
        return;
      }

      if (request.method === "GET" && request.url === "/api/controller-status") {
        sendJson(response, 200, loopController.getStatus(process.cwd()));
        return;
      }

      if (request.method === "GET" && request.url === "/api/loops") {
        sendJson(response, 200, await operations.listLoops());
        return;
      }

      if (request.method === "GET" && request.url === "/api/loop-creation-assistant") {
        sendJson(
          response,
          200,
          await operations.getLoopCreationAssistantState(process.cwd()),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/start") {
        const preflight = await readDispatchPreflight(operations);
        if (!preflight.allowed) {
          sendJson(
            response,
            409,
            blockedDispatchPayload({
              preflight: preflight.preflight,
              detail: preflight.detail,
              action: "启动真实循环",
            }),
          );
          return;
        }
        const snapshot = await operations.startRun(process.cwd());
        const loopStarted = await loopController.start(process.cwd());
        sendJson(response, 200, {
          ...snapshot,
          loopControllerStarted: loopStarted,
        });
        return;
      }

      if (request.method === "POST" && request.url === "/api/run-turn") {
        const preflight = await readDispatchPreflight(operations);
        if (!preflight.allowed) {
          sendJson(
            response,
            409,
            blockedDispatchPayload({
              preflight: preflight.preflight,
              detail: preflight.detail,
            }),
          );
          return;
        }
        sendJson(response, 200, await operations.runLoopTurn(process.cwd()));
        return;
      }

      if (request.method === "POST" && request.url === "/api/send-guidance") {
        const preflight = await readDispatchPreflight(operations);
        if (!preflight.allowed) {
          sendJson(
            response,
            409,
            blockedDispatchPayload({
              preflight: preflight.preflight,
              detail: preflight.detail,
            }),
          );
          return;
        }
        sendJson(
          response,
          200,
          {
            ...(await operations.sendPendingGuidanceOnce(process.cwd())),
            pendingGuidance: buildPendingGuidanceResponse(
              await operations.readLoopSnapshot(process.cwd()),
            ),
          },
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/rename-loop") {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.renameLoop(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/loops") {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.createLoop(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/projects") {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.createProject(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/loops/select") {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.selectLoop(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/loops/delete") {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.deleteLoop(process.cwd(), body),
        );
        return;
      }

      if (
        request.method === "POST" &&
        request.url === "/api/loop-creation-assistant/back"
      ) {
        sendJson(
          response,
          200,
          await operations.goBackLoopCreationAssistant(process.cwd()),
        );
        return;
      }

      if (
        request.method === "POST" &&
        request.url === "/api/loop-creation-assistant/reset"
      ) {
        sendJson(
          response,
          200,
          await operations.restartLoopCreationAssistant(process.cwd()),
        );
        return;
      }

      if (
        request.method === "POST" &&
        request.url === "/api/loop-creation-assistant/reply"
      ) {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.replyLoopCreationAssistant(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/stop") {
        const body = await readBody(request);
        loopController.stop(process.cwd());
        sendJson(
          response,
          200,
          await operations.requestGracefulStop(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/shutdown") {
        const body = await readBody(request);
        loopController.stop(process.cwd());
        sendJson(
          response,
          200,
          await operations.shutdownLauncher(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/budgets") {
        const body = await readBody(request);
        sendJson(response, 200, await operations.updateBudgets(process.cwd(), body));
        return;
      }

      if (request.method === "POST" && request.url === "/api/automation") {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.updateAutomationSettings(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/thread") {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.saveThreadBinding(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/thread/sync") {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.syncCodexThreadMirror(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/pending-guidance") {
        const body = await readBody(request);
        const result = await operations.savePendingGuidance(process.cwd(), body);
        sendJson(
          response,
          200,
          {
            ...result,
            pendingGuidance: buildPendingGuidanceResponse(result),
          },
        );
        return;
      }

      if (request.method === "DELETE" && request.url === "/api/pending-guidance") {
        sendJson(
          response,
          200,
          {
            ...(await operations.clearPendingGuidance(process.cwd())),
            pendingGuidance: {
              text: "",
              preview: "",
              hasPending: false,
              status: "cleared",
              statusLabel: "已撤回",
              statusDetail: "这条补充已经撤回，不会再合并到下一条指令。",
              mergeTiming: "codex_completed",
              mergeTimingLabel: "等 Codex 完成后合并到下一条指令",
              mergeProcessor: "ollama_npc",
              mergeProcessorLabel: "本地模型 / NPC 合并",
              userMessage: "已撤回待合并引导。",
            },
          },
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/loop-supervisor") {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.updateLoopSupervisor(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/supervisor/review") {
        sendJson(
          response,
          200,
          await operations.ensureSupervisorReview(process.cwd()),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/error") {
        const body = await readBody(request);
        sendJson(response, 200, await operations.recordError(process.cwd(), body));
        return;
      }

      if (request.method === "POST" && request.url === "/api/heartbeat") {
        const body = await readBody(request);
        sendJson(
          response,
          200,
          await operations.recordHeartbeat(process.cwd(), body),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/overrides") {
        const body = await readBody(request);
        await operations.saveUserOverrides(process.cwd(), body);
        sendJson(response, 200, await operations.readLoopSnapshot());
        return;
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 500, {
        error: error.message || "操作失败，请稍后重试。",
        kind: "operation_failed",
      });
    }
  };
}
