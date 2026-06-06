function asBudgetValue(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function createInitialState({ projectName, branch, budgets }) {
  return {
    version: 1,
    projectName,
    loopName: projectName,
    branch,
    mode: "running",
    stopRequested: false,
    finalizeRequested: false,
    budgets: {
      maxMinutes: asBudgetValue(budgets?.maxMinutes, 180),
      maxTokens: asBudgetValue(budgets?.maxTokens, 120000),
      finalizeLeadMinutes: asBudgetValue(budgets?.finalizeLeadMinutes, 20),
      finalizeLeadTokens: asBudgetValue(budgets?.finalizeLeadTokens, 15000),
    },
    elapsedMinutes: 0,
    consumedTokens: 0,
    activeTask: "",
    lastNote: "",
    recentSummary: "",
    lastHeartbeatAt: "",
    events: [],
  };
}

export function decideLoopMode({
  budgets,
  elapsedMinutes,
  consumedTokens,
  stopRequested,
  finalizeRequested,
  currentMode,
}) {
  if (currentMode === "stopped") {
    return { mode: "stopped", reason: "loop already stopped" };
  }

  if (stopRequested) {
    return {
      mode: "finalize_after_current",
      reason: "stop signal detected; finish current priority task and finalize",
    };
  }

  if (finalizeRequested) {
    return {
      mode: "finalize_after_current",
      reason: "finalize requested explicitly",
    };
  }

  const remainingMinutes = budgets.maxMinutes - elapsedMinutes;
  if (remainingMinutes <= budgets.finalizeLeadMinutes) {
    return {
      mode: "finalize_after_current",
      reason: "time budget nearing limit; begin graceful finalize",
    };
  }

  const remainingTokens = budgets.maxTokens - consumedTokens;
  if (remainingTokens <= budgets.finalizeLeadTokens) {
    return {
      mode: "finalize_after_current",
      reason: "token budget nearing limit; begin graceful finalize",
    };
  }

  return {
    mode: "running",
    reason: "budget healthy; continue loop",
  };
}

export function applyHeartbeat(
  state,
  { consumedTokens, activeTask, note, progressSummary, nowIso },
) {
  const nextConsumedTokens = Number.isFinite(consumedTokens)
    ? consumedTokens
    : state.consumedTokens;

  const nextState = {
    ...state,
    consumedTokens: nextConsumedTokens,
    activeTask: activeTask ?? state.activeTask,
    lastNote: note ?? state.lastNote,
    recentSummary: progressSummary ?? state.recentSummary,
    lastHeartbeatAt: nowIso,
  };

  const decision = decideLoopMode({
    budgets: nextState.budgets,
    elapsedMinutes: nextState.elapsedMinutes,
    consumedTokens: nextState.consumedTokens,
    stopRequested: nextState.stopRequested,
    finalizeRequested: nextState.finalizeRequested,
    currentMode: nextState.mode,
  });

  nextState.mode = decision.mode;
  nextState.events = [
    ...nextState.events,
    {
      type: "heartbeat",
      at: nowIso,
      activeTask: nextState.activeTask,
      note: nextState.lastNote,
      progressSummary: nextState.recentSummary,
      consumedTokens: nextState.consumedTokens,
      mode: nextState.mode,
      reason: decision.reason,
    },
  ];

  return nextState;
}
