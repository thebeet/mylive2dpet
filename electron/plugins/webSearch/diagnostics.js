function createSanitizer(options, { maxString = 1000, maxItems = 20 } = {}) {
  const secrets = Object.values(options.providers || {}).map((config) => config.apiKey).filter(Boolean);
  function clean(value, key = "") {
    if (Array.isArray(value)) return value.slice(0, maxItems).map((item) => clean(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).map(([name, item]) => [name,
        /apiKey|authorization|password|token|secret/i.test(name) ? "[redacted]" : clean(item, name)]));
    if (typeof value !== "string") return value;
    let text = value;
    for (const secret of secrets) text = text.split(secret).join("[redacted]");
    if (/url|endpoint/i.test(key)) {
      try {
        const url = new URL(text);
        url.username = ""; url.password = ""; url.hash = "";
        for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, "[redacted]");
        text = url.href;
      } catch { /* Preserve invalid addresses for diagnosis, without configured keys. */ }
    }
    return text.slice(0, maxString);
  }
  return clean;
}

function createDiagnostics(options, logger) {
  const clean = createSanitizer(options);
  return (event, fields = {}, level = "info") => {
    logger?.[level]?.(`web ${event}: ${JSON.stringify(clean(fields))}`);
  };
}

module.exports = { createDiagnostics, createSanitizer };
