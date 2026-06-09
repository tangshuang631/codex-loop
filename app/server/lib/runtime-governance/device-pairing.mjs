import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, writeJson } from "../../../../scripts/lib/fs-helpers.mjs";
import { resolveProjectLayout } from "../paths.mjs";

const PAIRING_TTL_MS = 10 * 60 * 1000;

function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

function nowDate(tools = {}) {
  const value = tools.now ? tools.now() : new Date();
  return value instanceof Date ? value : new Date(value);
}

function randomToken(tools = {}) {
  if (tools.randomToken) {
    return safeText(tools.randomToken(), "");
  }
  return crypto.randomBytes(24).toString("base64url");
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(safeText(value, ""), "utf8").digest("hex");
}

function buildPairingCode(seed) {
  const normalized = safeText(seed, crypto.randomBytes(8).toString("hex"))
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
  const padded = `${normalized}${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
  return `${padded.slice(0, 4)}-${padded.slice(4, 8)}`;
}

async function resolvePairingPath(startDir = process.cwd()) {
  const { codexLoopRoot } = await resolveProjectLayout(startDir);
  return path.join(codexLoopRoot, "settings", "local", "device-pairing.json");
}

function createEmptyStore() {
  return {
    version: 1,
    activeSessions: [],
    pairedDevices: [],
    updatedAt: "",
  };
}

async function readStore(startDir = process.cwd()) {
  const pairingPath = await resolvePairingPath(startDir);
  try {
    return {
      pairingPath,
      store: {
        ...createEmptyStore(),
        ...JSON.parse(await fs.readFile(pairingPath, "utf8")),
      },
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { pairingPath, store: createEmptyStore() };
    }
    throw error;
  }
}

async function writeStore(pairingPath, store) {
  await ensureDir(path.dirname(pairingPath));
  await writeJson(pairingPath, {
    ...createEmptyStore(),
    ...store,
  });
}

function withoutExpiredSessions(sessions = [], at = new Date()) {
  const nowMs = at.getTime();
  return sessions.filter((session) => {
    const expiresAt = Date.parse(session.expiresAt || "");
    return Number.isFinite(expiresAt) && expiresAt > nowMs && session.status === "waiting_scan";
  });
}

function summarizeStatus(store = {}) {
  const devices = Array.isArray(store.pairedDevices) ? store.pairedDevices : [];
  const activeSessions = Array.isArray(store.activeSessions) ? store.activeSessions : [];
  return {
    hasReusablePairing: devices.length > 0,
    pairedDeviceCount: devices.length,
    activePairingSessionCount: activeSessions.length,
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt || "",
    })),
    summary: devices.length
      ? `已绑定 ${devices.length} 台手机，codex-loop 重启后可以自动重连。`
      : "还没有绑定手机。请在控制台生成扫码绑定后，用移动端 App 扫码连接。",
    nextAction: devices.length
      ? "如需新手机访问，请在设置里重新扫码。"
      : "先在桌面控制台生成扫码绑定，再用手机扫码。",
  };
}

export async function readDevicePairingStatus(startDir = process.cwd(), tools = {}) {
  const at = nowDate(tools);
  const { pairingPath, store } = await readStore(startDir);
  const activeSessions = withoutExpiredSessions(store.activeSessions, at);
  if (activeSessions.length !== (store.activeSessions || []).length) {
    await writeStore(pairingPath, {
      ...store,
      activeSessions,
      updatedAt: at.toISOString(),
    });
  }
  return summarizeStatus({
    ...store,
    activeSessions,
  });
}

export async function createDevicePairingSession(
  startDir = process.cwd(),
  payload = {},
  tools = {},
) {
  const at = nowDate(tools);
  const { pairingPath, store } = await readStore(startDir);
  const seed = randomToken(tools);
  const sessionId = `pair_${hashSecret(`${seed}:${at.toISOString()}`).slice(0, 18)}`;
  const pairingCode = buildPairingCode(seed);
  const expiresAt = new Date(at.getTime() + PAIRING_TTL_MS).toISOString();
  const mobileBaseUrl = safeText(payload.mobileBaseUrl, "");
  const qrPayload = [
    "codex-loop://pair",
    `?sessionId=${encodeURIComponent(sessionId)}`,
    `&code=${encodeURIComponent(pairingCode)}`,
    mobileBaseUrl ? `&url=${encodeURIComponent(mobileBaseUrl)}` : "",
  ].join("");
  const activeSessions = [
    ...withoutExpiredSessions(store.activeSessions, at),
    {
      id: sessionId,
      codeHash: hashSecret(pairingCode),
      status: "waiting_scan",
      mobileBaseUrl,
      createdAt: at.toISOString(),
      expiresAt,
    },
  ];

  await writeStore(pairingPath, {
    ...store,
    activeSessions,
    updatedAt: at.toISOString(),
  });

  return {
    status: "waiting_scan",
    sessionId,
    pairingCode,
    qrPayload,
    mobileBaseUrl,
    expiresAt,
    nextAction: "用手机 App 扫码，确认后会生成长期绑定；codex-loop 重启后不用重复扫码。",
  };
}

export async function confirmDevicePairing(
  startDir = process.cwd(),
  payload = {},
  tools = {},
) {
  const at = nowDate(tools);
  const { pairingPath, store } = await readStore(startDir);
  const sessionId = safeText(payload.sessionId, "");
  const pairingCode = safeText(payload.pairingCode, "");
  const activeSessions = withoutExpiredSessions(store.activeSessions, at);
  const session = activeSessions.find((item) => item.id === sessionId);

  if (!session) {
    throw new Error("扫码配对已过期，请重新扫码。");
  }
  if (session.codeHash !== hashSecret(pairingCode)) {
    throw new Error("配对码不正确，请重新扫码。");
  }

  const tokenSeed = randomToken(tools);
  const deviceToken = `cdl_${crypto
    .createHash("sha256")
    .update(`${tokenSeed}:${sessionId}:${at.toISOString()}`)
    .digest("base64url")}`;
  const deviceId = `device_${hashSecret(deviceToken).slice(0, 18)}`;
  const device = {
    id: deviceId,
    name: safeText(payload.deviceName, "我的手机"),
    tokenHash: hashSecret(deviceToken),
    pairedAt: at.toISOString(),
    lastSeenAt: at.toISOString(),
  };
  const pairedDevices = [
    ...(store.pairedDevices || []).filter((item) => item.id !== deviceId),
    device,
  ];

  await writeStore(pairingPath, {
    ...store,
    activeSessions: activeSessions.filter((item) => item.id !== sessionId),
    pairedDevices,
    updatedAt: at.toISOString(),
  });

  return {
    status: "paired",
    device: {
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
    },
    deviceToken,
    nextAction: "手机已长期绑定。以后这台电脑上的 codex-loop 重启后，可以直接重连。",
  };
}

export async function verifyPairedDevice(
  startDir = process.cwd(),
  payload = {},
  tools = {},
) {
  const at = nowDate(tools);
  const { pairingPath, store } = await readStore(startDir);
  const deviceId = safeText(payload.deviceId, "");
  const deviceToken = safeText(payload.deviceToken, "");
  const tokenHash = hashSecret(deviceToken);
  const pairedDevices = Array.isArray(store.pairedDevices) ? store.pairedDevices : [];
  const device = pairedDevices.find(
    (item) => item.id === deviceId && item.tokenHash === tokenHash,
  );

  if (!device) {
    return {
      valid: false,
      reason: "设备未绑定或令牌已失效，请重新扫码。",
    };
  }

  const nextDevice = {
    ...device,
    lastSeenAt: at.toISOString(),
  };
  await writeStore(pairingPath, {
    ...store,
    pairedDevices: pairedDevices.map((item) =>
      item.id === device.id ? nextDevice : item,
    ),
    updatedAt: at.toISOString(),
  });

  return {
    valid: true,
    device: {
      id: nextDevice.id,
      name: nextDevice.name,
      pairedAt: nextDevice.pairedAt,
      lastSeenAt: nextDevice.lastSeenAt,
    },
  };
}
