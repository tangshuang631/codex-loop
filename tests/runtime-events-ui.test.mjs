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
