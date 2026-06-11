export function presentStatusRowLabel(label) {
  if (label === "longrun") {
    return "长跑判断";
  }
  return label;
}

export function buildLongRunDecision({
  hasProductionStatus,
  closedLoopCount = 0,
  closedLoopTarget = 1,
  guidanceEvidenceCount = 0,
  guidanceEvidenceTarget = 1,
} = {}) {
  if (!hasProductionStatus) {
    return "";
  }

  if (
    closedLoopCount >= closedLoopTarget &&
    guidanceEvidenceCount >= guidanceEvidenceTarget
  ) {
    return "可以继续长时间运行，建议保持观察日志。";
  }

  const remainingLoops = Math.max(0, closedLoopTarget - closedLoopCount);
  const remainingGuidance = Math.max(
    0,
    guidanceEvidenceTarget - guidanceEvidenceCount,
  );

  return `暂时还不建议无人值守长跑，还差 ${remainingLoops} 轮真实闭环和 ${remainingGuidance} 次补充合并证据。`;
}

export function getConversationActionLabel({
  hasText,
  isGuidance,
  isLoop,
} = {}) {
  if (!hasText) {
    return "等待同步";
  }
  if (isGuidance) {
    return "待下一轮合并";
  }
  if (isLoop) {
    return "查看完整指令";
  }
  return "查看完整回复";
}

export function getConversationRoleLabel(role) {
  if (role === "guidance") {
    return "你的补充";
  }
  if (role === "user" || role === "loop") {
    return "codex-loop";
  }
  return "Codex";
}

export function getConversationEntryLabel({ isGuidance, isLoop } = {}) {
  if (isGuidance) {
    return "你的补充";
  }
  if (isLoop) {
    return "codex-loop 指令";
  }
  return "Codex 回复";
}

export function getConversationDetailKindLabel(kind) {
  if (kind === "command_output") {
    return "命令";
  }
  if (kind === "file_change") {
    return "文件";
  }
  if (kind === "script_snippet") {
    return "脚本";
  }
  if (kind === "screenshot") {
    return "截图";
  }
  if (kind === "test_log") {
    return "验证";
  }
  if (kind === "runtime_detail") {
    return "详情";
  }
  return "记录";
}

export function buildStatusHeroSummary({
  headline = "",
  detail = "",
  nextAction = "",
  fallbackHeadline = "当前正在同步状态",
  fallbackDetail = "这一轮的最新状态会继续显示在这里。",
  fallbackNextAction = "先看最新记录，再决定是否继续发送下一轮。",
} = {}) {
  const safeHeadline = String(headline || "").trim() || fallbackHeadline;
  const safeDetail = String(detail || "").trim() || fallbackDetail;
  const safeNextAction = String(nextAction || "").trim() || fallbackNextAction;

  return {
    headline: safeHeadline,
    detail: safeDetail,
    nextAction: safeNextAction,
  };
}

function formatProductionDiagnosisCategory(category) {
  if (category === "completion_missing_supervisor_review") {
    return "Codex 已完成当前轮，但本地复盘还没收齐";
  }
  if (category === "dispatch_timeout") {
    return "这一轮发送后等待过久";
  }
  if (category === "followup_failed") {
    return "这一轮续跑发送失败";
  }
  return "";
}

export function buildProductionFocusSummary({
  productionStatus = null,
  productionPreflight = null,
  productionObservation = null,
  closedLoopCount = 0,
  closedLoopTarget = 1,
  guidanceEvidenceCount = 0,
  guidanceEvidenceTarget = 1,
} = {}) {
  if (!productionStatus && !productionPreflight) {
    return {
      summary: "",
      attention: "",
      nextAction: "",
    };
  }

  const maturity = productionStatus?.maturity || {};
  const readiness = productionStatus?.readiness || {};
  const diagnosis =
    productionObservation?.diagnosis || productionStatus?.diagnosis || {};
  const waiting =
    productionObservation?.waiting || productionStatus?.waiting || {};
  const waitingMinutes = Number(waiting.waitingMinutes);
  const needsHumanCheck = Boolean(waiting.needsHumanCheck);
  const remainingLoops = Math.max(0, closedLoopTarget - closedLoopCount);
  const remainingGuidance = Math.max(
    0,
    guidanceEvidenceTarget - guidanceEvidenceCount,
  );
  const diagnosisLabel = formatProductionDiagnosisCategory(diagnosis.category);
  const diagnosisMessage =
    String(diagnosis.userMessage || "").trim() || diagnosisLabel;

  if (productionStatus?.status === "waiting") {
    const waitingPrefix =
      Number.isFinite(waitingMinutes) && waitingMinutes > 0
        ? `已等待约 ${waitingMinutes} 分钟`
        : "正在等待 Codex 完成当前轮";
    return {
      summary: needsHumanCheck
        ? `${waitingPrefix}，建议人工确认后再继续`
        : `${waitingPrefix}，系统不会抢发下一条`,
      attention:
        diagnosisMessage ||
        "当前仍在等待真实结果返回，避免打断 Codex 正在处理的任务。",
      nextAction:
        String(diagnosis.nextAction || "").trim() ||
        String(productionStatus?.nextAction || "").trim() ||
        (needsHumanCheck
          ? "先看最新对话，确认 Codex 是否停在待你确认的位置。"
          : "等 Codex 完成后，再决定是否继续下一轮。"),
    };
  }

  if (maturity.canLongRun) {
    return {
      summary: "已具备继续长跑的基础证据",
      attention:
        String(maturity.summary || "").trim() || "继续观察稳定性即可。",
      nextAction:
        String(productionStatus?.nextAction || "").trim() ||
        "继续观察真实运行日志，按需补充引导。",
    };
  }

  const missingParts = [];
  if (remainingLoops > 0) {
    missingParts.push(`还差 ${remainingLoops} 轮真实闭环`);
  }
  if (remainingGuidance > 0) {
    missingParts.push(`还差 ${remainingGuidance} 次补充合并证据`);
  }

  return {
    summary:
      missingParts.join("，") ||
      String(maturity.summary || readiness.summary || "").trim() ||
      "暂时还不建议无人值守长跑",
    attention:
      diagnosisMessage ||
      String(readiness.summary || maturity.summary || "").trim() ||
      "当前还有生产化缺口需要补齐。",
    nextAction:
      String(productionStatus?.nextAction || "").trim() ||
      String(readiness.nextAction || "").trim() ||
      String(productionPreflight?.nextAction || "").trim() ||
      "先补齐真实闭环验证，再投入长期运行。",
  };
}

export function buildModelPipelineSummary(processStatus = {}) {
  const instructionLabel = String(
    processStatus?.latestInstructionSourceLabel || "",
  ).trim();
  const instructionDetail = String(
    processStatus?.latestInstructionSourceDetail || "",
  ).trim();
  const summaryLabel = String(
    processStatus?.latestCodexSummarySourceLabel || "",
  ).trim();
  const summaryDetail = String(
    processStatus?.latestCodexSummarySourceDetail || "",
  ).trim();

  const headlineParts = [];
  if (instructionLabel) {
    headlineParts.push(`指令：${instructionLabel}`);
  }
  if (summaryLabel) {
    headlineParts.push(`回复：${summaryLabel}`);
  }

  const headline = headlineParts.join("；");
  const detail = [instructionDetail, summaryDetail].filter(Boolean).join(" ");

  return {
    headline,
    detail,
  };
}
