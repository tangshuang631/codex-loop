import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  detectProjectProfile,
  scaffoldProjectAdapter,
} from "../scripts/lib/scaffold-project.mjs";

test("detectProjectProfile recognizes node workspace heuristics", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-detect-"));
  await fs.writeFile(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "demo-app",
        scripts: {
          test: "vitest",
          build: "vite build",
          lint: "eslint .",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const profile = await detectProjectProfile(tempRoot);
  assert.equal(profile.projectType, "node");
  assert.match(profile.commands.join("\n"), /npm run test/);
  assert.match(profile.commands.join("\n"), /npm run build/);
});

test("detectProjectProfile recognizes hybrid node and rust workspace heuristics", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-hybrid-"));
  await fs.writeFile(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "hybrid-app",
        scripts: {
          "test:unit": "vitest",
          build: "vite build",
          "verify:all": "node verify.mjs",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "Cargo.toml"),
    `[package]\nname = "hybrid-app"\nversion = "0.1.0"\n`,
    "utf8",
  );

  const profile = await detectProjectProfile(tempRoot);
  assert.equal(profile.projectType, "hybrid");
  assert.match(profile.commands.join("\n"), /npm run test:unit/);
  assert.match(profile.commands.join("\n"), /cargo test/);
  assert.equal(profile.strictness, "very_high");
});

test("detectProjectProfile recognizes python workspace heuristics", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-python-"));
  await fs.writeFile(
    path.join(tempRoot, "pyproject.toml"),
    `[project]\nname = "py-demo"\nversion = "0.1.0"\n`,
    "utf8",
  );

  const profile = await detectProjectProfile(tempRoot);
  assert.equal(profile.projectType, "python");
  assert.match(profile.commands.join("\n"), /python -m pytest/);
});

test("scaffoldProjectAdapter creates reusable adapter and runbook files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-scaffold-"));
  const codexLoopRoot = path.join(tempRoot, "codex_loop");
  await fs.mkdir(path.join(codexLoopRoot, "projects"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "smart-demo",
        scripts: {
          test: "node --test",
          build: "tsc -p .",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const result = await scaffoldProjectAdapter({
    workspaceRoot: tempRoot,
    codexLoopRoot,
    adapterId: "smart-demo",
    displayName: "Smart Demo",
  });

  const adapterText = await fs.readFile(result.adapterPath, "utf8");
  const runbookText = await fs.readFile(result.runbookPath, "utf8");
  const threadText = await fs.readFile(result.threadPath, "utf8");

  assert.match(adapterText, /"adapterId": "smart-demo"/);
  assert.match(adapterText, /npm run test/);
  assert.match(runbookText, /Project Runbook/);
  assert.match(threadText, /Primary Thread Contract/);
});

test("scaffoldProjectAdapter raises verification strictness for hybrid projects", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-strict-"));
  const codexLoopRoot = path.join(tempRoot, "codex_loop");
  await fs.mkdir(path.join(codexLoopRoot, "projects"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "strict-demo",
        scripts: {
          "test:unit": "vitest",
          build: "vite build",
          "verify:all": "node verify.mjs",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(tempRoot, "Cargo.toml"),
    `[package]\nname = "strict-demo"\nversion = "0.1.0"\n`,
    "utf8",
  );

  const result = await scaffoldProjectAdapter({
    workspaceRoot: tempRoot,
    codexLoopRoot,
    adapterId: "strict-demo",
    displayName: "Strict Demo",
  });

  const adapterText = await fs.readFile(result.adapterPath, "utf8");
  assert.match(adapterText, /"strictness": "very_high"/);
  assert.match(adapterText, /cargo test/);
  assert.match(adapterText, /npm run verify:all/);
});
