import test from "node:test";
import assert from "node:assert/strict";

import {
  getConversationDetailLabel,
  getConversationDetailMeta,
  parseMarkdownTextBlock,
  splitMarkdownBlocks,
} from "../app/shared/conversation-format.mjs";

test("splitMarkdownBlocks keeps prose and fenced code in one shared structure", () => {
  const blocks = splitMarkdownBlocks("第一段\n\n```js\nconsole.log('hi')\n```\n\n第二段");
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["text", "code", "text"],
  );
  assert.equal(blocks[1].lang, "js");
  assert.equal(blocks[1].content, "console.log('hi')");
});

test("parseMarkdownTextBlock parses headings, mixed paragraphs, and lists", () => {
  const segments = parseMarkdownTextBlock(
    "# 标题\n\n第一段\n- 条目一\n- 条目二\n第二段\n1. 步骤一\n2. 步骤二",
  );

  assert.deepEqual(
    segments.map((segment) => segment.type),
    ["heading", "paragraph", "list", "paragraph", "list"],
  );
  assert.equal(segments[0].text, "标题");
  assert.equal(segments[2].ordered, false);
  assert.deepEqual(segments[2].items, ["条目一", "条目二"]);
  assert.equal(segments[4].ordered, true);
  assert.deepEqual(segments[4].items, ["步骤一", "步骤二"]);
});

test("conversation detail label and meta stay product-facing", () => {
  assert.equal(
    getConversationDetailLabel({ displayLabel: "已改文件 2 个", summary: "忽略这里" }),
    "已改文件 2 个",
  );
  assert.equal(
    getConversationDetailLabel({ kind: "script_snippet" }),
    "脚本内容 · 1 段脚本",
  );
  assert.equal(
    getConversationDetailLabel({}),
    "查看详情",
  );
  assert.equal(
    getConversationDetailMeta({ countLabel: "2 项", summary: "最近一次验证" }),
    "2 项 · 最近一次验证",
  );
});
