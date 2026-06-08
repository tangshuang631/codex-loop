import fs from "node:fs/promises";
import path from "node:path";

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
  const generated = safeText(data.response, "");
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
  const generated = safeText(data.response, "");
  if (!generated) {
    throw new Error("ollama returned an empty summary");
  }
  return generated;
}
