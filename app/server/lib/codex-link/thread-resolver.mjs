import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function safeText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizePathForMatch(value) {
  const text = safeText(value, "");
  if (!text) return "";
  return path
    .resolve(text)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

function normalizeSearchText(value) {
  return safeText(value, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
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

function messageText(payload = {}) {
  if (payload.type === "message") {
    return (payload.content || [])
      .map((item) => item.text || item.input_text || item.output_text || "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (payload.type === "agent_message") {
    return safeText(payload.message, "");
  }
  if (payload.type === "task_complete") {
    return safeText(payload.last_agent_message, "");
  }
  return "";
}

function parseCandidateLine(candidate, line) {
  let record = null;
  try {
    record = JSON.parse(line);
  } catch {
    return candidate;
  }

  const payload = record.payload || {};
  if (record.type === "session_meta") {
    candidate.threadId = safeText(payload.id, candidate.threadId);
    candidate.workspaceRoot = safeText(payload.cwd || payload.workspaceRoot, candidate.workspaceRoot);
    candidate.displayTitle = safeText(
      payload.title || payload.threadTitle || payload.name,
      candidate.displayTitle,
    );
    candidate.source = safeText(payload.originator || payload.source, candidate.source);
  }

  if (record.type === "turn_context") {
    candidate.workspaceRoot = safeText(payload.cwd, candidate.workspaceRoot);
  }

  const text = messageText(payload);
  if (text) {
    candidate.recentText.push(text.slice(0, 240));
  }

  if (!candidate.lastActivityAt || Date.parse(record.timestamp || "") > Date.parse(candidate.lastActivityAt)) {
    candidate.lastActivityAt = safeText(record.timestamp, candidate.lastActivityAt);
  }

  return candidate;
}

async function readCandidateFromFile(file) {
  const raw = await fs.readFile(file, "utf8");
  const initialThreadId = path.basename(file).match(/([0-9a-f]{4,}-[0-9a-f-]{8,})/i)?.[1] || "";
  const candidate = raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .slice(0, 80)
    .reduce(parseCandidateLine, {
      threadId: initialThreadId,
      workspaceRoot: "",
      displayTitle: "",
      recentText: [],
      source: "",
      lastActivityAt: "",
      sessionPath: file,
      searchText: "",
    });

  candidate.displayTitle =
    candidate.displayTitle ||
    path.basename(candidate.workspaceRoot || "", path.extname(candidate.workspaceRoot || "")) ||
    candidate.threadId;
  candidate.searchText = normalizeSearchText([
    candidate.threadId,
    candidate.workspaceRoot,
    candidate.displayTitle,
    ...candidate.recentText,
  ].join(" "));

  return candidate.threadId ? candidate : null;
}

export async function listCodexThreadCandidates({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  maxFiles = 120,
} = {}) {
  const sessionsRoot = path.join(codexHome, "sessions");
  const files = await walkJsonlFiles(sessionsRoot);
  const stats = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, stat: await fs.stat(file) };
      } catch {
        return null;
      }
    }),
  );

  const recentFiles = stats
    .filter(Boolean)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, maxFiles)
    .map((item) => item.file);

  const candidates = await Promise.all(recentFiles.map(readCandidateFromFile));
  return candidates.filter(Boolean);
}

function summarizeCandidate(candidate) {
  const title = safeText(candidate.displayTitle, "未命名窗口");
  const cwd = safeText(candidate.workspaceRoot, "未知项目路径");
  return `${title}（${candidate.threadId}，${cwd}）`;
}

export async function resolveCodexThread({
  workspaceRoot = "",
  windowTitle = "",
  candidates = null,
} = {}) {
  const allCandidates = candidates || await listCodexThreadCandidates();
  const normalizedWorkspace = normalizePathForMatch(workspaceRoot);
  const titleNeedle = normalizeSearchText(windowTitle);

  let matches = allCandidates;
  if (normalizedWorkspace) {
    matches = matches.filter(
      (candidate) => normalizePathForMatch(candidate.workspaceRoot) === normalizedWorkspace,
    );
  }

  if (titleNeedle) {
    const titleMatches = matches.filter((candidate) => candidate.searchText.includes(titleNeedle));
    if (titleMatches.length) {
      matches = titleMatches;
    }
  }

  if (matches.length === 1) {
    const candidate = matches[0];
    return {
      status: "matched",
      threadId: candidate.threadId,
      threadTitle: candidate.displayTitle,
      workspaceName: candidate.displayTitle,
      workspaceRoot: candidate.workspaceRoot,
      candidate,
      candidates: matches,
      userMessage: `已找到 Codex 窗口：${summarizeCandidate(candidate)}。`,
    };
  }

  if (matches.length > 1) {
    return {
      status: "ambiguous",
      threadId: "",
      candidates: matches,
      userMessage:
        `找到 ${matches.length} 个可能的 Codex 窗口，请补充更准确的窗口名，` +
        "或暂时手动填写线程 ID。",
    };
  }

  return {
    status: "unmatched",
    threadId: "",
    candidates: [],
    userMessage: "没有找到匹配的 Codex 窗口，请确认项目路径和窗口名，或手动填写线程 ID。",
  };
}
