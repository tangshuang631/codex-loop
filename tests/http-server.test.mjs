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

test("handler dispatches production status route for product health checks", async () => {
  const handler = buildHandler({
    operations: {
      readProductionStatus: async () => ({
        title: "codex-loop 生产状态摘要",
        status: "passed",
        nextAction: "可以进入真实任务使用；长时间运行仍建议保留人工观察和运行日志。",
        sections: [
          {
            label: "最近生产检查",
            status: "passed",
            summary: "8 项检查通过",
          },
        ],
      }),
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
      url: "/api/production-status",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /codex-loop 生产状态摘要/);
  assert.match(chunks.join(""), /最近生产检查/);
  assert.match(chunks.join(""), /可以进入真实任务使用/);
});

test("handler dispatches production preflight route before real loop dispatch", async () => {
  const handler = buildHandler({
    operations: {
      readProductionPreflight: async () => ({
        title: "codex-loop 真实循环前预检",
        status: "ready_with_attention",
        canDispatch: true,
        target: {
          threadTitle: "按清单继续开发",
          workspaceRoot: "E:\\2026\\opencow",
          threadId: "thread-123",
        },
        nextAction: "确认当前验证目标：按清单继续开发 / E:\\2026\\opencow / thread-123。",
      }),
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
      url: "/api/production-preflight",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /codex-loop 真实循环前预检/);
  assert.match(chunks.join(""), /ready_with_attention/);
  assert.match(chunks.join(""), /确认当前验证目标/);
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

test("handler protects paired mobile view with reusable device credentials", async () => {
  let verificationPayload = null;
  let exported = false;
  const handler = buildHandler({
    operations: {
      exportMobileView: async () => {
        exported = true;
        return {
          loop: { name: "按清单继续开发" },
          transcriptEntries: [{ role: "assistant", text: "Codex 已完成一轮。" }],
        };
      },
      verifyPairedDevice: async (_cwd, body) => {
        verificationPayload = body;
        return {
          valid: true,
          device: {
            id: body.deviceId,
            name: "iPhone",
            lastSeenAt: "2026-06-09T09:30:00.000Z",
          },
        };
      },
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
      url: "/api/mobile/view",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            deviceToken: "stored-token",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  const text = chunks.join("");
  assert.equal(response.statusCode, 200);
  assert.equal(exported, true);
  assert.equal(verificationPayload.deviceToken, "stored-token");
  assert.match(text, /"valid":true/);
  assert.match(text, /"name":"iPhone"/);
  assert.match(text, /按清单继续开发/);
  assert.match(text, /Codex 已完成一轮/);
});

test("handler rejects paired mobile view when device credentials are invalid", async () => {
  let exported = false;
  const handler = buildHandler({
    operations: {
      exportMobileView: async () => {
        exported = true;
        return { mobile: true };
      },
      verifyPairedDevice: async () => ({
        valid: false,
        reason: "设备未绑定或令牌已失效，请重新扫码。",
      }),
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
      url: "/api/mobile/view",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            deviceToken: "bad-token",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 401);
  assert.equal(exported, false);
  assert.match(chunks.join(""), /设备未绑定|重新扫码/);
  assert.match(chunks.join(""), /device_not_paired/);
});

test("handler lets paired mobile devices save next-turn guidance", async () => {
  let verificationPayload = null;
  let savedPayload = null;
  let sentOnce = false;
  const handler = buildHandler({
    operations: {
      savePendingGuidance: async (_cwd, body) => {
        savedPayload = body;
        return { thread: { pendingUserGuidance: body.text } };
      },
      sendPendingGuidanceOnce: async () => {
        sentOnce = true;
        return { thread: { continuationStatus: "dispatching" } };
      },
      verifyPairedDevice: async (_cwd, body) => {
        verificationPayload = body;
        return {
          valid: true,
          device: {
            id: body.deviceId,
            name: "iPhone",
            lastSeenAt: "2026-06-09T09:40:00.000Z",
          },
        };
      },
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
      url: "/api/mobile/guidance",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            deviceToken: "stored-token",
            text: "下一轮先检查移动端历史记录是否清晰。",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(verificationPayload.deviceToken, "stored-token");
  assert.equal(savedPayload.text, "下一轮先检查移动端历史记录是否清晰。");
  assert.equal(sentOnce, true);
  assert.match(chunks.join(""), /移动端历史记录/);
  assert.match(chunks.join(""), /"dispatch":"sent"/);
});

test("handler keeps mobile guidance queued when Codex is still working", async () => {
  let savedPayload = null;
  let sendAttempts = 0;
  const handler = buildHandler({
    operations: {
      savePendingGuidance: async (_cwd, body) => {
        savedPayload = body;
        return { thread: { pendingUserGuidance: body.text } };
      },
      sendPendingGuidanceOnce: async () => {
        sendAttempts += 1;
        throw new Error("Codex 正在处理当前轮，请等完成后再发送引导。");
      },
      verifyPairedDevice: async (_cwd, body) => ({
        valid: true,
        device: {
          id: body.deviceId,
          name: "iPhone",
        },
      }),
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
      url: "/api/mobile/guidance",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            deviceToken: "stored-token",
            text: "等 Codex 完成后补一轮移动端验收。",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(sendAttempts, 1);
  assert.equal(savedPayload.text, "等 Codex 完成后补一轮移动端验收。");
  assert.match(chunks.join(""), /"dispatch":"queued"/);
  assert.match(chunks.join(""), /Codex 正在处理当前轮/);
});

test("handler keeps mobile guidance queued during automatic loop runs", async () => {
  let sendAttempts = 0;
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({
        state: {
          mode: "running",
          monitorOnly: false,
        },
        thread: {
          continuationStatus: "idle",
        },
      }),
      savePendingGuidance: async (_cwd, body) => ({
        thread: { pendingUserGuidance: body.text },
      }),
      sendPendingGuidanceOnce: async () => {
        sendAttempts += 1;
        return {};
      },
      verifyPairedDevice: async (_cwd, body) => ({
        valid: true,
        device: {
          id: body.deviceId,
          name: "iPhone",
        },
      }),
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
      url: "/api/mobile/guidance",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            deviceToken: "stored-token",
            text: "下一轮把用户补充合并进去。",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(sendAttempts, 0);
  assert.match(chunks.join(""), /"dispatch":"queued"/);
  assert.match(chunks.join(""), /自动循环正在运行/);
});

test("handler reports mobile guidance dispatch failures instead of pretending they are queued", async () => {
  const handler = buildHandler({
    operations: {
      savePendingGuidance: async (_cwd, body) => ({
        thread: { pendingUserGuidance: body.text },
      }),
      sendPendingGuidanceOnce: async () => {
        throw new Error("向 Codex 线程发送引导失败，请检查线程绑定。");
      },
      verifyPairedDevice: async (_cwd, body) => ({
        valid: true,
        device: {
          id: body.deviceId,
          name: "iPhone",
        },
      }),
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
      url: "/api/mobile/guidance",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            deviceToken: "stored-token",
            text: "请继续推进核心链路。",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.match(chunks.join(""), /向 Codex 线程发送引导失败/);
  assert.doesNotMatch(chunks.join(""), /"dispatch":"queued"/);
});

test("handler rejects mobile guidance when device credentials are invalid", async () => {
  let saved = false;
  const handler = buildHandler({
    operations: {
      savePendingGuidance: async () => {
        saved = true;
        return {};
      },
      verifyPairedDevice: async () => ({
        valid: false,
        reason: "设备未绑定或令牌已失效，请重新扫码。",
      }),
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
      url: "/api/mobile/guidance",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            deviceToken: "bad-token",
            text: "不应该写入。",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 401);
  assert.equal(saved, false);
  assert.match(chunks.join(""), /设备未绑定|重新扫码/);
});

test("handler lets paired mobile devices clear queued guidance", async () => {
  let cleared = false;
  let verificationPayload = null;
  const handler = buildHandler({
    operations: {
      clearPendingGuidance: async () => {
        cleared = true;
        return { thread: { pendingUserGuidance: "" } };
      },
      verifyPairedDevice: async (_cwd, body) => {
        verificationPayload = body;
        return {
          valid: true,
          device: {
            id: body.deviceId,
            name: "iPhone",
          },
        };
      },
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
      method: "DELETE",
      url: "/api/mobile/guidance",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            deviceToken: "stored-token",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(verificationPayload.deviceToken, "stored-token");
  assert.equal(cleared, true);
  assert.match(chunks.join(""), /"cleared":true/);
});

test("handler rejects mobile guidance clearing when device credentials are invalid", async () => {
  let cleared = false;
  const handler = buildHandler({
    operations: {
      clearPendingGuidance: async () => {
        cleared = true;
        return {};
      },
      verifyPairedDevice: async () => ({
        valid: false,
        reason: "设备未绑定或令牌已失效，请重新扫码。",
      }),
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
      method: "DELETE",
      url: "/api/mobile/guidance",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            deviceToken: "bad-token",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 401);
  assert.equal(cleared, false);
  assert.match(chunks.join(""), /设备未绑定|重新扫码/);
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

test("handler dispatches device pairing status and scan session routes", async () => {
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({}),
      readLauncherStatus: async () => ({}),
      readRemoteAccessStatus: async () => ({}),
      readAutomationStatus: async () => ({}),
      readDevicePairingStatus: async () => ({
        hasReusablePairing: true,
        pairedDeviceCount: 1,
      }),
      createDevicePairingSession: async (_cwd, body) => ({
        sessionId: "pair-session-1",
        pairingCode: "ABCD-1234",
        mobileBaseUrl: body.mobileBaseUrl,
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

  const status = await request("GET", "/api/device-pairing");
  const session = await request("POST", "/api/device-pairing/session", {
    mobileBaseUrl: "http://100.64.0.10:3001",
  });

  assert.equal(status.statusCode, 200);
  assert.match(status.text, /"pairedDeviceCount":1/);
  assert.equal(session.statusCode, 200);
  assert.match(session.text, /"pairingCode":"ABCD-1234"/);
  assert.match(session.text, /100\.64\.0\.10/);
});

test("handler dispatches device pairing confirmation route", async () => {
  let confirmationPayload = null;
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({}),
      readLauncherStatus: async () => ({}),
      readRemoteAccessStatus: async () => ({}),
      readAutomationStatus: async () => ({}),
      confirmDevicePairing: async (_cwd, body) => {
        confirmationPayload = body;
        return {
          status: "paired",
          device: { id: "device-1", name: body.deviceName },
          deviceToken: "device-token-visible-once",
        };
      },
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
      url: "/api/device-pairing/confirm",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            sessionId: "pair-session-1",
            pairingCode: "ABCD-1234",
            deviceName: "iPhone",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(confirmationPayload.deviceName, "iPhone");
  assert.match(chunks.join(""), /device-token-visible-once/);
});

test("handler dispatches reusable device pairing verification route", async () => {
  let verificationPayload = null;
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({}),
      readLauncherStatus: async () => ({}),
      readRemoteAccessStatus: async () => ({}),
      readAutomationStatus: async () => ({}),
      verifyPairedDevice: async (_cwd, body) => {
        verificationPayload = body;
        return {
          valid: true,
          device: { id: body.deviceId, name: "iPhone" },
        };
      },
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
      url: "/api/device-pairing/verify",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            deviceToken: "stored-token",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(verificationPayload.deviceToken, "stored-token");
  assert.match(chunks.join(""), /"valid":true/);
  assert.match(chunks.join(""), /"name":"iPhone"/);
});

test("handler dispatches device pairing revoke route for trusted phone governance", async () => {
  let revokePayload = null;
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({}),
      readLauncherStatus: async () => ({}),
      readRemoteAccessStatus: async () => ({}),
      readAutomationStatus: async () => ({}),
      revokePairedDevice: async (_cwd, body) => {
        revokePayload = body;
        return {
          revoked: true,
          device: { id: body.deviceId, name: "iPhone" },
          summary: "已撤销 iPhone 的长期绑定。",
        };
      },
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
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "DELETE",
      url: "/api/device-pairing/device",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            deviceId: "device-1",
            reason: "手机丢失",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(revokePayload.deviceId, "device-1");
  assert.equal(revokePayload.reason, "手机丢失");
  assert.match(chunks.join(""), /"revoked":true/);
  assert.match(chunks.join(""), /已撤销/);
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

test("handler exposes readable loop controller status", async () => {
  const handler = buildHandler({
    loopController: {
      start: async () => true,
      stop: () => true,
      getStatus: () => ({
        running: true,
        state: "waiting_codex",
        label: "等待 Codex",
        detail: "上一条指令已发送，正在等待 Codex 完成当前轮。",
        nextAction: "等待 Codex 完成；如有新要求，写入下一轮补充引导。",
      }),
    },
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      exportMobileView: async () => ({}),
      readLauncherStatus: async () => ({}),
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
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(text) {
      chunks.push(text);
    },
  };

  await handler(
    {
      method: "GET",
      url: "/api/controller-status",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.match(chunks.join(""), /"state":"waiting_codex"/);
  assert.match(chunks.join(""), /等待 Codex/);
  assert.match(chunks.join(""), /补充引导/);
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

test("handler dispatches pending guidance route", async () => {
  let savedPayload = null;
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
      savePendingGuidance: async (_cwd, body) => {
        savedPayload = body;
        return { thread: { pendingUserGuidance: body.text } };
      },
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
      url: "/api/pending-guidance",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            text: "下一轮先补移动端状态摘要。",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(savedPayload.text, "下一轮先补移动端状态摘要。");
  assert.match(chunks.join(""), /移动端状态摘要/);
});

test("handler dispatches clear pending guidance route", async () => {
  let cleared = false;
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
      savePendingGuidance: async () => ({}),
      clearPendingGuidance: async () => {
        cleared = true;
        return { thread: { pendingUserGuidance: "" } };
      },
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
      method: "DELETE",
      url: "/api/pending-guidance",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(cleared, true);
  assert.match(chunks.join(""), /pendingUserGuidance/);
});

test("handler dispatches current loop supervisor route", async () => {
  let savedPayload = null;
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      updateLoopSupervisor: async (_cwd, body) => {
        savedPayload = body;
        return { loop: { supervisor: body } };
      },
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      savePendingGuidance: async () => ({}),
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
      url: "/api/loop-supervisor",
      [Symbol.asyncIterator]: async function* iterator() {
        yield Buffer.from(
          JSON.stringify({
            roleTraits: "像挑剔真实用户一样验收移动端。",
            testingRules: "每轮都检查历史记录和下一步引导。",
            acceptanceCriteria: "手机上 10 秒内看懂当前进程。",
          }),
          "utf8",
        );
      },
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(savedPayload.roleTraits, "像挑剔真实用户一样验收移动端。");
  assert.match(chunks.join(""), /10 秒内看懂当前进程/);
});

test("handler dispatches supervisor review backfill route", async () => {
  let reviewed = false;
  const handler = buildHandler({
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      renameLoop: async () => ({}),
      requestGracefulStop: async () => ({}),
      updateBudgets: async () => ({}),
      updateLoopSupervisor: async () => ({}),
      ensureSupervisorReview: async () => {
        reviewed = true;
        return {
          reviewed: true,
          thread: {
            latestEventType: "supervisor_review_completed",
          },
        };
      },
      saveThreadBinding: async () => ({}),
      syncCodexThreadMirror: async () => ({}),
      savePendingGuidance: async () => ({}),
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
      url: "/api/supervisor/review",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(reviewed, true);
  assert.match(chunks.join(""), /supervisor_review_completed/);
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

test("handler dispatches send guidance route without starting the automatic controller", async () => {
  let sentOnce = false;
  let controllerStarted = false;
  const handler = buildHandler({
    loopController: {
      start: async () => {
        controllerStarted = true;
        return true;
      },
    },
    operations: {
      readLoopSnapshot: async () => ({}),
      exportLoopSummary: async () => ({}),
      startRun: async () => ({}),
      sendPendingGuidanceOnce: async () => {
        sentOnce = true;
        return { thread: { continuationStatus: "dispatching" } };
      },
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
      url: "/api/send-guidance",
      [Symbol.asyncIterator]: async function* iterator() {},
    },
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(sentOnce, true);
  assert.equal(controllerStarted, false);
  assert.match(chunks.join(""), /dispatching/);
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
      createProject: async () => ({ createdProject: { id: "p", name: "新项目" } }),
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
  const projectResult = await request("POST", "/api/projects", { projectName: "新项目" });
  const createResult = await request("POST", "/api/loops", { loopName: "x" });
  const selectResult = await request("POST", "/api/loops/select", { loopId: "a" });
  const deleteResult = await request("POST", "/api/loops/delete", { loopId: "a" });

  assert.equal(listResult.statusCode, 200);
  assert.match(listResult.text, /"id":"a"/);
  assert.equal(projectResult.statusCode, 200);
  assert.match(projectResult.text, /"name":"新项目"/);
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
