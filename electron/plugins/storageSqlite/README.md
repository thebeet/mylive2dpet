# SQLite 存储后端插件

`storage-sqlite` 为核心 Storage 提供 SQLite 后端，统一管理业务仓库、JSON 集合、二进制图片、事务与迁移。默认加载并提供 `storage` 服务。

## 配置

在根配置的 `plugins` 数组中添加或修改对应条目。以下为配置示例：

```json
{
  "name": "storage-sqlite",
  "enabled": true,
  "path": "pet.sqlite3",
  "busyTimeoutMs": 5000
}
```

`path` 是数据库文件路径，相对路径以 Electron `userData` 为基准；`busyTimeoutMs` 是等待数据库锁的超时时间（毫秒）。

## 存储接口

应用和插件通过核心 Storage 的 JSON 集合与业务仓库存储结构化数据；`storage-sqlite` 提供当前后端实现。SQL 和迁移集中在后端，消费者依赖 `storage` 服务，旧的 SQLite 服务名配置自动兼容。后端切换会按依赖关系重载消费者。接口和扩展约定见 [Storage 文档](../../storage/README.md)。配置文件、模型资源和语音临时文件通过文件系统管理。截图直接通过 Storage 二进制接口保存，不再生成临时 JPG。

## 数据位置与备份

| 数据 | 默认位置 || --- | --- |
| 配置 | 项目根目录 `config.json` |
| 长期记忆、人物画像、项目与经验、来源、提问记录和历史对话 | Electron `userData/pet.sqlite3` |
| 定时通知任务 | 同一数据库的 Storage `schedule.tasks` 集合 |
| RSS 更新检查点与获取日志 | 同一数据库的 Storage `rss.feeds`、`rss.history` 集合；获取日志保留最近200次 |
| 自动截图 | 变化超过 changeDetect.threshold 后存入 Storage 的 `screenshots` 命名空间，保存 JPEG 原图及采集信息；首帧保存 |
| 手动保存截图 | 同样存入 Storage 的 `screenshots` 命名空间 |
| AI 响应诊断日志 | 核心 Storage 的 `core.ai-log` 命名空间，正文总量限制为 5 MiB |

Linux 默认数据库通常位于 `~/.config/mylive2dpet/pet.sqlite3`，实际位置以启动日志中的 `database opened` 为准。数据库文件名可通过存储插件的 `path` 配置。

记忆和历史对话统一写入 SQLite。备份数据库时关闭应用，或使用 SQLite 备份机制，以包含 WAL 中的最新记录。

记忆和历史保存在本地。截图与转写文本会按配置发送给 AI 模型接口；使用本地 FunASR 或 Whisper 只决定语音转写在哪里执行。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
