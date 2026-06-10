import test from "node:test";
import assert from "node:assert/strict";

import {
  budgetLimitReached,
  completionNeedsSupervisorReview,
  decideLoopControllerGate,
} from "../app/server/lib/loop-core/controller-gates.mjs";

test("loop core budget gate stops before the next dispatch when limits or lead time are reached", () => {
  assert.equal(
    budgetLimitReached({
      elapsedMinutes: 110,
      consumedTokens: 1000,
      budgets: {
        maxMinutes: 120,
        maxTokens: 50000,
        finalizeLeadMinutes: 10,
        finalizeLeadTokens: 0,
      },
    }),
    true,
  );

  assert.equal(
    budgetLimitReached({
      elapsedMinutes: 30,
      consumedTokens: 42000,
      budgets: {
        maxMinutes: 120,
        maxTokens: 50000,
        finalizeLeadMinutes: 0,
        finalizeLeadTokens: 8000,
      },
    }),
    true,
  );

  assert.equal(
    budgetLimitReached({
      elapsedMinutes: 30,
      consumedTokens: 1000,
      budgets: {},
    }),
    false,
  );
});

test("loop core detects completed Codex turns that still need supervisor review", () => {
  assert.equal(
    completionNeedsSupervisorReview({
      latestEventType: "codex_followup_completed",
      lastCompletionAt: "2026-06-08T02:15:00.000Z",
      lastSupervisorReviewAt: "",
    }),
    true,
  );

  assert.equal(
    completionNeedsSupervisorReview({
      latestEventType: "codex_followup_completed",
      lastCompletionAt: "2026-06-08T02:15:00.000Z",
      lastSupervisorReviewAt: "2026-06-08T02:15:10.000Z",
    }),
    false,
  );

  assert.equal(
    completionNeedsSupervisorReview({
      latestEventType: "codex_thread_mirror_synced",
      lastCompletionAt: "2026-06-08T02:15:00.000Z",
      lastSupervisorReviewAt: "",
    }),
    false,
  );
});

test("loop core classifies the next automatic-loop gate in user-facing order", () => {
  assert.deepEqual(
    decideLoopControllerGate({
      state: { mode: "stopped", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "idle" },
    }),
    { type: "stopped", status: "stopped" },
  );

  assert.deepEqual(
    decideLoopControllerGate({
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "dispatching" },
    }),
    { type: "waiting_codex", status: "waiting_codex", awaitingCompletion: true },
  );

  assert.deepEqual(
    decideLoopControllerGate({
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: {
        continuationStatus: "idle",
        latestEventType: "codex_followup_completed",
        lastCompletionAt: "2026-06-08T02:15:00.000Z",
        lastSupervisorReviewAt: "",
      },
    }),
    {
      type: "needs_supervisor_review",
      status: "supervisor_reviewing",
      completionAt: "2026-06-08T02:15:00.000Z",
    },
  );

  assert.deepEqual(
    decideLoopControllerGate({
      state: {
        mode: "running",
        stopRequested: false,
        finalizeRequested: false,
        elapsedMinutes: 120,
        budgets: { maxMinutes: 120, finalizeLeadMinutes: 0 },
      },
      thread: { continuationStatus: "idle" },
    }),
    { type: "budget_stopped", status: "budget_stopped" },
  );

  assert.deepEqual(
    decideLoopControllerGate({
      state: { mode: "running", stopRequested: false, finalizeRequested: false },
      thread: { continuationStatus: "idle" },
    }),
    { type: "ready_to_dispatch", status: "ready_to_dispatch" },
  );
});

test("loop core keeps waiting when the same completion has already been consumed by this controller run", () => {
  assert.deepEqual(
    decideLoopControllerGate(
      {
        state: { mode: "running", stopRequested: false, finalizeRequested: false },
        thread: {
          continuationStatus: "idle",
          latestEventType: "codex_followup_completed",
          lastCompletionAt: "2026-06-08T02:15:00.000Z",
          lastSupervisorReviewAt: "",
        },
      },
      {
        awaitingCompletion: true,
        lastCompletionAt: "2026-06-08T02:15:00.000Z",
      },
    ),
    { type: "waiting_for_new_completion", status: "waiting_codex" },
  );
});

test("loop core stops automatic control after monitor-mode one-shot guidance finishes", () => {
  assert.deepEqual(
    decideLoopControllerGate({
      state: {
        mode: "running",
        monitorOnly: true,
        stopRequested: false,
        finalizeRequested: false,
      },
      thread: {
        continuationStatus: "dispatching",
        latestEventType: "codex_followup_sent_waiting",
      },
    }),
    { type: "waiting_codex", status: "waiting_codex", awaitingCompletion: true },
  );

  assert.deepEqual(
    decideLoopControllerGate({
      state: {
        mode: "running",
        monitorOnly: true,
        stopRequested: false,
        finalizeRequested: false,
      },
      thread: {
        continuationStatus: "idle",
        latestEventType: "codex_followup_completed",
        lastCompletionAt: "2026-06-09T12:00:00.000Z",
        lastSupervisorReviewAt: "",
      },
    }),
    {
      type: "needs_supervisor_review",
      status: "supervisor_reviewing",
      completionAt: "2026-06-09T12:00:00.000Z",
    },
  );

  assert.deepEqual(
    decideLoopControllerGate({
      state: {
        mode: "running",
        monitorOnly: true,
        stopRequested: false,
        finalizeRequested: false,
      },
      thread: {
        continuationStatus: "idle",
        latestEventType: "supervisor_review_completed",
        lastCompletionAt: "2026-06-09T12:00:00.000Z",
        lastSupervisorReviewAt: "2026-06-09T12:01:00.000Z",
      },
    }),
    { type: "monitor_only_stopped", status: "stopped" },
  );
});

test("loop core keeps budget stop ahead of supervisor review", () => {
  assert.deepEqual(
    decideLoopControllerGate({
      state: {
        mode: "running",
        stopRequested: false,
        finalizeRequested: false,
        elapsedMinutes: 120,
        budgets: { maxMinutes: 120, finalizeLeadMinutes: 0 },
      },
      thread: {
        continuationStatus: "idle",
        latestEventType: "codex_followup_completed",
        lastCompletionAt: "2026-06-09T12:00:00.000Z",
        lastSupervisorReviewAt: "",
      },
    }),
    { type: "budget_stopped", status: "budget_stopped" },
  );
});
