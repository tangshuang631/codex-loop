import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitialState,
  decideLoopMode,
  applyHeartbeat,
} from "../scripts/lib/state.mjs";

test("createInitialState starts in running mode", () => {
  const state = createInitialState({
    projectName: "demo",
    branch: "dev",
    budgets: {
      maxMinutes: 180,
      maxTokens: 120000,
      finalizeLeadMinutes: 20,
      finalizeLeadTokens: 15000,
    },
  });

  assert.equal(state.mode, "running");
  assert.equal(state.stopRequested, false);
  assert.equal(state.finalizeRequested, false);
});

test("decideLoopMode requests finalize when token lead threshold is reached", () => {
  const decision = decideLoopMode({
    budgets: {
      maxMinutes: 180,
      maxTokens: 100000,
      finalizeLeadMinutes: 20,
      finalizeLeadTokens: 10000,
    },
    elapsedMinutes: 40,
    consumedTokens: 91000,
    stopRequested: false,
    finalizeRequested: false,
    currentMode: "running",
  });

  assert.equal(decision.mode, "finalize_after_current");
  assert.match(decision.reason, /token budget/i);
});

test("decideLoopMode requests finalize when a stop signal is present", () => {
  const decision = decideLoopMode({
    budgets: {
      maxMinutes: 180,
      maxTokens: 100000,
      finalizeLeadMinutes: 20,
      finalizeLeadTokens: 10000,
    },
    elapsedMinutes: 15,
    consumedTokens: 5000,
    stopRequested: true,
    finalizeRequested: false,
    currentMode: "running",
  });

  assert.equal(decision.mode, "finalize_after_current");
  assert.match(decision.reason, /stop/i);
});

test("applyHeartbeat appends traceable events and preserves finalize mode", () => {
  const state = createInitialState({
    projectName: "demo",
    branch: "dev",
    budgets: {
      maxMinutes: 180,
      maxTokens: 100000,
      finalizeLeadMinutes: 20,
      finalizeLeadTokens: 10000,
    },
  });

  const nextState = applyHeartbeat(state, {
    consumedTokens: 92000,
    activeTask: "Finish the adapter milestone",
    note: "Tests still running",
    nowIso: "2026-06-06T14:00:00.000Z",
  });

  assert.equal(nextState.mode, "finalize_after_current");
  assert.equal(nextState.events.at(-1).type, "heartbeat");
  assert.equal(nextState.events.at(-1).activeTask, "Finish the adapter milestone");
});
