import test from "node:test";
import assert from "node:assert/strict";

import { buildHandler } from "../app/server/server.mjs";

test("handler returns 404 for unknown route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "GET",
      url: "/api/missing",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 404);
  assert.match(chunks.join(""), /Not found/);
});

test("handler dispatches snapshot route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({ ok: true }),
      exportLoopSummary: async () => ({ summary: true }),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "GET",
      url: "/api/snapshot",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"ok":true/);
});

test("handler dispatches health route with snapshot health summary", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({
        state: { mode: "running" },
        thread: { continuationStatus: "idle" },
        health: { ok: false, issues: ["events:missing"] },
      }),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "GET",
      url: "/api/health",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"ok":false/);
  assert.match(chunks.join(""), /"continuationStatus":"idle"/);
  assert.match(chunks.join(""), /events:missing/);
});

test("handler dispatches summary route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({ summary: true }),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "GET",
      url: "/api/summary",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"summary":true/);
});

test("handler dispatches mobile route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({ mobile: true }),
      readLauncherStatus: async () => ({ phase: "ready" }),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "GET",
      url: "/api/mobile",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"mobile":true/);
});

test("handler dispatches launcher status route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({}),
      readLauncherStatus: async () => ({
        phase: "ready",
        apiPort: 3000,
        webPort: 3001,
      }),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "GET",
      url: "/api/launcher-status",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"phase":"ready"/);
  assert.match(chunks.join(""), /"apiPort":3000/);
});

test("handler dispatches remote access status route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({}),
      readLauncherStatus: async () => ({}),
      readRemoteAccessStatus: async () => ({
        recommendedTransport: "tailscale",
        remoteReady: false,
      }),
      readAutomationStatus: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "GET",
      url: "/api/remote-access",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"recommendedTransport":"tailscale"/);
});

test("handler dispatches ollama model list route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({}),
      readLauncherStatus: async () => ({}),
      readRemoteAccessStatus: async () => ({}),
      readAutomationStatus: async () => ({}),
      listOllamaModels: async () => ({
        models: [
          { name: "qwen2.5:7b", size: 123 },
          { name: "llama3.1:8b", size: 456 },
        ],
      }),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "GET",
      url: "/api/ollama/models",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /qwen2\.5:7b/);
  assert.match(chunks.join(""), /llama3\.1:8b/);
});

test("handler dispatches automation status route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({}),
      readLauncherStatus: async () => ({}),
      readAutomationStatus: async () => ({
        id: "demo-dev-checkpoint",
        intervalMinutes: 10,
      }),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "GET",
      url: "/api/automation",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"intervalMinutes":10/);
});

test("handler dispatches automation update route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({}),
      readLauncherStatus: async () => ({}),
      readAutomationStatus: async () => ({}),
      updateAutomationSettings: async (_cwd, body) => ({
        updated: true,
        intervalMinutes: body.intervalMinutes,
      }),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "POST",
      url: "/api/automation",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            intervalMinutes: 10,
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"updated":true/);
  assert.match(chunks.join(""), /"intervalMinutes":10/);
});

test("handler dispatches start route and reports whether controller was newly started", async () => {
  let startedCount = 0;
  const handler = buildHandler({
    loopController: {
      start: async () => {
        startedCount += 1;
        return startedCount === 1;
      },
      stop: () => true,
    },
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({ started: true }),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  async function request() {
    const chunks = [];
    const response = {
      writeHead(statusCode) {
        this.statusCode = statusCode;
      },
      end(text) {
        chunks.push(text);
      },
    };

    await handler(
      {
        method: "POST",
        url: "/api/start",
        [Symbol.asyncIterator]: async function* iterator() {},
      },
      response,
    );

    return { statusCode: response.statusCode, text: chunks.join("") };
  }

  const first = await request();
  const second = await request();

  assert.equal(first.statusCode, 200);
  assert.match(first.text, /"loopControllerStarted":true/);
  assert.equal(second.statusCode, 200);
  assert.match(second.text, /"loopControllerStarted":false/);
});

test("handler dispatches shutdown route and stops loop controller first", async () => {
  let stopCalls = 0;
  let shutdownPayload = null;
  const handler = buildHandler({
    loopController: {
      start: async () => true,
      stop: () => {
        stopCalls += 1;
        return true;
      },
    },
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      shutdownLauncher: async (_startDir, payload) => {
        shutdownPayload = payload;
        return { ok: true, shutdown: { requested: true } };
      },
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "POST",
      url: "/api/shutdown",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            reason: "manual shutdown from dashboard",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(stopCalls, 1);
  assert.equal(shutdownPayload.reason, "manual shutdown from dashboard");
  assert.match(chunks.join(""), /"requested":true/);
});

test("handler dispatches thread sync route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({ synced: true }),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "POST",
      url: "/api/thread/sync",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            latestCodexSummary: "ok",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"synced":true/);
});

test("handler dispatches run turn route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      runLoopTurn: async () => ({ continued: true }),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "POST",
      url: "/api/run-turn",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"continued":true/);
});

