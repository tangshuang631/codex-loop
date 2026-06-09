import fs from "node:fs/promises";
import path from "node:path";

function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

async function readSnippet(targetPath, maxChars = 1200) {
  try {
    const text = await fs.readFile(targetPath, "utf8");
    return text.slice(0, maxChars);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function collectDocsContext(draft) {
  const files = [
    ...(draft.docs?.ruleDocs || []),
    ...(draft.docs?.devDocs || []),
  ].slice(0, 6);

  const blocks = [];
  for (const filePath of files) {
    const content = await readSnippet(filePath);
    if (content) {
      blocks.push(`文档 ${path.basename(filePath)}：\n${content}`);
    }
  }
  return blocks;
}

function extractJsonObject(text) {
  const raw = safeText(text, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("planner response does not contain a JSON object");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function normalizeList(value, limit = 6) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => safeText(item, ""))
    .filter(Boolean)
    .slice(0, limit);
}

function buildFallbackPlan({ draft, answer }) {
  const objectiveSummary =
    safeText(draft.intent, "") ||
    safeText(answer, "") ||
    "继续推进当前项目的首个自动化任务";

  const suggestedProjectName =
    safeText(draft.projectName, "") ||
    safeText(draft.projectProfile?.detectedProjectName, "") ||
    path.basename(safeText(draft.workspaceRoot, "project"));

  const suggestedLoopName =
    safeText(draft.loopName, "") ||
    "核心链路推进";

  const suggestedBranch =
    safeText(draft.branch, "") ||
    safeText(draft.git?.branch, "") ||
    safeText(draft.git?.recommendedBranch, "dev");

  return {
    objectiveSummary,
    suggestedProjectName,
    suggestedLoopName,
    suggestedBranch,
    checklist: [
      "确认项目路径、项目名和当前目标是否正确",
      "确认 Git 状态、工作分支与后续提交策略",
      "确认规则文档、开发清单和验证命令是否需要纳入",
      "创建首个任务，并绑定到可见 Codex 线程",
    ],
    riskNotes: [
      draft.git?.hasGit ? "已检测到 Git，可继续规划提交与推送节奏" : "尚未检测到 Git，长任务前建议先初始化仓库",
      draft.docs?.ruleDocs?.length ? "已发现规则文档，可纳入续发上下文" : "未发现规则文档，建议手动补充",
    ].filter(Boolean),
    nextQuestion: "我先拿到这些建议了。接下来确认一下项目显示名是否使用建议值？",
  };
}

export async function generateLoopPlanWithOllama({
  draft,
  answer,
  model = "qwen2.5:7b",
  baseUrl = "http://127.0.0.1:11434",
  fetchImpl = globalThis.fetch,
}) {
  const docsContext = await collectDocsContext(draft);
  const system =
    "你是 codex-loop 的本地规划助手。请基于用户当前意图、项目文档线索、Git 状态和已有草稿，生成首个自动化任务的建议。只返回 JSON。";

  const prompt = [
    "请输出 JSON，不要输出解释。",
    "JSON 字段要求：",
    "{",
    '  "objectiveSummary": "一句话总结当前任务目标",',
    '  "suggestedProjectName": "建议项目名",',
    '  "suggestedLoopName": "建议任务名称",',
    '  "suggestedBranch": "建议分支",',
    '  "checklist": ["3到6条配置步骤"],',
    '  "riskNotes": ["0到5条风险提醒"],',
    '  "nextQuestion": "下一句最自然的追问"',
    "}",
    "",
    `用户刚刚的话：${safeText(answer, "暂无")}`,
    `已有意图：${safeText(draft.intent, "暂无")}`,
    `项目路径：${safeText(draft.workspaceRoot, "暂无")}`,
    `当前项目名：${safeText(draft.projectName, "暂无")}`,
    `当前任务名：${safeText(draft.loopName, "暂无")}`,
    `当前分支：${safeText(draft.branch, "暂无")}`,
    `Git 状态：${draft.git?.hasGit ? `已存在，当前分支 ${safeText(draft.git.branch, "未知")}` : "未检测到 Git"}`,
    `项目类型：${safeText(draft.projectProfile?.projectType, "generic")}`,
    `验证命令：${(draft.projectProfile?.commands || []).join("；") || "暂无"}`,
    "",
    docsContext.length ? docsContext.join("\n\n") : "未读取到额外文档片段。",
    "",
    "要求：",
    "1. 建议值要尽量贴近真实开发任务，而不是空泛命名。",
    "2. nextQuestion 必须是继续创建任务所需要的下一句自然追问。",
    "3. 不要编造不存在的文件或命令。",
  ].join("\n");

  const response = await fetchImpl(`${safeText(baseUrl, "http://127.0.0.1:11434")}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: safeText(model, "qwen2.5:7b"),
      stream: false,
      system,
      prompt,
    }),
  });

  if (!response.ok) {
    throw new Error(`ollama planner request failed with status ${response.status}`);
  }

  const data = await response.json();
  const parsed = extractJsonObject(data.response);
  return {
    objectiveSummary: safeText(parsed.objectiveSummary, ""),
    suggestedProjectName: safeText(parsed.suggestedProjectName, ""),
    suggestedLoopName: safeText(parsed.suggestedLoopName, ""),
    suggestedBranch: safeText(parsed.suggestedBranch, ""),
    checklist: normalizeList(parsed.checklist),
    riskNotes: normalizeList(parsed.riskNotes),
    nextQuestion: safeText(parsed.nextQuestion, ""),
  };
}

export async function planLoopWithFallback(options) {
  try {
    return {
      ...(await generateLoopPlanWithOllama(options)),
      source: "ollama",
    };
  } catch (error) {
    return {
      ...buildFallbackPlan(options),
      source: "template",
      error: error.message,
    };
  }
}
