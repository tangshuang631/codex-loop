import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { writeJson } from "../scripts/lib/fs-helpers.mjs";

test("writeJson falls back when Windows temporarily blocks atomic replace", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-fs-"));
  const targetPath = path.join(tempRoot, "state.json");
  const originalRename = fs.rename;
  let attempts = 0;

  fs.rename = async () => {
    attempts += 1;
    const error = new Error("operation not permitted");
    error.code = "EPERM";
    throw error;
  };

  try {
    await writeJson(targetPath, { ok: true, message: "状态写入成功" });
  } finally {
    fs.rename = originalRename;
  }

  const saved = JSON.parse(await fs.readFile(targetPath, "utf8"));
  const leftovers = await fs.readdir(tempRoot);

  assert.equal(attempts, 4);
  assert.deepEqual(saved, { ok: true, message: "状态写入成功" });
  assert.deepEqual(leftovers, ["state.json"]);
});
