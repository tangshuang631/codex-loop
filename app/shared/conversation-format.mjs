function normalizeText(value) {
  return String(value ?? "");
}

function isBulletLine(line) {
  return /^[-*]\s+/.test(line);
}

function isOrderedLine(line) {
  return /^\d+\.\s+/.test(line);
}

export function splitMarkdownBlocks(text) {
  const value = normalizeText(text);
  if (!value) {
    return [];
  }

  const blocks = [];
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match;

  while ((match = fencePattern.exec(value))) {
    if (match.index > cursor) {
      blocks.push({ type: "text", content: value.slice(cursor, match.index) });
    }
    blocks.push({
      type: "code",
      lang: match[1].trim(),
      content: match[2].replace(/\n$/u, ""),
    });
    cursor = match.index + match[0].length;
  }

  if (cursor < value.length) {
    blocks.push({ type: "text", content: value.slice(cursor) });
  }

  return blocks;
}

export function parseMarkdownTextBlock(blockText) {
  const paragraphs = normalizeText(blockText)
    .split(/\n\s*\n/u)
    .map((item) => item.trim())
    .filter(Boolean);

  const segments = [];

  for (const paragraph of paragraphs) {
    const heading = paragraph.match(/^(#{1,3})\s+(.+)$/u);
    if (heading) {
      segments.push({
        type: "heading",
        depth: heading[1].length,
        text: heading[2],
      });
      continue;
    }

    const lines = paragraph
      .split(/\n/u)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      continue;
    }

    if (lines.every(isBulletLine)) {
      segments.push({
        type: "list",
        ordered: false,
        items: lines.map((line) => line.replace(/^[-*]\s+/, "")),
      });
      continue;
    }

    if (lines.every(isOrderedLine)) {
      segments.push({
        type: "list",
        ordered: true,
        items: lines.map((line) => line.replace(/^\d+\.\s+/, "")),
      });
      continue;
    }

    let cursor = 0;
    while (cursor < lines.length) {
      const line = lines[cursor];
      const ordered = isOrderedLine(line);
      const bullet = isBulletLine(line);

      if (ordered || bullet) {
        const items = [];
        while (
          cursor < lines.length &&
          ((ordered && isOrderedLine(lines[cursor])) || (bullet && isBulletLine(lines[cursor])))
        ) {
          items.push(
            lines[cursor].replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, ""),
          );
          cursor += 1;
        }
        segments.push({
          type: "list",
          ordered,
          items,
        });
        continue;
      }

      segments.push({
        type: "paragraph",
        text: line,
      });
      cursor += 1;
    }
  }

  return segments;
}

export function getConversationDetailLabel(block, fallback = "查看详情") {
  if (block?.displayLabel || block?.summary) {
    return normalizeText(block.displayLabel || block.summary) || fallback;
  }
  if (block?.kind === "script_snippet") {
    return "脚本内容 · 1 段脚本";
  }
  return fallback;
}

export function getConversationDetailMeta(block, joiner = " · ") {
  return [normalizeText(block?.countLabel), normalizeText(block?.summary)]
    .filter(Boolean)
    .join(joiner);
}
