import {
  createLoop,
  deleteLoop,
  exportMobileView,
  exportLoopSummary,
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
  verifyPairedDevice,
} from "./lib/runtime-governance/device-pairing.mjs";
import { listOllamaModels as defaultListOllamaModels } from "./lib/ollama-model-store.mjs";
import {
  readAutomationStatusForThread,
      updateAutomationIntervalForThread,
} from "./lib/automation-store.mjs";
import { saveUserOverrides } from "./lib/adapter-store.mjs";

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(`${JSON.stringify(value)}\n`);
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

export function buildHandler({
  loopController = createLoopController(),
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
      verifyPairedDevice,
      readAutomationStatus: async (startDir = process.cwd()) => {
        const snapshot = await readLoopSnapshot(startDir);
        return readAutomationStatusForThread(snapshot.thread);
      },
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
      getLoopCreationAssistantState,
      goBackLoopCreationAssistant,
      restartLoopCreationAssistant,
      selectLoop,
      deleteLoop,
      replyLoopCreationAssistant,
      requestGracefulStop,
      runLoopTurn,
      sendPendingGuidanceOnce,
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
        const snapshot = await operations.startRun(process.cwd());
        const loopStarted = await loopController.start(process.cwd());
        sendJson(response, 200, {
          ...snapshot,
          loopControllerStarted: loopStarted,
        });
        return;
      }

      if (request.method === "POST" && request.url === "/api/run-turn") {
        sendJson(response, 200, await operations.runLoopTurn(process.cwd()));
        return;
      }

      if (request.method === "POST" && request.url === "/api/send-guidance") {
        sendJson(
          response,
          200,
          await operations.sendPendingGuidanceOnce(process.cwd()),
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
        sendJson(
          response,
          200,
          await operations.savePendingGuidance(process.cwd(), body),
        );
        return;
      }

      if (request.method === "DELETE" && request.url === "/api/pending-guidance") {
        sendJson(
          response,
          200,
          await operations.clearPendingGuidance(process.cwd()),
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
