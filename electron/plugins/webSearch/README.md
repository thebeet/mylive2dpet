# Web Search 插件

统一只读接口将 provider 协议和模型决策分离：

```js
// 消费插件声明 requires: ["web-search.client"]。
const web = context.services.get("web-search.client");
web.capabilities; // { search: true, fetch: true/false }
await web.search({ query: "Electron 最新版本", maxResults: 5 }, { signal });
await web.fetch({ url: "https://example.com/article" }, { signal });
```

`search()` 返回 `{ provider, query, results: [{ title, url, snippet?, summary?, content?, publishedAt?, siteName? }], answer?, answerKind? }`。`fetch()` 返回 `{ provider, url, title, content, format, truncated }`。搜索结果 URL 去重并仅保留无凭据的 HTTP/HTTPS 地址，结果数量和文本长度受配置限制。search 的 `includeContent`、`originalQuestion` 是可选参数；OpenAI 不提供搜索结果逐页正文，`includeContent` 不会让它伪造正文。

provider 实现 `capabilities`、`search(input, {signal})` 和可选 `fetch(input, {signal})`，不访问插件总线或窗口。工厂在 `client.js` 注册；新增生产 provider 时同时扩展 `options.js` 的可选名称和配置校验。测试或嵌入场景可用 `providerFactories` 注入实现。HTTP 鉴权、独立 Electron 网络会话、代理、整轮超时和有限重试放在 `transport.js`，不复用主对话的 Chat Completions 传输。

## 内置 provider

| Provider | Search | Fetch |
| --- | --- | --- |
| DeepSeek | `POST /v1/tools/search`，结构化标题/URL/短摘要/长摘要，可请求正文 | `POST /v1/tools/fetch`，标题和 Markdown 正文 |
| OpenAI | `POST /v1/responses`，`web_search` 工具、来源引用及模型综合回答 | 不提供独立网页原文 Fetch |

OpenAI 的 `answerKind=model-synthesis` 明确区分综合回答和网页原文，来源没有提供 snippet 时不生成占位或把整段回答复制成每个来源的摘要。要求响应 completed 且实际完成 web_search_call，拒绝不完整响应、未使用搜索工具的回答及模型 refusal。模型由配置明确指定，必须支持 Responses web_search；此配置独立于 `conversation.ai.model`。

