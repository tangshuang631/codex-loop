import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientWriteError(error) {
  return ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
}

export async function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  await fs.writeFile(tempPath, text, "utf8");

  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientWriteError(error)) {
        throw error;
      }
      await sleep(25 * (attempt + 1));
    }
  }

  // Windows can briefly lock recently-read JSON files. Fall back to direct write
  // so launcher/runtime state remains usable instead of crashing the service.
  await fs.writeFile(filePath, text, "utf8");
  await fs.rm(tempPath, { force: true }).catch(() => {});
  if (lastError && !isTransientWriteError(lastError)) {
    throw lastError;
  }
}

export async function appendJsonLine(filePath, value) {
  const line = `${JSON.stringify(value)}\n`;
  await fs.appendFile(filePath, line, "utf8");
}

export function joinWithin(rootPath, ...parts) {
  return path.join(rootPath, ...parts);
}
