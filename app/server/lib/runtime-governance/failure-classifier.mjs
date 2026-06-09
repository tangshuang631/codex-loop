function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeFailureText({ message = "", promptGenerationError = "", latestSummary = "" } = {}) {
  return [
    safeText(message, ""),
    safeText(promptGenerationError, ""),
    safeText(latestSummary, ""),
  ]
    .filter(Boolean)
    .join("\n");
}

export function classifyContinuationFailure(input = {}) {
  const rawText = normalizeFailureText(input);
  const text = rawText.toLowerCase();
  const originalMessage = safeText(
    input.message,
    "上一轮续跑没有成功完成，请查看最近记录后再继续。",
  );
  const promptGenerator = safeText(input.promptGenerator, "");
  const promptGenerationError = safeText(input.promptGenerationError, "");

  if (
    promptGenerator === "workspace-check" ||
    includesAny(rawText, [/项目路径/u, /工作区/u, /workspace:missing/i, /workspace:not-directory/i])
  ) {
    return {
      category: "workspace_invalid",
      label: "工作区不可用",
      severity: "error",
      userMessage: originalMessage,
      nextAction: "先确认项目工作区仍然存在；如果项目路径变了，请重新选择工作区后再开始循环。",
    };
  }

  if (
    promptGenerator === "context-check" ||
    includesAny(rawText, [/文档/u, /规则/u, /context:missing/i, /context:not-file/i])
  ) {
    return {
      category: "context_missing",
      label: "缺少项目规则",
      severity: "error",
      userMessage: originalMessage,
      nextAction: "先补齐创建任务时指定的文档或开发规则；如果路径填错，请回到创建任务或管理页重新配置。",
    };
  }

  if (
    promptGenerator === "ollama" &&
    (promptGenerationError ||
      includesAny(text, [/ollama/i, /本地模型/u, /model/i, /generate/i]))
  ) {
    return {
      category: "ollama_generation",
      label: "本地模型生成失败",
      severity: "error",
      userMessage: "本地模型生成续跑指令失败：" + originalMessage,
      nextAction: "先确认 Ollama 已启动、模型已下载，并在设置里选择可用模型；修复后再重新开始循环。",
    };
  }

  if (includesAny(rawText, [/监督复盘/u, /人工确认/u, /supervisor/i])) {
    return {
      category: "supervisor_paused",
      label: "等待人工确认",
      severity: "warning",
      userMessage: originalMessage,
      nextAction: "先查看监督复盘结果和最近对话，确认方向后再手动开始下一轮。",
    };
  }

  if (
    includesAny(rawText, [
      /already dispatching/i,
      /still waiting/i,
      /等待 Codex 完成/u,
      /等待 Codex 回复/u,
      /正在处理当前轮/u,
      /正在发送/u,
      /不要重复点击/u,
    ])
  ) {
    return {
      category: "duplicate_dispatch",
      label: "正在等待 Codex",
      severity: "warning",
      userMessage: originalMessage,
      nextAction: "等待 Codex 完成当前轮后再继续，不要重复点击开始循环。",
    };
  }

  if (includesAny(rawText, [/预算/u, /token/i, /max.*minutes/i, /停止条件/u, /budget/i])) {
    return {
      category: "budget_limit",
      label: "已到停止条件",
      severity: "warning",
      userMessage: originalMessage,
      nextAction: "先查看本轮结果；如果还要继续，请调整停止条件或重新开始循环。",
    };
  }

  if (
    includesAny(rawText, [
      /未确认送达/u,
      /没有观察到目标线程/u,
      /没有找到目标 Codex 桌面线程/u,
      /desktop/i,
      /dispatch/i,
      /thread/i,
      /原生发送/u,
      /桌面端/u,
    ])
  ) {
    return {
      category: "codex_dispatch",
      label: "Codex 发送失败",
      severity: "error",
      userMessage: originalMessage,
      nextAction: "先检查线程绑定是否指向目标 Codex 桌面端窗口；确认桌面端仍打开后，重新开始循环。",
    };
  }

  return {
    category: "unknown",
    label: "续跑失败",
    severity: "error",
    userMessage: originalMessage,
    nextAction: "先查看最近记录里的失败详情；确认配置无误后再重新开始循环。",
  };
}