DeepSeek 的请求和响应已依据 [Search 文档](https://api-docs.deepseek.com/zh-cn/api/search/)、[Fetch 文档](https://api-docs.deepseek.com/zh-cn/api/fetch/) 与[使用指南](https://api-docs.deepseek.com/zh-cn/guides/search)核对。OpenAI 适配的目标是 [Responses web search](https://developers.openai.com/api/docs/guides/tools-web-search?api-mode=responses)；本次环境获取该官方页面时返回 HTTP 403，尚未核实账户/模型实际可用性，也未调用真实收费 API。OpenAI 请求和返回解析通过模拟测试验证，启用后需要以所选模型做真实联调。

## 配置

默认不加载，在 `plugins` 中启用并填写所选 provider 的凭据：

```json
{
  "name": "web-search",
  "enabled": true,
  "searchProvider": "deepseek",
  "fetchProvider": "deepseek",
  "providers": {
    "deepseek": {
      "endpoint": "https://api.deepseek.com/v1",
      "apiKey": "YOUR_DEEPSEEK_API_KEY",
      "proxy": ""
    }
  },
  "timeoutMs": 60000,
  "maxRetries": 1,
  "maxResults": 5,
  "maxContentChars": 16000,
  "maxConcurrent": 2,
  "maxPending": 16,
  "maxRequestsPerChain": 4,
  "observationTtlMs": 300000
}
```

使用 OpenAI 搜索时设置 `searchProvider="openai"` 并配置 `providers.openai.endpoint="https://api.openai.com/v1"`、`apiKey` 和 `model`。`fetchProvider=""` 关闭独立网页读取，或设为 `deepseek` 并另外配置它的 key。示例配置不含真实凭据，不修改当前用户配置。配置启用但所选 key/model 缺失时明确报错。

`timeoutMs` 覆盖网络请求、响应正文读取及全部重试。只重试 408、429、5xx 和网络错误，不重试 401、402、403 等永久错误。结果文字按预算截断，Fetch 用 truncated 标明；provider 响应正文和 Authorization 不写入日志，模型只收到一般错误及 HTTP 状态。

## 决策消息流

```text
模型 effects → decision.completed
  → web-search 筛选 query/fetch → 后台并发受限请求
  → 成功/失败结果作为 context 观察入队
  → 请求 web-search-result 决策 → 模型引用来源继续回答
```

系统提示词与 effect Schema 由插件注册：

```json
{ "type": "web-search.query", "query": "Electron 最新版本", "maxResults": 5 }
```

配置支持 Fetch 时另提供：

```json
{ "type": "web-search.fetch", "url": "https://example.com/article" }
```

订阅者只安排后台任务，不等待网络，避免阻塞其他决策完成插件。结果观察保留 originalQuestion、requestId、decisionId、chainId 与 chainUsed；不带音频或图片摘要字段。每个 effect 按决策 ID 与序号在本次插件实例中去重；队列、去重记录和链计数为有界进程内状态，不跨重启恢复，也不自动重放历史 effects。同一链最多指定次数，超额请求跳过并记录原因。共享观察队列仍遵循其容量和淘汰规则，结果入队失败会记录错误。

插件停止会取消在途 HTTP 请求及待决策请求，丢弃尚未开始的工作；迟到结果不再入队。卸载清理提示词、服务和订阅。网页内容与搜索回答是外部资料，提示词要求引用实际返回的 URL，并忽略网页中的指令。

查新闻或没有具体 URL 时，提示词要求先搜索；Fetch 只读取用户提供或本次搜索返回的地址，且摘要足够时无需读取正文。依据 DeepSeek 指南，Fetch 的 HTTP 404 表示未能取得可用正文，也可能由站点策略或无法提取正文导致，不能直接认定链接不存在。结果以 `errorCode=page_content_unavailable` 提醒模型使用摘要或改用搜索；其他 HTTP 失败为 `provider_http_error`，不向模型暴露服务返回的错误正文。

模型 Fetch 的地址来源由插件在发送请求前校验：只允许当前请求链内用户文本中的 HTTP(S) 地址，以及该链搜索实际返回的 URL。地址记录为有界进程内状态；新问题不继承上一问题的地址。未验证地址以 `errorCode=unverified_fetch_url` 返回，明确指出请求未发送并引导模型改用搜索。直接调用 `web-search.client.fetch()` 的业务插件不受此模型地址来源限制。系统提示词不提供可照抄的具体 Fetch 示例地址。

## 诊断日志

控制台默认输出单行 JSON 诊断信息，沿用 `[plugin:web-search]` 前缀。`effect.received` 记录模型的实际 type/query/url/maxResults、回复和请求链；`effect.queued/skipped` 记录排队、去重或限额原因；`fetch.rejected` 记录被拦截的 URL、允许地址及 `networkRequestSent=false`。`request.start/success/failed/cancelled` 记录耗时、错误码、结果数量、来源标题/URL 和正文长度。`http.start/response/failed` 记录实际 API URL、HTTP 状态、尝试次数、重试决定和响应字符数。`observation.queued` 和 `decision.requested` 标明结果入队与后续决策。

通过相同 `requestId` 关联 effect、HTTP 和结果；`decisionId`、`chainId` 与 `chainUsed` 用于追踪模型是否重复调用错误操作。直接服务调用使用 `direct:` 请求 ID。日志屏蔽已配置的 provider API Key、URL 凭据与 URL 查询参数值，文本和来源列表长度有上限；不输出请求头、HTTP 响应正文、网页正文或模型综合答案。

如果模型回复说正在搜索，但 `effect.received` 连续显示 Fetch，且没有 `http.start`，先排查主对话服务的结构化输出兼容性。当前第三方主模型服务的最小请求实测中，`json_schema` 模式在明确要求 Search 时仍返回 Fetch；相同请求改为 `json_object` 后正确返回 Search，完整桌宠提示词下也实际取得了 DeepSeek 搜索结果。此类服务可在 `conversation.ai` 配置 `"outputFormat": "json_object"`；该配置控制主模型决策输出，与 DeepSeek Search/Fetch 的 provider 配置独立。核心保留 JSON 字段、类型、摘要等本地校验，插件继续校验 effect 参数和 Fetch 地址来源。默认 `auto` 只在服务明确报不支持结构化格式时降级，无法通过 HTTP 200 自动识别这种 effect 选择异常。

## 原始日志中的历史记录

插件加载后提供 `web-search.history` 服务，原始日志窗口自动显示 `web-search` 标签页；卸载后隐藏。标签页每 2 秒更新，支持分页和查看详情：记录 Search/Fetch 参数、触发问题、模型回复、请求链、provider、HTTP 尝试记录、耗时、结果或失败原因。直接服务调用也会记录；被拦截、超出限额、取消的请求明确显示对应状态。

从此功能启用后开始记录，保留最近 500 条。有 Storage 时使用 `web-search.history` 集合持久保存，重启后仍可查看；上次未完成的请求标记为取消，不自动重放。没有 Storage 时仅保留进程内记录，不影响搜索能力。原始日志窗口的“清理日志与截图”同时清除网页请求记录，迟到的 HTTP 或完成通知不会恢复已删除的记录。结果正文仅在选中详情时传给窗口，记录中屏蔽 provider Key、URL 凭据和 URL 查询参数值。
