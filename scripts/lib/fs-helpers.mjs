import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, text, "utf8");
}

export async function appendJsonLine(filePath, value) {
  const line = `${JSON.stringify(value)}\n`;
  await fs.appendFile(filePath, line, "utf8");
}

export function joinWithin(rootPath, ...parts) {
  return path.join(rootPath, ...parts);
}
