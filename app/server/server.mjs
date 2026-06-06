import {
  createLoop,
  deleteLoop,
  exportMobileView,
  exportLoopSummary,
  listLoops,
  readLoopSnapshot,
  selectLoop,
  recordHeartbeat,
  recordError,
  renameLoop,
  requestGracefulStop,
  runLoopTurn,
  saveThreadBinding,
  startRun,
  syncCodexThreadMirror,
  updateBudgets,
} from "./lib/runtime-store.mjs";
import { createLoopController } from "./lib/loop-controller.mjs";
import { saveUserOverrides } from "./lib/adapter-store.mjs";

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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
      startRun,
      renameLoop,
      listLoops,
      createLoop,
      selectLoop,
      deleteLoop,
      requestGracefulStop,
      runLoopTurn,
      updateBudgets,
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

      if (request.method === "GET" && request.url === "/api/loops") {
        sendJson(response, 200, await operations.listLoops());
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

      if (request.method === "POST" && request.url === "/api/budgets") {
        const body = await readBody(request);
        sendJson(response, 200, await operations.updateBudgets(process.cwd(), body));
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
        error: error.message,
        stack: error.stack,
      });
    }
  };
}
