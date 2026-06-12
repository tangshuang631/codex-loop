import test from "node:test";
import assert from "node:assert/strict";

import {
  buildModelPipelineSummary,
  buildProductionFocusSummary,
  buildStatusHeroSummary,
  buildLongRunDecision,
  getConversationActionLabel,
  getConversationDetailKindLabel,
  getConversationEntryLabel,
  getConversationRoleLabel,
  presentStatusRowLabel,
} from "../app/shared/presentation.mjs";

test("presentStatusRowLabel keeps product wording in Chinese", () => {
  assert.equal(presentStatusRowLabel("longrun"), "长跑判断");
  assert.equal(presentStatusRowLabel("下一步"), "下一步");
});

test("buildLongRunDecision reports when long-running use is ready", () => {
  assert.equal(
    buildLongRunDecision({
      hasProductionStatus: true,
      closedLoopCount: 2,
      closedLoopTarget: 2,
      guidanceEvidenceCount: 1,
      guidanceEvidenceTarget: 1,
    }),
    "可以继续长时间运行，建议保持观察日志。",
  );
});

test("buildLongRunDecision reports concrete remaining gaps before long-running use", () => {
  assert.match(
    buildLongRunDecision({
      hasProductionStatus: true,
      closedLoopCount: 1,
      closedLoopTarget: 2,
      guidanceEvidenceCount: 0,
      guidanceEvidenceTarget: 1,
    }),
    /还差 1 轮真实闭环和 1 次补充合并证据/,
  );
});

test("getConversationActionLabel keeps conversation actions product-facing", () => {
  assert.equal(
    getConversationActionLabel({ hasText: false, isGuidance: false, isLoop: false }),
    "等待同步",
  );
  assert.equal(
    getConversationActionLabel({ hasText: true, isGuidance: true, isLoop: true }),
    "待下一轮合并",
  );
  assert.equal(
    getConversationActionLabel({ hasText: true, isGuidance: false, isLoop: true }),
    "查看完整指令",
  );
  assert.equal(
    getConversationActionLabel({ hasText: true, isGuidance: false, isLoop: false }),
    "查看完整回复",
  );
});

test("conversation role labels stay unified across desktop and mobile", () => {
  assert.equal(getConversationRoleLabel("guidance"), "你的补充");
  assert.equal(getConversationRoleLabel("user"), "codex-loop");
  assert.equal(getConversationRoleLabel("loop"), "codex-loop");
  assert.equal(getConversationRoleLabel("assistant"), "Codex");
});

test("conversation entry labels stay unified across desktop and mobile", () => {
  assert.equal(getConversationEntryLabel({ isGuidance: true, isLoop: true }), "你的补充");
  assert.equal(getConversationEntryLabel({ isGuidance: false, isLoop: true }), "codex-loop 指令");
  assert.equal(getConversationEntryLabel({ isGuidance: false, isLoop: false }), "Codex 回复");
});

test("conversation detail kind labels stay unified across desktop and mobile", () => {
  assert.equal(getConversationDetailKindLabel("command_output"), "命令");
  assert.equal(getConversationDetailKindLabel("file_change"), "文件");
  assert.equal(getConversationDetailKindLabel("script_snippet"), "脚本");
  assert.equal(getConversationDetailKindLabel("screenshot"), "截图");
  assert.equal(getConversationDetailKindLabel("test_log"), "验证");
  assert.equal(getConversationDetailKindLabel("runtime_detail"), "详情");
  assert.equal(getConversationDetailKindLabel("unknown"), "记录");
});

test("buildStatusHeroSummary keeps hero summary wording consistent across desktop and mobile", () => {
  assert.deepEqual(
    buildStatusHeroSummary({
      headline: "Codex 正在处理",
      detail: "这一轮还没有完成，系统不会追加发送。",
      nextAction: "等待 Codex 完成后再决定是否继续。",
    }),
    {
      headline: "Codex 正在处理",
      detail: "这一轮还没有完成，系统不会追加发送。",
      nextAction: "等待 Codex 完成后再决定是否继续。",
    },
  );

  assert.deepEqual(
    buildStatusHeroSummary({}),
    {
      headline: "当前正在同步状态",
      detail: "这一轮的最新状态会继续显示在这里。",
      nextAction: "先看最新记录，再决定是否继续发送下一轮。",
    },
  );
});

