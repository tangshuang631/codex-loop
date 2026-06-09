export function budgetLimitReached(state = {}) {
  const budgets = state.budgets || {};
  const maxMinutes = Number(budgets.maxMinutes);
  const maxTokens = Number(budgets.maxTokens);
  const finalizeLeadMinutes = Number(budgets.finalizeLeadMinutes || 0);
  const finalizeLeadTokens = Number(budgets.finalizeLeadTokens || 0);
  const elapsedMinutes = Number(state.elapsedMinutes || 0);
  const consumedTokens = Number(state.consumedTokens || 0);

  return (
    (Number.isFinite(maxMinutes) &&
      elapsedMinutes >= Math.max(0, maxMinutes - finalizeLeadMinutes)) ||
    (Number.isFinite(maxTokens) &&
      consumedTokens >= Math.max(0, maxTokens - finalizeLeadTokens))
  );
}

function isAfterOrSameIso(value, reference) {
  const valueTime = Date.parse(value || "");
  const referenceTime = Date.parse(reference || "");
  if (!Number.isFinite(valueTime) || !Number.isFinite(referenceTime)) {
    return Boolean(value && reference && value >= reference);
  }
  return valueTime >= referenceTime;
}

export function completionNeedsSupervisorReview(thread = {}) {
  const completionAt = thread.lastCompletionAt || "";
  if (!completionAt) {
    return false;
  }

  const reviewAt = thread.lastSupervisorReviewAt || "";
  if (reviewAt && isAfterOrSameIso(reviewAt, completionAt)) {
    return false;
  }

  return thread.latestEventType === "codex_followup_completed";
}

export function decideLoopControllerGate(snapshot = {}, controllerState = {}) {
  const state = snapshot.state || {};
  const thread = snapshot.thread || {};
  const continuationStatus = thread.continuationStatus || "idle";

  if (state.mode !== "running" || state.stopRequested || state.finalizeRequested) {
    return { type: "stopped", status: "stopped" };
  }

  if (continuationStatus === "dispatching") {
    return {
      type: "waiting_codex",
      status: "waiting_codex",
      awaitingCompletion: true,
    };
  }

  if (continuationStatus === "reviewing") {
    return { type: "supervisor_reviewing", status: "supervisor_reviewing" };
  }

  if (continuationStatus === "error") {
    return {
      type: "error_stopped",
      status: "error_stopped",
      detail: thread.lastContinuationError || "",
    };
  }

  if (state.monitorOnly) {
    return { type: "monitor_only_stopped", status: "stopped" };
  }

  if (budgetLimitReached(state)) {
    return { type: "budget_stopped", status: "budget_stopped" };
  }

  const completionAt = thread.lastCompletionAt || "";
  const completionAlreadyHandled =
    completionAt && completionAt === controllerState.lastCompletionAt;

  if (controllerState.awaitingCompletion) {
    if (!completionAt || completionAlreadyHandled) {
      return { type: "waiting_for_new_completion", status: "waiting_codex" };
    }
    return {
      type: "needs_supervisor_review",
      status: "supervisor_reviewing",
      completionAt,
    };
  }

  if (!completionAlreadyHandled && completionNeedsSupervisorReview(thread)) {
    return {
      type: "needs_supervisor_review",
      status: "supervisor_reviewing",
      completionAt,
    };
  }

  return { type: "ready_to_dispatch", status: "ready_to_dispatch" };
}
