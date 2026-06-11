import fs from "node:fs/promises";
import path from "node:path";

import {
  buildDecisiveContinuationInstruction,
  shouldAutoResolveHumanDeferral,
} from "./npc/confirmation-policy.mjs";

function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

async function readSnippet(targetPath, maxChars = 1800) {
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

function extractJsonMessage(text) {
  const value = safeText(text, "");
  if (!value) return "";

  const candidates = [value];
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(value.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "string") return safeText(parsed, "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const key of ["message", "prompt", "instruction", "text", "content", "next"]) {
          const picked = safeText(parsed[key], "");
          if (picked) return picked;
        }
      }
      if (Array.isArray(parsed)) {
        const picked = parsed.map((item) => safeText(item, "")).filter(Boolean).join("\n");
        if (picked) return picked;
      }
    } catch {
      // Keep trying other candidates; malformed JSON should not block a usable prompt.
    }
  }

  return "";
}

function shouldReplaceOrdinaryUserDeferral(text, context = "") {
  const value = safeText(text, "");
  return shouldAutoResolveHumanDeferral({
    text: value,
    context,
  });
}

function cleanGeneratedMessage(value, maxChars = 900, options = {}) {
  let text = safeText(value, "");
  if (!text) return "";

  text = text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think\b[^>]*>/gi, "")
    .replace(/```(?:json|text|markdown)?\s*([\s\S]*?)```/gi, "$1")
    .trim();

  text = extractJsonMessage(text) || text;
  text = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(以下是|生成结果|我的思考|原因[:：]|解释[:：])/i.test(line))
    .join("\n")
    .replace(/^(?:message|prompt|instruction|text|下一步指令|回复)[:：]\s*/i, "")
    .trim();

  if (
    options.replaceOrdinaryUserDeferral &&
    shouldReplaceOrdinaryUserDeferral(text, options.riskContext)
  ) {
    text = buildDecisiveContinuationInstruction({
      englishPreferred: options.englishPreferred,
    });
  }

  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const boundary = Math.max(
    clipped.lastIndexOf("。"),
    clipped.lastIndexOf("！"),
    clipped.lastIndexOf("？"),
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("\n"),
  );
  return `${clipped.slice(0, boundary > 160 ? boundary + 1 : maxChars).trim()}…`;
}

async function collectContextBlocks(snapshot) {
  const files = Array.isArray(snapshot.config.startContextPaths)
    ? snapshot.config.startContextPaths
    : [];

  const blocks = [];
  for (const filePath of files) {
    const content = await readSnippet(filePath);
    if (content) {
      blocks.push(`参考文档 ${path.basename(filePath)}：\n${content}`);
    }
  }
  return blocks;
}

