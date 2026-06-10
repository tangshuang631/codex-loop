import fs from "node:fs/promises";
import path from "node:path";
import { exec as execCommand } from "node:child_process";

const SUPERVISOR_VERIFICATION_TIMEOUT_MS = 90 * 1000;
const SUPERVISOR_VERIFICATION_MAX_COMMANDS = 3;
const SUPERVISOR_VERIFICATION_COOLDOWN_MS = 30 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

function stripMarkdownCode(text) {
  return safeText(text, "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = safeText(value, "");
    if (text) {
      return text;
    }
  }
  return "";
}

function summarizeForFollowup(value, maxLength = 220) {
  const normalized = stripMarkdownCode(value);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function normalizeTextList(value, maxItems = 5, maxLength = 120) {
  const items = Array.isArray(value)
    ? value
    : safeText(value, "").split(/\r?\n|[,，]/u);
  return items
    .map((item) => summarizeForFollowup(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

async function readJson(filePath, fallbackValue = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

function hasDangerousShellSyntax(command) {
  return /[\r\n]/u.test(command) || /(?:&&|\|\||[;|<>`])/u.test(command);
}

function isDangerousVerificationCommand(command) {
  return /(?:^|\s)(?:rm\s+-|del\s+|erase\s+|rmdir\s+|rd\s+|remove-item\b|git\s+reset\b|git\s+clean\b|shutdown\b|format\b|mkfs\b|diskpart\b|reg\s+delete\b|taskkill\s+\/f\b|stop-process\b)/iu.test(command);
}

function isAllowedVerificationCommand(command) {
  const firstToken = safeText(command.split(/\s+/u)[0], "").toLowerCase();
  return /^(npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?|bun(?:\.cmd)?|node(?:\.exe)?|npx(?:\.cmd)?|vitest(?:\.cmd)?|playwright(?:\.cmd)?|pytest(?:\.exe)?|python(?:\.exe)?|py(?:\.exe)?)$/iu.test(firstToken);
}

function packageScriptNameForCommand(command) {
  let match = command.match(/^(?:npm|pnpm|bun)(?:\.cmd)?\s+(?:run(?:-script)?\s+)?([^\s]+)/iu);
  if (match) {
    return match[1] === "test" ? "test" : match[1];
  }

  match = command.match(/^yarn(?:\.cmd)?\s+([^\s]+)/iu);
  if (match) {
    return match[1] === "run"
      ? safeText(command.split(/\s+/u)[2], "")
      : match[1];
  }

  return "";
}

async function packageScriptExists(workspaceRoot, scriptName) {
  if (!scriptName) {
    return true;
  }

  try {
    const packageJson = await readJson(path.join(workspaceRoot, "package.json"), null);
    return Boolean(packageJson?.scripts?.[scriptName]);
  } catch {
    return false;
  }
}

function normalizeVerificationResult(command, result = {}) {
  const skipped = Boolean(result.skipped);
  const ok = !skipped && result.ok === true;
  const status = skipped ? "skipped" : ok ? "passed" : "failed";
  const output = firstNonEmpty(
    result.output,
    result.stdout,
    result.stderr,
    result.reason,
    status === "passed" ? "命令执行通过。" : "命令执行失败。",
  );

  return {
    command,
    status,
    ok,
    skipped,
    exitCode: Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : "",
    summary: summarizeForFollowup(output, 220),
    reason: safeText(result.reason, ""),
  };
}

function sameTextList(left = [], right = []) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

function recentPassedVerificationStillFresh(snapshot, commands) {
  if (snapshot.thread.lastSupervisorVerificationStatus !== "passed") {
    return false;
  }

  const lastAt = Date.parse(snapshot.thread.lastSupervisorVerificationAt || "");
  if (!Number.isFinite(lastAt)) {
    return false;
  }

  const previousCommands = normalizeTextList(
    snapshot.thread.lastSupervisorVerificationCommands || [],
    SUPERVISOR_VERIFICATION_MAX_COMMANDS,
    160,
  );
  if (!sameTextList(previousCommands, commands)) {
    return false;
  }

  return Date.now() - lastAt < SUPERVISOR_VERIFICATION_COOLDOWN_MS;
}

function sameCompletionAlreadyVerified(snapshot, commands) {
  const completionAt = Date.parse(snapshot.thread.lastCompletionAt || "");
  const verifiedAt = Date.parse(snapshot.thread.lastSupervisorVerificationAt || "");
  if (!Number.isFinite(completionAt) || !Number.isFinite(verifiedAt)) {
    return false;
  }
  if (verifiedAt < completionAt) {
    return false;
  }

  const previousCommands = normalizeTextList(
    snapshot.thread.lastSupervisorVerificationCommands || [],
    SUPERVISOR_VERIFICATION_MAX_COMMANDS,
    160,
  );
  return sameTextList(previousCommands, commands);
}

export async function defaultRunSupervisorVerificationCommand({
  command,
  workspaceRoot,
  timeoutMs = SUPERVISOR_VERIFICATION_TIMEOUT_MS,
} = {}) {
  const cleanCommand = safeText(command, "");
  if (!cleanCommand) {
    return {
      command: cleanCommand,
      ok: false,
      skipped: true,
      reason: "验收命令为空。",
    };
  }

  if (
    hasDangerousShellSyntax(cleanCommand) ||
    isDangerousVerificationCommand(cleanCommand) ||
    !isAllowedVerificationCommand(cleanCommand)
  ) {
    return {
      command: cleanCommand,
      ok: false,
      skipped: true,
      reason: "为避免误执行高风险命令，本次独立验收已跳过该命令。",
    };
  }

  const scriptName = packageScriptNameForCommand(cleanCommand);
  if (scriptName && !(await packageScriptExists(workspaceRoot, scriptName))) {
    return {
      command: cleanCommand,
      ok: false,
      skipped: true,
      reason: "当前工作区没有找到对应的 package.json 脚本：" + scriptName,
    };
  }

  return new Promise((resolve) => {
    execCommand(
      cleanCommand,
      {
        cwd: workspaceRoot,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 512 * 1024,
      },
      (error, stdout, stderr) => {
        const output = [stdout, stderr]
          .map((part) => safeText(part, ""))
          .filter(Boolean)
          .join("\n");
        resolve({
          command: cleanCommand,
          ok: !error,
          exitCode: error ? error.code ?? "" : 0,
          output: output || (error ? safeText(error.message, "命令执行失败。") : "命令执行通过。"),
        });
      },
    );
  });
}

export async function runSupervisorIndependentVerification(
  snapshot,
  review,
  { runVerificationCommand = defaultRunSupervisorVerificationCommand } = {},
) {
  const commands = normalizeTextList(
    review.needsIndependentVerification ? review.verificationCommands : [],
    SUPERVISOR_VERIFICATION_MAX_COMMANDS,
    160,
  );

  if (!review.shouldContinue || !review.needsIndependentVerification) {
    return {
      status: "not_requested",
      summary: "",
      results: [],
      ranAt: "",
    };
  }

  if (!commands.length) {
    return {
      status: "skipped",
      summary: "监督复盘建议独立验收，但没有可执行命令。",
      results: [],
      ranAt: nowIso(),
    };
  }

  if (recentPassedVerificationStillFresh(snapshot, commands)) {
    return {
      status: "skipped",
      summary: "近期已完成同一组独立验收，仍在冷却期内，本轮不重复执行。",
      results: [],
      ranAt: nowIso(),
    };
  }

  if (sameCompletionAlreadyVerified(snapshot, commands)) {
    return {
      status: "skipped",
      summary:
        "当前 Codex 完成结果已经做过独立验收，本轮不重复执行；等待新的 Codex 完成后再验收。",
      results: [],
      ranAt: snapshot.thread.lastSupervisorVerificationAt || nowIso(),
    };
  }

  const results = [];
  for (const command of commands) {
    try {
      results.push(
        normalizeVerificationResult(
          command,
          await runVerificationCommand({
            command,
            workspaceRoot: snapshot.paths.workspaceRoot,
            timeoutMs: SUPERVISOR_VERIFICATION_TIMEOUT_MS,
          }),
        ),
      );
    } catch (error) {
      results.push(
        normalizeVerificationResult(command, {
          ok: false,
          exitCode: "",
          output: safeText(error?.message, "独立验收命令执行异常。"),
        }),
      );
    }
  }

  const failed = results.filter((result) => result.status === "failed");
  const passed = results.filter((result) => result.status === "passed");
  const skipped = results.filter((result) => result.status === "skipped");
  const status = failed.length ? "failed" : passed.length ? "passed" : "skipped";
  const summary =
    status === "failed"
      ? "独立验收失败：" +
        failed
          .map((result) => result.command + "：" + result.summary)
          .join("；")
      : status === "passed"
        ? "独立验收通过：" + passed.map((result) => result.command).join("、")
        : "独立验收已跳过：" +
          skipped
            .map((result) => result.command + "：" + (result.reason || result.summary))
            .join("；");

  return {
    status,
    summary: summarizeForFollowup(summary, 420),
    results,
    ranAt: nowIso(),
  };
}

export function injectVerificationIntoInstruction(instruction, verification = {}) {
  if (verification.status === "failed") {
    return summarizeForFollowup(
      [
        "优先修复独立验收失败后再继续。",
        verification.summary,
        "原下一步：" + instruction,
      ].join(" "),
      700,
    );
  }

  if (verification.status === "skipped") {
    return summarizeForFollowup(
      [
        "原下一步：" + instruction,
        "提醒：独立验收未执行，原因：" + (verification.summary || "没有可执行命令。"),
        "请先补齐或说明可验证证据，再继续下一步。",
      ].join(" "),
      700,
    );
  }

  return instruction;
}
