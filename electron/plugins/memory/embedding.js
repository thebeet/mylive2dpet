const { fingerprint } = require("./records");
const { withTimeout } = require("../../llm/timeout");

function createEmbeddingClient(options, { fetchImpl, configureProxy } = {}) {
  const provider = () => fingerprint(JSON.stringify([options().endpoint, options().model]));
  async function embed(input, { signal } = {}) {
    const config = options();
    if (!config.enabled || !config.endpoint || !config.model) return null;
    return withTimeout(async requestSignal => {
      let fetcher = fetchImpl;
      if (!fetcher) {
        const session = require("electron").session.fromPartition("memory-embedding");
        await session.setProxy(config.proxy ? { proxyRules: config.proxy, proxyBypassRules: "<local>" } : { mode: "direct" });
        fetcher = session.fetch.bind(session);
      } else await configureProxy?.(config.proxy);
      requestSignal.throwIfAborted();
      const base = config.endpoint.replace(/\/+$/, "");
      const res = await fetcher(base.endsWith("/embeddings") ? base : `${base}/embeddings`, {
        method: "POST", signal: requestSignal,
        headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, input, encoding_format: "float" }),
      });
      // Never copy provider bodies or credentials into logs or model-visible errors.
      if (!res.ok) throw new Error(`记忆 embedding 请求失败 (${res.status})`);
      const result = await res.json();
      const rows = result.data;
      if (!Array.isArray(rows) || rows.length !== input.length) throw new Error("记忆 embedding 返回数量无效");
      const ordered = new Map();
      for (const row of rows) {
        if (!Number.isInteger(row.index) || row.index < 0 || row.index >= input.length || ordered.has(row.index)) throw new Error("记忆 embedding 返回索引无效");
        const vector = row.embedding;
        if (!Array.isArray(vector) || !vector.length || vector.length > 16384 || vector.some(n => !Number.isFinite(n)) || !vector.some(n => n !== 0)) throw new Error("记忆 embedding 向量无效");
        ordered.set(row.index, vector);
      }
      const vectors = input.map((_, i) => ordered.get(i));
      if (vectors.some(v => v.length !== vectors[0].length)) throw new Error("记忆 embedding 维度不一致");
      return vectors;
    }, { signal, timeoutMs: config.timeoutMs, label: "记忆 embedding" });
  }
  return { embed, provider };
}
module.exports = { createEmbeddingClient };