export async function generatePromptWithOllama({
  snapshot,
  fallbackPrompt,
  fetchImpl = globalThis.fetch,
}) {
  const generator = snapshot.profile?.resolved?.conversation?.promptGenerator || {};
  const baseUrl = safeText(generator.baseUrl, "http://127.0.0.1:11434");
  const model = safeText(generator.model, "qwen2.5:7b");
  const language = safeText(snapshot.profile?.resolved?.conversation?.language, "zh-CN");
  const contextBlocks = await collectContextBlocks(snapshot);
  const englishPreferred = language.toLowerCase().startsWith("en");
  const pendingUserGuidance = safeText(snapshot.thread.pendingUserGuidance, "");
  const supervisorRuleLines = buildSupervisorRuleLines(snapshot, englishPreferred);
  const supervisorEvidenceLines = buildSupervisorEvidenceLines(
    snapshot,
    englishPreferred,
  );

  const system = englishPreferred
    ? "Act as the product-manager NPC for codex-loop. Generate the next concise follow-up for the same Codex thread. Make low-risk product and design decisions from project docs and rules. Ask the human only for destructive, irreversible, credential, permission, strong security, or high-cost choices. Return only the message."
    : "你是 codex-loop 的产品经理 NPC。为同一个 Codex 线程生成下一条简洁、自然、可执行的续跑消息。普通产品边界、方案取舍、实现顺序由你基于项目文档、开发规则和用户目标直接判断并回复；只有涉及高风险删除、不可逆操作、凭证权限、强安全风险或代价差异很大的选择，才要求人工确认。只返回消息正文。";

  const prompt = [
    `循环名称：${safeText(snapshot.config.loopName, snapshot.config.projectName)}`,
    `线程标题：${safeText(snapshot.thread.threadTitle, "未绑定线程")}`,
    `分支：${safeText(snapshot.config.branch, "dev")}`,
    `用户目标摘要：${safeText(snapshot.thread.lastUserInstructionSummary, "继续当前循环")}`,
    `上一轮 Codex 动作：${safeText(snapshot.thread.lastAssistantActionSummary, "暂无")}`,
    `最近 Codex 回复摘要：${safeText(snapshot.thread.latestCodexSummary, "暂无")}`,
    `最近本地摘要：${safeText(snapshot.thread.latestSummary || snapshot.state.recentSummary, "暂无")}`,
    supervisorRuleLines.length ? supervisorRuleLines.join("\n") : "",
    supervisorEvidenceLines.length ? supervisorEvidenceLines.join("\n") : "",
    pendingUserGuidance
      ? `用户临时补充：${pendingUserGuidance}`
      : "用户临时补充：暂无",
    "",
    pendingUserGuidance
      ? englishPreferred
        ? "The user added this guidance while Codex was working. Merge it into the next instruction together with the latest Codex reply and project rules. Do not copy it mechanically."
        : "用户是在 Codex 当前轮工作期间补充的这句话。请结合 Codex 最新回复、项目文档和开发规则，把它融合到下一条指令里，不要机械照抄。"
      : "",
    englishPreferred
      ? "Generate the next message as a practical PM/NPC decision. If Codex asks for ordinary product or design confirmation, choose the safest small verified path and tell it to continue. Do not defer to the human unless the choice is destructive, irreversible, credential/permission-related, security-sensitive, or has very different costs."
      : "请像真实产品经理/NPC 一样生成下一条消息。如果 Codex 在询问普通产品边界、设计方案或实现偏好，请直接代表用户选择最安全、最小、可验证的路径，并让它继续。不要写“等用户确认后再继续”，除非涉及高风险删除、不可逆操作、凭证权限、强安全风险或代价差异很大的选择。",
    englishPreferred
      ? "Output contract: the first sentence must directly tell Codex the next concrete action. If verification is needed, add only the 1-3 most important checks. Prefer evidence from the previous failed verification, the latest Codex reply, the user guidance, and project docs."
      : "输出契约：第一句必须直接告诉 Codex 下一步做什么。如果需要验证，只补 1-3 个最关键检查点。优先引用上一轮失败验收、最新 Codex 回复、用户补充和项目文档里的证据。",
    englishPreferred
      ? "Do not restate known background, do not repeat long summaries, do not output polite filler, and do not waste tokens."
      : "不要复述已知背景，不要重复长摘要，不要输出客套废话，不要浪费 token。",
    englishPreferred
      ? "Keep it concise. Do not output JSON. Do not explain your generation process."
      : "保持简洁，不输出 JSON，不解释生成原因，不复述系统说明。",
    "",
    contextBlocks.length ? contextBlocks.join("\n\n") : "无额外文档片段。",
    "",
    englishPreferred
      ? "Fallback boundary for reference, do not copy mechanically:"
      : "可参考这个稳定回退模板的边界，但不要机械照抄：",
    fallbackPrompt,
  ].join("\n");

  const response = await fetchImpl(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      system,
      prompt,
    }),
  });

  if (!response.ok) {
    throw new Error(`ollama request failed with status ${response.status}`);
  }

  const data = await response.json();
  const generated = cleanGeneratedMessage(data.response, 900, {
    replaceOrdinaryUserDeferral: true,
    englishPreferred,
    riskContext: [
      snapshot.thread.latestCodexSummary,
      snapshot.thread.lastAssistantActionSummary,
      snapshot.thread.latestSummary,
      snapshot.state.recentSummary,
    ].join("\n"),
  });
  if (!generated) {
    throw new Error("ollama returned an empty prompt");
  }
  return generated;
}
export async function generateCodexSummaryWithOllama({
  snapshot,
  codexText,
  fetchImpl = globalThis.fetch,
}) {
  const generator = snapshot.profile?.resolved?.conversation?.promptGenerator || {};
  const baseUrl = safeText(generator.baseUrl, "http://127.0.0.1:11434");
  const model = safeText(generator.model, "qwen2.5:7b");
  const language = safeText(snapshot.profile?.resolved?.conversation?.language, "zh-CN");
  const sourceText = safeText(codexText, "");
  if (!sourceText) {
    return "";
  }

  const system =
    language.toLowerCase().startsWith("en")
      ? "Summarize the latest Codex reply for a product dashboard. Return only the concise summary."
      : "把最新 Codex 回复整理成产品首页可读的中文摘要。只返回摘要正文。";

  const prompt = [
    `循环名称：${safeText(snapshot.config.loopName, snapshot.config.projectName)}`,
    `用户目标摘要：${safeText(snapshot.thread.lastUserInstructionSummary, "继续当前循环")}`,
    "请用 1-2 句总结 Codex 这一轮真正完成了什么、是否需要用户注意。",
    "不要输出 JSON，不要输出调试信息，不要复述线程 ID。",
    "",
    "Codex 原始回复：",
    sourceText.slice(0, 6000),
  ].join("\n");

  const response = await fetchImpl(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      system,
      prompt,
    }),
  });

  if (!response.ok) {
    throw new Error(`ollama summary request failed with status ${response.status}`);
  }

  const data = await response.json();
  const generated = cleanGeneratedMessage(data.response, 360);
  if (!generated) {
    throw new Error("ollama returned an empty summary");
  }
  return generated;
}

