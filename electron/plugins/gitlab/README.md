# GitLab 流水线状态插件

`gitlab` 是可选的主进程插件，依赖核心 Storage。支持 GitLab.com 和自建 GitLab 的 REST API v4，定期查询指定项目的流水线状态，把符合条件的新增或变化放入观察队列。

在 `config.json` 的 `plugins` 数组中添加以下条目，替换实例地址、项目和令牌后启用：

```json
{
  "name": "gitlab",
  "enabled": true,
  "baseUrl": "https://gitlab.example.com",
  "token": "填写访问令牌",
  "projects": [
    {
      "id": "group/project",
      "name": "服务端",
      "ref": "main",
      "statuses": ["failed", "success"]
    }
  ],
  "interval_ms": 60000,
  "timeoutMs": 20000,
  "emitOnFirstFetch": false,
  "observationTtlMs": 0
}
```

令牌需要能读取目标项目流水线的 API 权限（个人访问令牌可使用 `read_api`），通过 `PRIVATE-TOKEN` 请求头发送。也可以删除 `token` 并配置 `"tokenEnv": "GITLAB_TOKEN"`，从启动 Electron 的进程环境读取令牌；两者只能配置一个。令牌缺失时插件激活失败，不进行匿名查询。配置文件支持热重载，修改插件源码后需完整重启应用。

`baseUrl` 填实例地址，可包含自建实例的路径前缀，不要包含 `/api/v4`、查询参数或账号密码。可选 `proxy` 为 HTTP(S) 代理地址，默认直连；使用独立 Electron session。拒绝 HTTP 重定向，避免令牌随重定向发送。

## 筛选与采集

- `projects` 支持项目数字 ID、完整路径或示例中的对象；同一项目可分别配置不同分支。`name` 仅用于观察展示。空数组不安排轮询。
- `ref` 是精确分支或标签名称，留空采集所有 ref。
- `statuses` 留空或 `[]` 关注全部状态。支持 `created`、`waiting_for_resource`、`preparing`、`pending`、`running`、`success`、`failed`、`canceled`、`skipped`、`manual`、`scheduled`。示例关注失败和成功；只关心失败时改为 `["failed"]`。
- 启动立即查询，各项目查询完成后等待 `interval_ms`（默认60秒，最小1秒）。轮询串行且不重叠；单个项目失败不影响其它项目，HTTP 429 会遵循 `Retry-After`，最多延后一天。
- 默认首次成功读取只建立基线。`emitOnFirstFetch=true` 会把首次结果中符合筛选的流水线入队。
- 首次查询覆盖最近 `lookbackMs`（默认7天）内更新的流水线；之后使用持久化的上次查询时间继续查询，附加一分钟重叠窗口。API 每页100条，最多 `maxPages`（默认20，最大1000）页。达到限制时不推进游标，记录警告；可缩小首次回溯范围或提高分页上限。`timeoutMs` 限制单个项目本轮全部分页的网络阶段。
- 状态、ref、SHA 组成去重指纹；时间戳变化不会单独产生观察。状态过滤在本地执行，被过滤的状态也更新检查点，因此 `failed → running → failed` 可再次报告失败。这里只读取流水线列表，不查询作业日志、失败原因或子流水线。

## 观察与送达

每条观察为 `source=gitlab`、`role=context`、`trigger=gitlab-pipeline-update`。JSON 正文包含实例、项目、流水线 ID、当前／上一状态、ref、SHA、流水线来源、链接及 API 提供的时间。`eventType` 为 `new` 或 `status-changed`；后一种也包括同一 ID 的 ref/SHA 变化。

插件只提交观察，不主动请求决策、显示气泡或播放语音；由正常决策决定是否提醒。关闭自动决策后需要手动触发。`observationTtlMs=0` 不设置过期时间，正数从入队时起算。默认来源配额32条，需要时配置 `observations.perSource.gitlab`。

`gitlab.pipelines` 集合持久保存上一状态、指纹及游标，不保存令牌或原始响应；观察和警告中的当前令牌会脱敏，链接删除敏感查询参数。改变实例、项目、ref 或状态筛选视为新的订阅，重新建立基线；改令牌、间隔或代理沿用检查点。移除插件保留检查点，但会清理尚未处理的 GitLab 观察。

条目成功入队后才记录指纹，失败的条目下一轮重试。分页或中途处理失败时不推进查询时间。观察队列与 Storage 之间没有跨服务事务：入队后、记录前崩溃可能重复；队列是进程内数据，退出或容量淘汰可能丢失已入队观察。轮询只捕获查询时的状态，可能跳过两个轮询之间短暂出现的中间状态；时间游标假定本机与 GitLab 时钟基本一致。这些机制不保证每次状态变化都持久送达。

## 原始查询日志

右键「原始日志…」的 **GitLab** 标签页显示最近200次项目查询，每个项目每轮检查一条记录，重启保留。无需启用首轮入队：建立基线、无变化和被分支／状态筛选排除的结果也会记录；禁用或移除 GitLab 插件后仍可查看既有日志。

记录包含项目与筛选参数、代理、查询时间范围、耗时、每页请求地址、HTTP 状态、分页／限流信息，以及脱敏后的原始响应正文。流水线详情显示上一状态、变化类型、筛选结果和入队结果；网络、HTTP、JSON、分页、数据校验及入队失败保留失败原因与已获取的页。响应正文仍受 `maxResponseBytes` 限制，超限或读取中断的正文不保存；认证请求头不记录，当前访问令牌在正文和其它日志字段中脱敏。

`gitlab.history` 独立于 `gitlab.pipelines` 检查点，列表分页只发送元数据，选择记录后读取正文。日志写入失败不会阻止观察入队。「清理日志与截图」同时删除 GitLab 查询记录，保留流水线检查点及已入队观察；清理前开始的查询不会重新写入旧日志，清理后新查询继续记录。

运行 `node --test tests/gitlab.test.js` 检查基线、过滤、状态重试、分页、重启去重、失败重试、令牌脱敏、限流、代理、生命周期及原始查询日志。
