function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

const HUMAN_DEFERRAL_PATTERN =
  /(?:如果)?没有偏好|等待.*用户|用户确认|需要.*确认|待.*确认|等.*确认后再继续|defer to the human|wait for user confirmation/i;

const HIGH_RISK_PATTERN =
  /删除|清空|覆盖|重置|回滚|不可逆|凭证|密钥|token|权限|授权|登录|安全|支付|费用|生产环境|强制推送|强推|破坏性|destructive|irreversible|credential|secret|permission|security|payment|production/i;

export function hasHighRiskSignal(text) {
  return HIGH_RISK_PATTERN.test(safeText(text, ""));
}

export function shouldAutoResolveHumanDeferral({ text = "", context = "" } = {}) {
  const value = safeText(text, "");
  if (!value || !HUMAN_DEFERRAL_PATTERN.test(value)) {
    return false;
  }
  return !hasHighRiskSignal(`${value}\n${safeText(context, "")}`);
}

export function buildDecisiveContinuationInstruction({ englishPreferred = false } = {}) {
  return englishPreferred
    ? "Choose the safest small verifiable path from the project docs and current rules, then continue. After finishing, report the change summary, verification result, and the next recommended step."
    : "请基于项目文档和现有规则，直接选择最安全、最小、可验证的方案继续推进；完成后给出改动摘要、验证结果和下一步建议。";
}

export function resolveReviewHumanDeferral({
  review = {},
  context = "",
  englishPreferred = false,
} = {}) {
  const reviewText = [
    review.summary,
    review.nextInstruction,
    ...(Array.isArray(review.risks) ? review.risks : []),
  ]
    .map((item) => safeText(item, ""))
    .filter(Boolean)
    .join("\n");

  if (
    review.shouldContinue === false &&
    shouldAutoResolveHumanDeferral({
      text: reviewText,
      context,
    })
  ) {
    return {
      ...review,
      shouldContinue: true,
      nextInstruction: buildDecisiveContinuationInstruction({ englishPreferred }),
      risks: Array.isArray(review.risks)
        ? review.risks.filter((risk) => !HUMAN_DEFERRAL_PATTERN.test(safeText(risk, "")))
        : [],
      autoResolvedHumanDeferral: true,
    };
  }

  return {
    ...review,
    autoResolvedHumanDeferral: false,
  };
}
