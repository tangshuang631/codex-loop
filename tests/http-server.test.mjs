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
          JSON.stringify({ loopName: "opencow-longrun-core" }),
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
