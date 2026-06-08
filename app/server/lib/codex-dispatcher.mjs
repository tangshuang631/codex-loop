import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const APP_SERVER_TIMEOUT_MS = Number(process.env.CODEX_LOOP_APP_SERVER_TIMEOUT_MS || 120000);
const APP_SERVER_DELIVERY_TIMEOUT_MS = Number(
  process.env.CODEX_LOOP_APP_SERVER_DELIVERY_TIMEOUT_MS || 15000,
);
let cachedCodexCommand = "";

function safeText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function buildDelegatedPrompt(prompt) {
  const cleanPrompt = safeText(prompt, "");
  if (!cleanPrompt) return "";

  const sourceThreadId = safeText(process.env.CODEX_THREAD_ID, "");
  if (!sourceThreadId) return cleanPrompt;

  return [
    "<codex_delegation>",
    `  <source_thread_id>${sourceThreadId}</source_thread_id>`,
    `  <input>${cleanPrompt}</input>`,
    "</codex_delegation>",
  ].join("\n");
}

function resolveCodexCommand() {
  if (cachedCodexCommand) return cachedCodexCommand;

  const candidates = [
    process.env.CODEX_APP_SERVER_PATH,
    process.env.CODEX_CLI_PATH,
    "C:\\Users\\31272\\AppData\\Local\\OpenAI\\Codex\\bin\\fb2111b91430cb17\\codex.exe",
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.602.4764.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe",
    "codex.exe",
    "codex",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes("\\") || candidate.includes("/")) {
      cachedCodexCommand = candidate;
      return cachedCodexCommand;
    }
    const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [candidate], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const resolved = String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (resolved) {
      cachedCodexCommand = resolved;
      return cachedCodexCommand;
    }
  }

  cachedCodexCommand = "codex";
  return cachedCodexCommand;
}

function requestVersion(method) {
  const versions = {
    "thread-follower-start-turn": 1,
    "thread-follower-steer-turn": 1,
    "thread-follower-submit-user-input": 1,
    "thread-role": 0,
  };
  return versions[method] ?? 0;
}

function createFollowerTurnParams({ threadId, prompt, workspaceRoot, model }) {
  const visiblePrompt = buildDelegatedPrompt(prompt);
  return {
    conversationId: threadId,
    turnStartParams: {
      threadId,
      conversationId: threadId,
      cwd: workspaceRoot,
      input: [{ type: "text", text: visiblePrompt }],
      model: model || null,
      sandboxPolicy: { type: "dangerFullAccess" },
      effort: "low",
      summary: "none",
      personality: "friendly",
      clientUserMessageId: randomUUID(),
      serviceTier: null,
    },
  };
}

function messageContainsDelegatedPrompt(message, prompt) {
  const visiblePrompt = buildDelegatedPrompt(prompt);
  const conversationState = message?.params?.change?.conversationState;
  const turns = Array.isArray(conversationState?.turns) ? conversationState.turns : [];
  return turns.some((turn) =>
    (turn?.params?.input || []).some((item) => safeText(item?.text, "") === visiblePrompt) ||
    (turn?.items || []).some((item) =>
      item?.type === "userMessage" &&
      (item.content || []).some((content) => safeText(content?.text, "") === visiblePrompt),
    ),
  );
}

function extractConversationIdFromMessage(message) {
  if (message?.type !== "broadcast") return "";
  return safeText(
    message.params?.conversationId ||
      message.params?.threadId ||
      message.params?.change?.conversationState?.id,
    "",
  );
}

