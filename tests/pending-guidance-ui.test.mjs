import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("dashboard puts next-turn guidance composer at the bottom of the conversation", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.doesNotMatch(appSource, /function PendingGuidanceFold/);
  assert.doesNotMatch(appSource, /pending-guidance-fold/);
  assert.doesNotMatch(appSource, /补充下一轮引导/);
  assert.match(appSource, /function PendingGuidanceComposer/);
  assert.match(appSource, /className="conversation-composer"/);
  assert.match(appSource, /补充你要说的话 ,等 Codex 完成后合并，会等 Codex 当前任务完成再发送/);
  assert.match(appSource, /\/pending-guidance/);
  assert.match(stylesSource, /\.conversation-composer/);
});

test("dashboard auto-scrolls the conversation to the latest entry", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /conversationBottomRef/);
  assert.match(appSource, /scrollIntoView\(\{\s*block:\s*"end"/);
});

test("dashboard lets users edit or delete unsent pending guidance from the chat bubble", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /编辑补充/);
  assert.match(appSource, /删除补充/);
  assert.match(appSource, /PencilIcon/);
  assert.match(appSource, /TrashIcon/);
  assert.match(appSource, /onEditPendingGuidance/);
  assert.match(appSource, /clearPendingGuidance/);
  assert.match(appSource, /method:\s*"DELETE"/);
  assert.match(appSource, /\/pending-guidance/);
  assert.match(stylesSource, /\.pending-guidance-tools/);
  assert.match(stylesSource, /\.icon-button/);
});

test("dashboard exposes customizable npc supervisor settings", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /NPC 角色/);
  assert.match(appSource, /角色特性/);
  assert.match(appSource, /测试规则/);
  assert.match(appSource, /验收标准/);
  assert.match(appSource, /supervisor:\s*\{/);
  assert.match(appSource, /settingsForm\.supervisorRoleTraits/);
  assert.match(appSource, /settingsForm\.supervisorTestingRules/);
  assert.match(appSource, /settingsForm\.supervisorAcceptanceCriteria/);
});

test("dashboard exposes current loop npc supervisor settings separately", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /当前任务 NPC/);
  assert.match(appSource, /\/loop-supervisor/);
  assert.match(appSource, /loopSupervisorForm/);
  assert.match(appSource, /当前 loop 专用/);
  assert.match(appSource, /setLoopSupervisorForm/);
});

test("dashboard shows saved user guidance inside the conversation flow", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");
  const stylesSource = await fs.readFile("app/web/src/styles.css", "utf8");

  assert.match(appSource, /pendingGuidance/);
  assert.match(appSource, /pendingGuidanceAt/);
  assert.match(appSource, /你的补充/);
  assert.match(appSource, /待下一轮合并/);
  assert.match(appSource, /conversation-row is-guidance/);
  assert.match(appSource, /pending-guidance-queued/);
  assert.match(stylesSource, /\.conversation-row\.is-guidance/);
});
