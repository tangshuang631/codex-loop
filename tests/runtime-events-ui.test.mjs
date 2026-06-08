import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("dashboard renders readable runtime events from snapshot", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /snapshot\?\.runtimeEvents/);
  assert.match(appSource, /运行记录/);
  assert.match(appSource, /runtime-event-list/);
  assert.match(appSource, /runtime-event-title/);
});

test("dashboard uses mobile process status as the primary runtime status source", async () => {
  const appSource = await fs.readFile("app/web/src/App.jsx", "utf8");

  assert.match(appSource, /mobileView\?\.processStatus/);
  assert.match(appSource, /processStatus\?\.headline/);
  assert.match(appSource, /processStatus\?\.detail/);
  assert.match(appSource, /processStatus\?\.stopLimit/);
  assert.match(appSource, /待合并补充/);
});
