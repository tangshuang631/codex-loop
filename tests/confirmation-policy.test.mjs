import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDecisiveContinuationInstruction,
  hasHighRiskSignal,
  shouldAutoResolveHumanDeferral,
} from "../app/server/lib/npc/confirmation-policy.mjs";

test("confirmation policy lets the NPC resolve ordinary product preference deferrals", () => {
  assert.equal(
    shouldAutoResolveHumanDeferral({
      text: "如果没有偏好，请等待用户确认后再继续。",
      context: "Codex 正在询问浅灰分割线还是卡片式展示。",
    }),
    true,
  );

  assert.match(
    buildDecisiveContinuationInstruction({ englishPreferred: false }),
    /文档|规则|最安全|可验证|继续/,
  );
});

test("confirmation policy keeps high-risk confirmation boundaries", () => {
  const context = "Codex 准备删除旧运行目录并清理凭证缓存。";

  assert.equal(hasHighRiskSignal(context), true);
  assert.equal(
    shouldAutoResolveHumanDeferral({
      text: "请等待用户确认后再继续。",
      context,
    }),
    false,
  );
});
