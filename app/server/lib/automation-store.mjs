import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const AUTOMATION_DIR = path.join(os.homedir(), ".codex", "automations");

function nowIso() {
  return new Date().toISOString();
}

function parseTomlValue(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function parseToml(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1);
    result[key] = parseTomlValue(rawValue);
  }
  return result;
}

function serializeTomlValue(value) {
  if (typeof value === "number") {
    return String(value);
  }
  return `"${String(value ?? "").replaceAll('"', '\\"')}"`;
}

function serializeToml(record) {
  return `${Object.entries(record)
    .map(([key, value]) => `${key} = ${serializeTomlValue(value)}`)
    .join("\n")}\n`;
}

function parseIntervalMinutes(rrule = "") {
  const match = /INTERVAL=(\d+)/i.exec(rrule);
  return match ? Number(match[1]) : null;
}

function replaceIntervalMinutes(rrule = "", intervalMinutes) {
  const nextInterval = Math.max(1, Number(intervalMinutes) || 1);
  if (/INTERVAL=\d+/i.test(rrule)) {
    return rrule.replace(/INTERVAL=\d+/i, `INTERVAL=${nextInterval}`);
  }
  if (/^RRULE:/i.test(rrule)) {
    return `${rrule};INTERVAL=${nextInterval}`;
  }
  return `RRULE:FREQ=MINUTELY;INTERVAL=${nextInterval}`;
}

async function findAutomationFiles(rootDir) {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      files.push(path.join(rootDir, entry.name, "automation.toml"));
    }
    return files;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readAutomationRecord(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return {
      filePath,
      data: parseToml(text),
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function resolveHeartbeatAutomation(thread) {
  const automationFiles = await findAutomationFiles(AUTOMATION_DIR);
  const records = (
    await Promise.all(automationFiles.map((filePath) => readAutomationRecord(filePath)))
  ).filter(Boolean);

  if (!records.length) {
    return null;
  }

  const explicitId = String(thread?.heartbeatAutomation || "").trim();
  if (explicitId) {
    const matchedById = records.find((record) => record.data.id === explicitId);
    if (matchedById) {
      return matchedById;
    }
  }

  const boundThreadId = String(thread?.threadId || "").trim();
  if (boundThreadId) {
    const matchedByThread = records.find(
      (record) => record.data.target_thread_id === boundThreadId,
    );
    if (matchedByThread) {
      return matchedByThread;
    }
  }

  return records.find((record) => record.data.kind === "heartbeat") || null;
}

function buildAutomationSummary(record) {
  if (!record) {
    return {
      connected: false,
      id: "",
      name: "",
      status: "missing",
      kind: "",
      prompt: "",
      intervalMinutes: null,
      scheduleLabel: "未连接",
      targetThreadId: "",
      updatedAt: "",
    };
  }

  return {
    connected: true,
    id: record.data.id || "",
    name: record.data.name || "",
    status: record.data.status || "",
    kind: record.data.kind || "",
    prompt: record.data.prompt || "",
    intervalMinutes: parseIntervalMinutes(record.data.rrule),
    scheduleLabel: parseIntervalMinutes(record.data.rrule)
      ? `每 ${parseIntervalMinutes(record.data.rrule)} 分钟`
      : "未识别",
    targetThreadId: record.data.target_thread_id || "",
    updatedAt: record.data.updated_at
      ? new Date(Number(record.data.updated_at)).toISOString()
      : "",
  };
}

export async function readAutomationStatusForThread(thread = {}) {
  const record = await resolveHeartbeatAutomation(thread);
  return buildAutomationSummary(record);
}

export async function updateAutomationIntervalForThread(thread = {}, intervalMinutes) {
  const record = await resolveHeartbeatAutomation(thread);
  if (!record) {
    throw new Error("未找到可更新的 Codex 自动化，请先完成线程绑定或创建自动化。");
  }

  const nextData = {
    ...record.data,
    rrule: replaceIntervalMinutes(record.data.rrule, intervalMinutes),
    updated_at: Date.now(),
  };
  await fs.writeFile(record.filePath, serializeToml(nextData), "utf8");

  return {
    ...buildAutomationSummary({
      ...record,
      data: nextData,
    }),
    updated: true,
    syncedAt: nowIso(),
  };
}
