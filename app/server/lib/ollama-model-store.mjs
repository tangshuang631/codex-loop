function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

export async function listOllamaModels({
  baseUrl = "http://127.0.0.1:11434",
  fetchImpl = globalThis.fetch,
} = {}) {
  const response = await fetchImpl(`${safeText(baseUrl, "http://127.0.0.1:11434")}/api/tags`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`ollama model list request failed with status ${response.status}`);
  }

  const data = await response.json();
  const models = Array.isArray(data.models)
    ? data.models.map((model) => ({
        name: safeText(model.name, ""),
        size: Number(model.size || 0),
        modifiedAt: safeText(model.modified_at, ""),
      })).filter((model) => model.name)
    : [];

  return {
    models,
  };
}
