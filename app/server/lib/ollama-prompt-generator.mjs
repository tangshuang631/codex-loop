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

  const system =
    language.toLowerCase().startsWith("en")
      ? "Generate the next concise user follow-up message for the same Codex thread. Return only the message."
      : "为同一个 Codex 线程生成下一条简洁、自然、可执行的用户续发消息。只返回消息正文。";

  const prompt = [
    `循环名称：${safeText(snapshot.config.loopName, snapshot.config.projectName)}`,
    `线程标题：${safeText(snapshot.thread.threadTitle, "未绑定线程")}`,
    `分支：${safeText(snapshot.config.branch, "dev")}`,
    `用户目标摘要：${safeText(snapshot.thread.lastUserInstructionSummary, "继续当前循环")}`,
    `上一轮 Codex 动作：${safeText(snapshot.thread.lastAssistantActionSummary, "暂无")}`,
    `最近 Codex 回复摘要：${safeText(snapshot.thread.latestCodexSummary, "暂无")}`,
    `最近本地摘要：${safeText(snapshot.thread.latestSummary || snapshot.state.recentSummary, "暂无")}`,
    "",
    "请结合这些内容，生成下一条更像真人续聊的消息。",
    "优先推动当前最高优先级且可验证的一小批任务。",
    "不要复述系统说明，不要解释原因。",
    "",
    contextBlocks.length ? contextBlocks.join("\n\n") : "无额外文档片段。",
    "",
    "如果仍不确定，可参考这个稳定回退模板的边界，但不要直接照抄：",
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
