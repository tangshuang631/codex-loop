import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDir, writeJson } from "../../../scripts/lib/fs-helpers.mjs";
import { resolveProjectLayout } from "./paths.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const bundledProjectsRoot = path.resolve(moduleDir, "../../..", "projects");
const DEFAULT_CONVERSATION = {
  language: "zh-CN",
  promptGenerator: {
    enabled: "auto",
    provider: "ollama",
    model: "qwen2.5:7b",
    baseUrl: "http://127.0.0.1:11434",
  },
  supervisor: {
    roleTraits:
      "同时扮演产品经理、测试人员、挑剔用户和监工：控制范围，关注可用性，主动发现偏离用户目标的问题。",
    testingRules:
      "Codex 完成一个清晰里程碑后再做独立验收；优先检查用户能否看懂状态、历史记录和下一步。",
    acceptanceCriteria:
      "每轮只推进一小批可验证改动；完成后必须能说明改了什么、如何验证、还有什么风险。",
  },
};

async function readJson(filePath, fallbackValue = null) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallbackValue;
    }

    throw error;
  }
}

function mergeObjects(baseValue, overrideValue) {
  if (!overrideValue || typeof overrideValue !== "object" || Array.isArray(overrideValue)) {
    return overrideValue ?? baseValue;
  }

  const nextValue = { ...(baseValue || {}) };
  for (const [key, value] of Object.entries(overrideValue)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue[key] === "object" &&
      !Array.isArray(baseValue[key])
    ) {
      nextValue[key] = mergeObjects(baseValue[key], value);
      continue;
    }

    nextValue[key] = value;
  }

  return nextValue;
}

function resolvedAdapterName(config) {
  return config.projectAdapter || config.projectName || "generic";
}

async function loadAdapter(codexLoopRoot, adapterId) {
  const candidatePath = path.join(codexLoopRoot, "projects", adapterId, "adapter.json");
  const fallbackPath = path.join(codexLoopRoot, "projects", "generic", "adapter.json");
  const bundledCandidatePath = path.join(
    bundledProjectsRoot,
    adapterId,
    "adapter.json",
  );
  const bundledFallbackPath = path.join(
    bundledProjectsRoot,
    "generic",
    "adapter.json",
  );

  for (const targetPath of [
    candidatePath,
    fallbackPath,
    bundledCandidatePath,
    bundledFallbackPath,
  ]) {
    const adapter = await readJson(targetPath);
    if (adapter) {
      return adapter;
    }
  }

  return null;
}

export async function ensureAdapterArtifacts(startDir = process.cwd()) {
  const layout = await resolveProjectLayout(startDir);
  const config = await readJson(layout.configPath);

  if (!config) {
    throw new Error(`Missing codex_loop config at ${layout.configPath}`);
  }

  const adapterId = resolvedAdapterName(config);
  const adapter = await loadAdapter(layout.codexLoopRoot, adapterId);
  if (!adapter) {
    throw new Error(`Could not resolve adapter profile for ${adapterId}`);
  }

  const settingsDir = path.join(layout.codexLoopRoot, "settings");
  const overridesPath = path.join(settingsDir, "user-overrides.json");
  await ensureDir(settingsDir);

  const overrides =
    (await readJson(overridesPath)) || {
      budgets: {},
      stopPolicy: {},
      threadPolicy: {},
      verification: {},
      conversation: DEFAULT_CONVERSATION,
    };

  const resolved = mergeObjects(
    {
      ...adapter,
      conversation: DEFAULT_CONVERSATION,
      budgets: {
        ...adapter.budgets,
        ...config.budgets,
      },
    },
    overrides,
  );

  return {
    adapter,
    overrides,
    resolved,
    paths: {
      overridesPath,
    },
  };
}

export async function readResolvedLoopProfile(startDir = process.cwd()) {
  return ensureAdapterArtifacts(startDir);
}

export async function saveUserOverrides(startDir = process.cwd(), payload) {
  const profile = await ensureAdapterArtifacts(startDir);
  const nextOverrides = mergeObjects(profile.overrides, payload);
  await writeJson(profile.paths.overridesPath, nextOverrides);
  return ensureAdapterArtifacts(startDir);
}
