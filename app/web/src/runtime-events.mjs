function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

function normalizeDisplayText(value) {
  return safeText(value, "")
    .replace(/\s+/g, " ")
    .replace(/[。.!！?？]+$/u, "")
    .trim();
}

function runtimeEventDisplayKey(event = {}) {
  const detail = normalizeDisplayText(event.detail);
  if (detail) {
    return detail;
  }

  return [safeText(event.type, ""), normalizeDisplayText(event.title)].join("|");
}

export function dedupeRuntimeEventsForDisplay(events = [], limit = 4) {
  const seen = new Set();
  const visible = [];

  for (const event of events.filter(Boolean)) {
    const key = runtimeEventDisplayKey(event);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    visible.push(event);
    if (visible.length >= limit) {
      break;
    }
  }

  return visible;
}
