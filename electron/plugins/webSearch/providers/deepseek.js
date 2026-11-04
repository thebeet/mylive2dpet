function createDeepSeekProvider({ post }) {
  return {
    capabilities: { search: true, fetch: true },
    async search({ query, maxResults, includeContent, originalQuestion }, settings) {
      const data = await post("/tools/search", { query, count: maxResults, need_content: includeContent,
        ...(originalQuestion ? { ori_question: originalQuestion } : {}) }, settings);
      if (!Array.isArray(data?.results)) throw new Error("DeepSeek Search 返回缺少 results");
      return { results: data.results.map((item) => ({
        title: item.title, url: item.url, snippet: item.snippet, summary: item.summary,
        ...(includeContent && item.content ? { content: item.content } : {}),
        ...(item.date ? { publishedAt: item.date } : {}),
        ...(item.site_name ? { siteName: item.site_name } : {}),
      })) };
    },
    async fetch({ url }, settings) {
      let data;
      try {
        data = await post("/tools/fetch", { url }, settings);
      } catch (error) {
        // DeepSeek documents Fetch 404 as failure to obtain usable page content.
        // It does not prove that the source URL itself does not exist.
        if (error.status === 404) error.code = "page_content_unavailable";
        throw error;
      }
      if (typeof data?.title !== "string" || typeof data?.content !== "string" || !data.content.trim()) {
        throw new Error("DeepSeek Fetch 返回缺少网页正文");
      }
      return { url, title: data.title, content: data.content, format: "markdown" };
    },
  };
}

module.exports = { createDeepSeekProvider };