function isTargetThreadDeliveryBroadcast(message, { threadId, prompt }) {
  if (message?.type !== "broadcast" || extractConversationIdFromMessage(message) !== threadId) {
    return false;
  }
  return messageContainsDelegatedPrompt(message, prompt);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

function waitForClose(child) {
  return new Promise((resolve) => {
    child.once("close", (code) => resolve(code));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMessageText(message) {
  const item = message?.params?.item;
  if (item?.type === "agentMessage") return safeText(item.text, "");
  return "";
}

async function dispatchViaAppServer({ threadId, prompt, workspaceRoot, model }) {
  const child = spawn(resolveCodexCommand(), ["app-server", "--listen", "stdio://"], {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const closePromise = waitForClose(child);
  const responses = new Map();
  const waiters = new Map();
  let stdoutBuffer = "";
  let lastMessage = "";
  let turnId = "";
  let turnCompleted = false;
  let turnStatus = "";
  let turnError = "";
  let deliveryObserved = false;

  function handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const id = String(message.id);
      responses.set(id, message);
      const waiter = waiters.get(id);
      if (waiter) {
        waiters.delete(id);
        waiter.resolve(message);
      }
      return;
    }

    if (message.method === "turn/started" && message.params?.threadId === threadId) {
      turnId ||= safeText(message.params?.turn?.id, "");
      deliveryObserved = true;
    }
    if (message.method === "item/started" && message.params?.threadId === threadId) {
      if (message.params?.item?.type === "userMessage") {
        deliveryObserved = true;
      }
    }

    const messageText = parseMessageText(message);
    if (messageText) lastMessage = messageText;

    if (message.method === "turn/completed" && message.params?.threadId === threadId) {
      const completedTurnId = safeText(message.params?.turn?.id, "");
      if (!turnId || completedTurnId === turnId) {
        turnId ||= completedTurnId;
        turnStatus = safeText(message.params?.turn?.status, "");
        turnError = safeText(message.params?.turn?.error?.message, "");
        turnCompleted = true;
      }
    }
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith("{")) continue;
      try {
        handleMessage(JSON.parse(text));
      } catch {
        // Ignore non-protocol stdout.
      }
    }
  });

  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  async function sendRequest(method, params) {
    const id = `${method}:${randomUUID()}`;
    const existing = responses.get(id);
    if (existing) return existing;
    const deferred = createDeferred();
    waiters.set(id, deferred);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);

    let timeoutId;
    try {
      return await Promise.race([
        deferred.promise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            waiters.delete(id);
            reject(new Error(`${method} 超时`));
          }, APP_SERVER_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function waitForDelivery() {
    const startedAt = Date.now();
    while (!deliveryObserved && Date.now() - startedAt < APP_SERVER_DELIVERY_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!deliveryObserved) {
      throw new Error("Codex 桌面端未确认收到本次指令。");
    }
  }

  try {
    const init = await sendRequest("initialize", {
      clientInfo: { name: "codex-loop", title: "codex-loop dispatcher", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (init.error) throw new Error(init.error.message || "初始化 Codex app-server 失败。");

    const resume = await sendRequest("thread/resume", {
      threadId,
      history: null,
      path: null,
      model: null,
      modelProvider: null,
      cwd: workspaceRoot,
      approvalPolicy: null,
      sandbox: null,
      config: null,
      personality: null,
      excludeTurns: true,
    });
    if (resume.error) throw new Error(resume.error.message || "载入目标 Codex 线程失败。");

    const turn = await sendRequest("turn/start", {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: buildDelegatedPrompt(prompt), text_elements: [] }],
      cwd: workspaceRoot,
      approvalPolicy: null,
      sandboxPolicy: { type: "dangerFullAccess" },
      model: model || null,
      effort: "low",
      serviceTier: null,
      summary: "none",
      personality: null,
      collaborationMode: null,
    });
    if (turn.error) throw new Error(turn.error.message || "向目标 Codex 线程发送指令失败。");
    turnId = safeText(turn.result?.turn?.id, turnId);
    deliveryObserved = Boolean(turnId);

    await waitForDelivery();
    return {
      transport: "desktop-app-server-stdio",
      delivery: "desktop_visible_thread",
      nativeMethod: "thread/resume+turn/start",
      dispatchedTurnId: turnId,
      lastMessage,
      completionObserved: turnCompleted,
      deliveryObserved,
      delegated: buildDelegatedPrompt(prompt) !== prompt,
    };
  } catch (error) {
    if (!deliveryObserved) {
      error.message = `Codex 桌面端未确认收到本次指令：${error.message}`;
    }
    throw error;
  } finally {
    try {
      child.stdin.end();
    } catch {
      // ignore shutdown races
    }
    const closed = await Promise.race([
      closePromise.then(() => true),
      sleep(1500).then(() => false),
    ]);
    if (!closed && !child.killed) {
      child.kill();
      await Promise.race([
        closePromise,
        sleep(1500),
      ]);
    }
  }
}

export async function dispatchThreadMessage({ threadId, prompt, workspaceRoot, model }) {
  const mode = safeText(process.env.CODEX_LOOP_DISPATCH_MODE, "app-server").toLowerCase();
  if (mode === "app-server" || mode === "desktop-app-server" || mode === "native" || mode === "desktop-ipc") {
    return dispatchViaAppServer({ threadId, prompt, workspaceRoot, model });
  }
  if (mode === "legacy" || mode === "thread-store" || mode === "cli-resume") {
    throw new Error("旧 CLI/线程存储兜底链路已禁用，避免桌面端不可见的假成功。");
  }
  throw new Error(`未知的 Codex 发送模式：${mode}`);
}

export const __testHooks = {
  buildDelegatedPrompt,
  createFollowerTurnParams,
  isTargetThreadDeliveryBroadcast,
  requestVersion,
};
