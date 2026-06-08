import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function safeText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function summarize(text, maxLength = 360) {
  const compact = safeText(text, "").replace(/\s+/g, " ");
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

async function walkJsonlFiles(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function findSessionFile(threadId) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sessionsRoot = path.join(codexHome, "sessions");
  const files = await walkJsonlFiles(sessionsRoot);
  const matches = files.filter((file) => file.includes(threadId));
  if (!matches.length) return "";

  const stats = await Promise.all(
    matches.map(async (file) => ({ file, stat: await fs.stat(file) })),
  );
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats[0].file;
}

function messageText(payload) {
  if (payload?.type === "message") {
    return (payload.content || [])
      .map((item) => item.text || item.input_text || item.output_text || "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (payload?.type === "agent_message") {
    return safeText(payload.message, "");
  }
  if (payload?.type === "task_complete") {
    return safeText(payload.last_agent_message, "");
  }
  return "";
}

function extractDelegatedInput(text) {
  const value = safeText(text, "");
  if (!value.includes("<codex_delegation>")) return value;

  const inputMatch = value.match(/<input>([\s\S]*?)<\/input>/i);
  if (!inputMatch) return "";

  return safeText(inputMatch[1], "");
}

function isNoiseMessage(text) {
  const value = safeText(text, "");
  if (!value) return true;
  return [
    "<environment_context>",
    "<permissions instructions>",
    "<turn_aborted>",
    "<collaboration_mode>",
    "<personality_spec>",
    "Filesystem sandboxing defines",
    "Approval policy is currently",
  ].some((pattern) => value.includes(pattern));
}

function conversationEntry(record) {
  const payload = record.payload || {};
  const text = extractDelegatedInput(messageText(payload));
  if (!text || isNoiseMessage(text)) return null;

  if (record.type === "response_item" && payload.type === "message") {
    const role = payload.role === "user" ? "user" : "assistant";
    return {
      role,
      label: role === "user" ? "codex-loop 指令" : "Codex 回复",
      at: record.timestamp || "",
      text,
      preview: summarize(text),
      phase: payload.phase || "",
      completed: false,
    };
  }

  if (record.type === "event_msg" && payload.type === "agent_message") {
    return {
      role: "assistant",
      label: "Codex 回复",
      at: record.timestamp || "",
      text,
      preview: summarize(text),
      phase: payload.phase || "commentary",
      completed: false,
    };
  }

  if (record.type === "event_msg" && payload.type === "task_complete") {
    return {
      role: "assistant",
      label: "Codex 完成摘要",
      at: record.timestamp || "",
      text,
      preview: summarize(text),
      phase: "final",
      completed: true,
    };
  }

  return null;
}

function normalizeConversationEntry(entry) {
  if (!entry) return null;
  if (entry.role === "user") {
    return { ...entry, label: "codex-loop 指令" };
  }
  if (entry.completed) {
    return { ...entry, label: "Codex 完成摘要" };
  }
  return { ...entry, label: "Codex 回复" };
}

function normalizeEntryText(text) {
  return safeText(text, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeConversationEntries(entries) {
  const deduped = [];
  const indexByKey = new Map();

  for (const entry of entries) {
    const normalizedText = normalizeEntryText(entry.text);
    if (!normalizedText) continue;

    const key = `${entry.role}:${normalizedText}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, deduped.length);
      deduped.push(entry);
      continue;
    }

    const existing = deduped[existingIndex];
    const currentAt = Date.parse(entry.at || "");
    const existingAt = Date.parse(existing.at || "");
    const shouldPreferCurrent =
      Boolean(entry.completed && !existing.completed) ||
      (entry.completed === existing.completed &&
        Number.isFinite(currentAt) &&
        (!Number.isFinite(existingAt) || currentAt > existingAt));

    if (shouldPreferCurrent) {
      deduped[existingIndex] = entry;
    }
  }

  return deduped.sort((a, b) => {
    const left = Date.parse(a.at || "");
    const right = Date.parse(b.at || "");
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return left - right;
  });
}

export async function readCodexConversationMirror(threadId, { limit = 8 } = {}) {
  const cleanThreadId = safeText(threadId, "");
  if (!cleanThreadId) {
    return {
      threadId: "",
      sessionPath: "",
      entries: [],
      latestUser: null,
      latestAssistant: null,
      latestCompletion: null,
    };
  }

  const sessionPath = await findSessionFile(cleanThreadId);
  if (!sessionPath) {
    return {
      threadId: cleanThreadId,
      sessionPath: "",
      entries: [],
      latestUser: null,
      latestAssistant: null,
      latestCompletion: null,
    };
  }

  const raw = await fs.readFile(sessionPath, "utf8");
  const entries = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return normalizeConversationEntry(conversationEntry(JSON.parse(line)));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const deduped = dedupeConversationEntries(entries);

  const latestUser = [...deduped].reverse().find((entry) => entry.role === "user") || null;
  const latestAssistant = [...deduped].reverse().find((entry) => entry.role === "assistant") || null;
  const latestCompletion =
    [...deduped].reverse().find((entry) => entry.role === "assistant" && entry.completed) || null;

  return {
    threadId: cleanThreadId,
    sessionPath,
    entries: deduped.slice(-limit).reverse(),
    latestUser,
    latestAssistant,
    latestCompletion,
  };
}