test("buildProductionFocusSummary explains waiting state with human-check guidance", () => {
  assert.deepEqual(
    buildProductionFocusSummary({
      productionStatus: {
        status: "waiting",
        nextAction: "先确认 Codex 是否停在待你确认的位置。",
      },
      productionObservation: {
        diagnosis: {
          category: "completion_missing_supervisor_review",
          userMessage: "Codex 已完成当前轮，但本地复盘还没收齐",
          nextAction: "先确认 Codex 是否停在待你确认的位置。",
        },
        waiting: {
          waitingMinutes: 14,
          needsHumanCheck: true,
        },
      },
      closedLoopCount: 1,
      closedLoopTarget: 2,
      guidanceEvidenceCount: 0,
      guidanceEvidenceTarget: 1,
    }),
    {
      summary: "已等待约 14 分钟，建议人工确认后再继续",
      attention: "Codex 已完成当前轮，但本地复盘还没收齐",
      nextAction: "先确认 Codex 是否停在待你确认的位置。",
    },
  );
});

test("buildProductionFocusSummary explains dispatching as an in-flight delivery wait instead of a failure", () => {
  assert.deepEqual(
    buildProductionFocusSummary({
      productionStatus: {
        status: "waiting",
        nextAction: "先等桌面端确认送达，再继续观察 Codex 是否开始处理。",
      },
      productionObservation: {
        diagnosis: {
          category: "dispatch_in_progress",
          userMessage: "正在通过 Codex 桌面端原生链路发送指令，等待确认送达。",
          nextAction: "先等桌面端确认送达，再继续观察 Codex 是否开始处理。",
        },
      },
      closedLoopCount: 1,
      closedLoopTarget: 2,
      guidanceEvidenceCount: 1,
      guidanceEvidenceTarget: 1,
    }),
    {
      summary: "这一轮刚发出，正在等待桌面端确认送达",
      attention: "正在通过 Codex 桌面端原生链路发送指令，等待确认送达。",
      nextAction: "先等桌面端确认送达，再继续观察 Codex 是否开始处理。",
    },
  );
});

test("buildProductionFocusSummary separates delivery-check failures from normal waiting", () => {
  assert.deepEqual(
    buildProductionFocusSummary({
      productionStatus: {
        status: "attention",
        nextAction: "优先检查线程绑定、桌面端原生发送入口和本机 Codex 连接状态。",
      },
      productionObservation: {
        diagnosis: {
          category: "dispatch_failed_before_delivery",
          userMessage: "指令进入发送阶段，但没有观察到已送达 Codex 的记录。",
          nextAction: "优先检查线程绑定、桌面端原生发送入口和本机 Codex 连接状态。",
        },
      },
      closedLoopCount: 1,
      closedLoopTarget: 2,
      guidanceEvidenceCount: 1,
      guidanceEvidenceTarget: 1,
    }),
    {
      summary: "这一轮停在发送确认阶段，先检查是否真正送达",
      attention: "指令进入发送阶段，但没有观察到已送达 Codex 的记录。",
      nextAction: "优先检查线程绑定、桌面端原生发送入口和本机 Codex 连接状态。",
    },
  );
});

test("buildProductionFocusSummary reports concrete production gaps before long-running use", () => {
  assert.deepEqual(
    buildProductionFocusSummary({
      productionStatus: {
        status: "blocked",
        nextAction: "先补齐真实闭环验证，再投入长期运行。",
        maturity: {
          canLongRun: false,
        },
      },
      productionPreflight: {
        nextAction: "先补齐真实闭环验证，再投入长期运行。",
      },
      closedLoopCount: 1,
      closedLoopTarget: 3,
      guidanceEvidenceCount: 0,
      guidanceEvidenceTarget: 1,
    }),
    {
      summary: "还差 2 轮真实闭环，还差 1 次补充合并证据",
      attention: "当前还有生产化缺口需要补齐。",
      nextAction: "先补齐真实闭环验证，再投入长期运行。",
    },
  );
});

test("buildModelPipelineSummary reports whether ollama or fallback is currently shaping the loop", () => {
  assert.deepEqual(
    buildModelPipelineSummary({
      latestInstructionSourceLabel: "本地模型生成",
      latestInstructionSourceDetail: "最近一条发给 Codex 的指令已经过本地模型监督流程整理。",
      latestCodexSummarySourceLabel: "原文降级",
      latestCodexSummarySourceDetail: "Ollama 摘要整理失败，已保留 Codex 原文。",
    }),
    {
      headline: "指令：本地模型生成；回复：原文降级",
      detail: "最近一条发给 Codex 的指令已经过本地模型监督流程整理。 Ollama 摘要整理失败，已保留 Codex 原文。",
    },
  );
});
