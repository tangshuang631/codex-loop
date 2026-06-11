function normalizeText(value) {
  return String(value ?? "").trim();
}

function dedupeConversationItems(entries = []) {
  const seen = new Set();
  return entries.filter((entry) => {
    const preview = normalizeText(entry?.preview || entry?.text || entry?.summary).slice(0, 240);
    const key = [entry?.role || "", entry?.at || "", preview].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sortConversationItems(entries = []) {
  return [...entries].sort((a, b) => {
    const left = Date.parse(a?.at || "");
    const right = Date.parse(b?.at || "");
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
    if (!Number.isFinite(left)) return 1;
    if (!Number.isFinite(right)) return -1;
    return left - right;
  });
}

export function buildConversationItemsFromMobileView(
  mobileView,
  {
    latestPromptLabel = "",
    assistantFallbackLabel = "",
    runtimeFallbackLabel = "",
  } = {},
) {
  if (Array.isArray(mobileView?.conversationItems) && mobileView.conversationItems.length) {
    return sortConversationItems(dedupeConversationItems(mobileView.conversationItems));
  }

  const mirrored = Array.isArray(mobileView?.codexConversation?.entries)
    ? mobileView.codexConversation.entries
    : [];
  if (mirrored.length) {
    return sortConversationItems(dedupeConversationItems(mirrored));
  }

  const entries = [];
  const latestPrompt = normalizeText(mobileView?.latestPrompt);
  if (latestPrompt) {
    entries.push({
      role: "user",
      at: mobileView?.thread?.lastDispatchAt || "",
      text: latestPrompt,
      preview: latestPrompt,
      ...(latestPromptLabel ? { label: latestPromptLabel } : {}),
    });
  }

  for (const entry of mobileView?.transcriptEntries || []) {
    const summary = normalizeText(entry?.summary || entry?.note);
    if (!summary) continue;
    entries.push({
      role: "assistant",
      at: entry?.at || "",
      text: summary,
      preview: summary,
      ...(entry?.activeTask || assistantFallbackLabel
        ? { label: entry?.activeTask || assistantFallbackLabel }
        : {}),
    });
  }

  for (const event of mobileView?.runtimeEvents || []) {
    const detail = normalizeText(event?.detail || event?.title);
    if (!detail) continue;
    entries.push({
      role: String(event?.type || "").includes("dispatch") ? "user" : "assistant",
      at: event?.at || "",
      text: detail,
      preview: detail,
      ...(event?.title || runtimeFallbackLabel
        ? { label: event?.title || runtimeFallbackLabel }
        : {}),
    });
  }

  return sortConversationItems(dedupeConversationItems(entries));
}