test("handler dispatches rename loop route", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({ renamed: true }),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
    },
  });

  const chunks = [];
  const response = {
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "POST",
      url: "/api/rename-loop",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({ loopName: "core-longrun-loop" }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"renamed":true/);
});

test("handler dispatches loop registry routes", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
      listLoops: async () => ({ loops: [{ id: "a" }] }),
      createLoop: async () => ({ created: true }),
      selectLoop: async () => ({ selected: true }),
      deleteLoop: async () => ({ deleted: true }),
    },
  });

  async function request(method, url, body) {
    const chunks = [];
    const response = {
      writeHead(statusCode) {
        this.statusCode = statusCode;
      },
      end(text) {
        chunks.push(text);
      },
    };

    await handler(
      {
        method,
        url,
        [Symbol.asyncIterator]: async function* iterator() {
          if (body) {
            yield Buffer.from(JSON.stringify(body), "utf8");
          }
        },
      },
      response,
    );

    return { statusCode: response.statusCode, text: chunks.join("") };
  }

  const listResult = await request("GET", "/api/loops");
  const createResult = await request("POST", "/api/loops", { loopName: "x" });
  const selectResult = await request("POST", "/api/loops/select", { loopId: "a" });
  const deleteResult = await request("POST", "/api/loops/delete", { loopId: "a" });

  assert.equal(listResult.statusCode, 200);
  assert.match(listResult.text, /"id":"a"/);
  assert.equal(createResult.statusCode, 200);
  assert.match(createResult.text, /"created":true/);
  assert.equal(selectResult.statusCode, 200);
  assert.match(selectResult.text, /"selected":true/);
  assert.equal(deleteResult.statusCode, 200);
  assert.match(deleteResult.text, /"deleted":true/);
});

test("handler dispatches loop creation assistant back and reset routes", async () => {
  let backCalls = 0;
  let resetCalls = 0;
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
      listLoops: async () => ({}),
      createLoop: async () => ({}),
      getLoopCreationAssistantState: async () => ({}),
      goBackLoopCreationAssistant: async () => {
        backCalls += 1;
        return { step: "project_name" };
      },
      restartLoopCreationAssistant: async () => {
        resetCalls += 1;
        return { step: "workspace_root" };
      },
      selectLoop: async () => ({}),
      deleteLoop: async () => ({}),
      replyLoopCreationAssistant: async () => ({}),
    },
  });

  async function request(url) {
    const chunks = [];
    const response = {
      writeHead(statusCode) {
        this.statusCode = statusCode;
      },
      end(text) {
        chunks.push(text);
      },
    };

    await handler(
      {
        method: "POST",
        url,
        [Symbol.asyncIterator]: async function* iterator() {},
      },
      response,
    );

    return { statusCode: response.statusCode, text: chunks.join("") };
  }

  const backResult = await request("/api/loop-creation-assistant/back");
  const resetResult = await request("/api/loop-creation-assistant/reset");

  assert.equal(backResult.statusCode, 200);
  assert.equal(resetResult.statusCode, 200);
  assert.equal(backCalls, 1);
  assert.equal(resetCalls, 1);
  assert.match(backResult.text, /"project_name"/);
  assert.match(resetResult.text, /"workspace_root"/);
});

test("handler dispatches loop creation assistant routes", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      recordHeartbeat: async () => ({}),
      recordError: async () => ({}),
      saveUserOverrides: async () => ({}),
      getLoopCreationAssistantState: async () => ({
        status: "collecting",
        currentQuestion: { id: "workspace_root" },
      }),
      replyLoopCreationAssistant: async (_cwd, body) => ({
        status: "completed",
        createdLoop: { loop: { name: body.answer } },
      }),
    },
  });

  async function request(method, url, body) {
    const chunks = [];
    const response = {
      writeHead(statusCode) {
        this.statusCode = statusCode;
      },
      end(text) {
        chunks.push(text);
      },
    };

    await handler(
      {
        method,
        url,
        [Symbol.asyncIterator]: async function* iterator() {
          if (body) {
            yield Buffer.from(JSON.stringify(body), "utf8");
          }
        },
      },
      response,
    );

    return { statusCode: response.statusCode, text: chunks.join("") };
  }

  const stateResult = await request("GET", "/api/loop-creation-assistant");
  const replyResult = await request("POST", "/api/loop-creation-assistant/reply", {
    answer: "新 loop",
  });

  assert.equal(stateResult.statusCode, 200);
  assert.match(stateResult.text, /"workspace_root"/);
  assert.equal(replyResult.statusCode, 200);
  assert.match(replyResult.text, /"completed"/);
  assert.match(replyResult.text, /"新 loop"/);
});
