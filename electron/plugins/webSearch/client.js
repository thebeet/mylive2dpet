const { createTransport } = require("./transport");
const { createDiagnostics } = require("./diagnostics");
const { createDeepSeekProvider } = require("./providers/deepseek");
const { createOpenAIProvider } = require("./providers/openai");

const PROVIDERS = { deepseek: createDeepSeekProvider, openai: createOpenAIProvider };

function httpUrl(raw) {
  if (typeof raw !== "string" || raw.length > 8192) throw new Error("网页 URL 无效");
  let url;
  try { url = new URL(raw); } catch { throw new Error("网页 URL 无效"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error("网页 URL 必须为不带用户名或密码的 HTTP/HTTPS 地址");
  return url.href;
}

function createWebClient(options, dependencies = {}) {
  const providers = new Map();
  const factories = { ...PROVIDERS, ...dependencies.providerFactories };
  const diagnostics = dependencies.diagnostics || createDiagnostics(options, dependencies.logger);
  function provider(name) {
    if (!name || !factories[name]) throw new Error("未配置支持此操作的网页 provider");
    if (!providers.has(name)) {
      const config = options.providers[name];
      if (!config) throw new Error(`未配置网页 provider: ${name}`);
      const implementation = factories[name]({ config, post: createTransport(config, options, { ...dependencies, diagnostics, providerName: name }) });
      if (!implementation?.capabilities || typeof implementation.search !== "function") throw new Error(`网页 provider 契约无效: ${name}`);
      providers.set(name, implementation);
    }
    return providers.get(name);
  }
  const capabilities = { search: true, fetch: Boolean(options.fetchProvider) };
  return {
    capabilities,
    async search(input = {}, settings = {}) {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query || [...query].length > 128) throw new Error("搜索词须为 1～128 个字符");
      const maxResults = input.maxResults ?? options.maxResults;
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > options.maxResults) throw new Error("搜索结果数量超出配置范围");
      if (input.includeContent != null && typeof input.includeContent !== "boolean") throw new Error("includeContent 必须为布尔值");
      if (input.originalQuestion != null && (typeof input.originalQuestion !== "string" || !input.originalQuestion.trim() || [...input.originalQuestion].length > 128)) {
        throw new Error("原始问题须为 1～128 个字符");
      }
      settings.signal?.throwIfAborted();
      const data = await provider(options.searchProvider).search({ query, maxResults,
        includeContent: input.includeContent === true, originalQuestion: input.originalQuestion }, settings);
      settings.signal?.throwIfAborted();
      if (!Array.isArray(data?.results)) throw new Error("网页搜索 provider 返回无效结果");
      let remaining = options.maxContentChars;
      const cut = (value) => {
        if (typeof value !== "string" || !remaining) return "";
        const text = value.slice(0, remaining); remaining -= text.length; return text;
      };
      const seen = new Set();
      const results = [];
      for (const item of data.results) {
        if (results.length >= maxResults) break;
        let url;
        try { url = httpUrl(item.url); } catch { continue; }
        if (seen.has(url)) continue;
        seen.add(url);
        const result = { title: cut(item.title), url };
        for (const field of ["snippet", "summary", "content", "publishedAt", "siteName"]) {
          if (item[field]) result[field] = cut(item[field]);
        }
        results.push(result);
      }
      const answer = cut(data.answer);
      return { provider: options.searchProvider, query, results,
        ...(answer ? { answer, answerKind: data.answerKind || "model-synthesis" } : {}) };
    },
    async fetch(input = {}, settings = {}) {
      const url = httpUrl(input.url);
      const implementation = provider(options.fetchProvider);
      if (!implementation.capabilities.fetch || typeof implementation.fetch !== "function") throw new Error("此 provider 不支持独立网页 Fetch");
      settings.signal?.throwIfAborted();
      const data = await implementation.fetch({ url }, settings);
      settings.signal?.throwIfAborted();
      if (typeof data?.content !== "string" || !data.content.trim()) throw new Error("网页 Fetch provider 返回无效正文");
      return { provider: options.fetchProvider, url, title: String(data.title || "").slice(0, 500),
        content: data.content.slice(0, options.maxContentChars), format: data.format || "text",
        truncated: data.content.length > options.maxContentChars };
    },
  };
}

module.exports = { createWebClient, httpUrl };