function cleanGeneratedList(value, maxItems = 5, maxChars = 140) {
  const items = Array.isArray(value)
    ? value
    : safeText(value, "").split(/\r?\n|[,，]/u);
  return items
    .map((item) => cleanGeneratedMessage(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function compactEvidenceText(value, maxChars = 900) {
  const text = safeText(value, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function buildSupervisorEvidenceLines(snapshot, englishPreferred = false) {
  const thread = snapshot.thread || {};
  const lines = [];
  const previousInstruction = compactEvidenceText(
    thread.lastDispatchPrompt || thread.lastSupervisorInstruction,
    1000,
  );
  const previousSupervisorInstruction = compactEvidenceText(
    thread.lastSupervisorInstruction,
    700,
  );
  const verificationStatus = safeText(thread.lastSupervisorVerificationStatus, "");
  const verificationSummary = compactEvidenceText(
    thread.lastSupervisorVerificationSummary,
    700,
  );
  const verificationResults = Array.isArray(thread.lastSupervisorVerificationResults)
    ? thread.lastSupervisorVerificationResults
    : [];

  if (previousInstruction) {
    lines.push(
      englishPreferred
        ? `Previous codex-loop instruction: ${previousInstruction}`
        : `上一条 codex-loop 指令：${previousInstruction}`,
    );
  }
  if (
    previousSupervisorInstruction &&
    previousSupervisorInstruction !== previousInstruction
  ) {
    lines.push(
      englishPreferred
        ? `Previous supervisor instruction: ${previousSupervisorInstruction}`
        : `上一轮监督指令：${previousSupervisorInstruction}`,
    );
  }
  if (verificationStatus || verificationSummary) {
    const statusText = verificationStatus || (englishPreferred ? "unknown" : "未知");
    lines.push(
      englishPreferred
        ? `Latest independent verification: ${statusText}${
            verificationSummary ? `; ${verificationSummary}` : ""
          }`
        : `最近独立验收：${statusText}${
            verificationSummary ? `；${verificationSummary}` : ""
          }`,
    );
  }

  for (const result of verificationResults.slice(0, 3)) {
    const command = compactEvidenceText(result?.command, 160);
    const ok = result?.ok === true;
    const output = compactEvidenceText(result?.output || result?.summary, 360);
    if (!command && !output) {
      continue;
    }
    lines.push(
      englishPreferred
        ? `Verification evidence: ${command || "command not recorded"} -> ${
            ok ? "passed" : "failed or skipped"
          }${output ? `; ${output}` : ""}`
        : `验收证据：${command || "未记录命令"} -> ${
            ok ? "通过" : "失败或跳过"
          }${output ? `；${output}` : ""}`,
    );
  }

  return lines;
}

function buildSupervisorRuleLines(snapshot, englishPreferred = false) {
  const supervisor = snapshot.profile?.resolved?.conversation?.supervisor || {};
  const roleTraits = safeText(supervisor.roleTraits, "");
  const testingRules = safeText(supervisor.testingRules, "");
  const acceptanceCriteria = safeText(supervisor.acceptanceCriteria, "");
  const lines = [];

  if (roleTraits) {
    lines.push(
      englishPreferred
        ? `Supervisor role traits: ${roleTraits}`
        : `NPC 角色特性：${roleTraits}`,
    );
  }
  if (testingRules) {
    lines.push(
      englishPreferred
        ? `Supervisor testing rules: ${testingRules}`
        : `NPC 测试规则：${testingRules}`,
    );
  }
  if (acceptanceCriteria) {
    lines.push(
      englishPreferred
        ? `Supervisor acceptance criteria: ${acceptanceCriteria}`
        : `NPC 验收标准：${acceptanceCriteria}`,
    );
  }

  return lines;
}

function parseMilestoneReviewResponse(text) {
  const value = safeText(text, "");
  if (!value) {
    return null;
  }

  const candidates = [value];
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(value.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          summary: cleanGeneratedMessage(
            parsed.summary || parsed.review || parsed.result || "",
            420,
          ),
          nextInstruction: cleanGeneratedMessage(
            parsed.nextInstruction ||
              parsed.next_instruction ||
              parsed.instruction ||
              parsed.next ||
              "",
            700,
            { replaceOrdinaryUserDeferral: true },
          ),
          shouldContinue: parsed.shouldContinue !== false,
          needsIndependentVerification: Boolean(
            parsed.needsIndependentVerification ??
              parsed.needs_independent_verification ??
              parsed.needIndependentVerification ??
              false,
          ),
          verificationCommands: cleanGeneratedList(
            parsed.verificationCommands ||
              parsed.verification_commands ||
              parsed.commands ||
              [],
            5,
            120,
          ),
          acceptanceFocus: cleanGeneratedList(
            parsed.acceptanceFocus ||
              parsed.acceptance_focus ||
              parsed.acceptance ||
              parsed.testFocus ||
              [],
            5,
            120,
          ),
          risks: Array.isArray(parsed.risks)
            ? parsed.risks.map((item) => cleanGeneratedMessage(item, 120)).filter(Boolean)
            : [],
        };
      }
    } catch {
      // Try the next candidate, then fall back to free-form text.
    }
  }

  const cleaned = cleanGeneratedMessage(value, 700, {
    replaceOrdinaryUserDeferral: true,
  });
  return cleaned
    ? {
        summary: cleaned.slice(0, 420),
        nextInstruction: cleaned,
        shouldContinue: true,
        needsIndependentVerification: false,
        verificationCommands: [],
        acceptanceFocus: [],
        risks: [],
      }
    : null;
}

export async function generateMilestoneReviewWithOllama({
  snapshot,
  fallbackReview,
  fetchImpl = globalThis.fetch,
}) {
  const generator = snapshot.profile?.resolved?.conversation?.promptGenerator || {};
  const baseUrl = safeText(generator.baseUrl, "http://127.0.0.1:11434");
  const model = safeText(generator.model, "qwen2.5:7b");
  const language = safeText(snapshot.profile?.resolved?.conversation?.language, "zh-CN");
  const englishPreferred = language.toLowerCase().startsWith("en");
  const latestCodexText = safeText(
    snapshot.codexConversation?.latestCompletion?.text,
    snapshot.thread.latestCodexSummary,
  );
  const pendingUserGuidance = safeText(snapshot.thread.pendingUserGuidance, "");
  const supervisorRuleLines = buildSupervisorRuleLines(snapshot, englishPreferred);
  const supervisorEvidenceLines = buildSupervisorEvidenceLines(
    snapshot,
    englishPreferred,
  );
  const verificationCommands = [
    ...(Array.isArray(snapshot.config?.verification?.commands)
      ? snapshot.config.verification.commands
      : []),
    ...(Array.isArray(snapshot.profile?.resolved?.verification?.commands)
      ? snapshot.profile.resolved.verification.commands
      : []),
    ...(Array.isArray(fallbackReview?.verificationCommands)
      ? fallbackReview.verificationCommands
      : []),
  ]
    .map((command) => safeText(command, ""))
    .filter(Boolean)
    .slice(0, 6);
  const contextBlocks = await collectContextBlocks(snapshot);

  const system = englishPreferred
    ? "You are codex-loop's supervisor NPC: product manager, QA tester, and realistic user. Review Codex's latest completed milestone, decide whether it is safe to continue, and write the next concise instruction. Do not ask the human for ordinary product/design choices; decide from docs and rules. Return strict JSON only."
    : "你是 codex-loop 的监督 NPC，同时扮演产品经理、测试人员和真实挑剔用户。请复盘 Codex 刚完成的里程碑，判断是否可以继续，并生成下一条简洁指令。普通产品/设计/实现取舍由你基于文档和规则决定，不要交回给用户。只返回严格 JSON。";

  const prompt = [
    englishPreferred
      ? "Return JSON: {\"summary\":\"...\",\"nextInstruction\":\"...\",\"shouldContinue\":true,\"needsIndependentVerification\":true,\"verificationCommands\":[\"...\"],\"acceptanceFocus\":[\"...\"],\"risks\":[\"...\"]}"
      : "请返回 JSON：{\"summary\":\"复盘摘要\",\"nextInstruction\":\"下一条发给 Codex 的简洁指令\",\"shouldContinue\":true,\"needsIndependentVerification\":true,\"verificationCommands\":[\"建议验证命令\"],\"acceptanceFocus\":[\"验收重点\"],\"risks\":[\"需要注意的问题\"]}",
    "",
    `Task: ${safeText(snapshot.config.loopName, snapshot.config.projectName)}`,
    `Branch: ${safeText(snapshot.config.branch, "dev")}`,
    `Thread: ${safeText(snapshot.thread.threadTitle, snapshot.thread.threadId)}`,
    englishPreferred
      ? `User goal: ${safeText(snapshot.thread.lastUserInstructionSummary, "Continue current task")}`
      : `用户目标：${safeText(snapshot.thread.lastUserInstructionSummary, "继续当前任务")}`,
    englishPreferred
      ? `Latest Codex completion:\n${latestCodexText.slice(0, 7000)}`
      : `Codex 最新完成结果：\n${latestCodexText.slice(0, 7000)}`,
    supervisorRuleLines.length ? supervisorRuleLines.join("\n") : "",
    supervisorEvidenceLines.length ? supervisorEvidenceLines.join("\n") : "",
    pendingUserGuidance
      ? englishPreferred
        ? `User added guidance while Codex was working: ${pendingUserGuidance}`
        : `用户在 Codex 工作期间补充的引导：${pendingUserGuidance}`
      : "",
    verificationCommands.length
      ? englishPreferred
        ? `Available verification commands: ${verificationCommands.join(" ; ")}`
        : `可用验证命令：${verificationCommands.join(" ; ")}`
      : englishPreferred
        ? "Available verification commands: none detected"
        : "可用验证命令：暂未探测到",
    "",
    englishPreferred
      ? "Act like a PM + QA + real user: identify what is done, what still feels weak, whether independent testing is needed now, and write the next short actionable instruction. Avoid token-wasteful restatement."
      : "请像产品经理 + 测试人员 + 真实用户一样判断：完成了什么、哪里还不够好、是否需要现在做独立测试、下一步应该让 Codex 做什么。不要重复大段背景，不要浪费 token。",
    englishPreferred
      ? "JSON contract: summary should be 1-2 sentences; nextInstruction should start with the next concrete action and stay within 2 short sentences; verificationCommands and acceptanceFocus should keep only the most important items."
      : "JSON 契约：summary 保持 1-2 句；nextInstruction 必须以上一条最具体的下一步动作开头，最多 2 句；verificationCommands 和 acceptanceFocus 只保留最重要的几项。",
    englishPreferred
      ? "Only set shouldContinue=false for destructive, irreversible, credential, permission, security, high-cost, or genuinely blocked choices."
      : "只有遇到高风险删除、不可逆操作、凭证权限、安全强风险、高成本选择或真正阻塞时，才把 shouldContinue 设为 false。",
    "",
    contextBlocks.length ? contextBlocks.join("\n\n") : "",
    "",
    englishPreferred ? "Fallback review if model is unsure:" : "如果模型不确定，可参考这个降级复盘边界：",
    JSON.stringify(fallbackReview),
  ].join("\n");

  const response = await fetchImpl(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      system,
      prompt,
    }),
  });

  if (!response.ok) {
    throw new Error(`ollama milestone review request failed with status ${response.status}`);
  }

  const data = await response.json();
  const parsed = parseMilestoneReviewResponse(data.response);
  if (!parsed?.summary && !parsed?.nextInstruction) {
    throw new Error("ollama returned an empty milestone review");
  }
  return parsed;
}
