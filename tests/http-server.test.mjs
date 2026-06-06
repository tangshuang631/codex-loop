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
