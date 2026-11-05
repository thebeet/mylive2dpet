# 核心 Storage

应用在 `main.js` 创建 Storage，向插件宿主与模型客户端注入同一实例。`storage-sqlite` 负责注册后端、维护连接并提供 SQLite 仓库；核心和其他插件不依赖 SQLite 驱动、SQL、表名或文件路径。

## 消费接口

插件声明 `requires: ["storage"]`，使用宿主的 `context.storage`。服务注册表中的 `storage` 是同一抽象接口，可用于已有模块的依赖注入。

```js
const settings = context.storage.collection("my-plugin.settings");
settings.set("preferences", { language: "zh", enabled: true });
const preferences = settings.get("preferences"); // 不存在时 undefined
settings.list(); // [{ key, value }]，按 key 升序
settings.delete("preferences"); // 是否删除了记录
settings.clear(); // 清空当前命名空间

context.storage.transaction(() => {
  settings.set("preferences", { language: "zh" });
  context.storage.collection("my-plugin.state").set("revision", 2);
});
```

命名空间互相隔离，值通过 JSON 保存；不保存函数、undefined、循环引用或原生数据库对象。跨集合、跨仓库的修改可放在同一事务中，失败全部回滚。当前契约保持现有应用的同步操作语义：集合方法、仓库方法和事务回调必须同步，Promise 返回会被拒绝。未来采用网络后端时，需要实现这一语义，或单独进行核心及消费者的异步接口迁移。

业务数据使用 `repository(name, options)`，方法契约集中在 `contracts.js`。现有仓库为 `dialogue-history`、`raw-log`、`memory`、`work-memory`、`memory-practice` 和 `memory-updates`；参数与返回结构保持原有模块行为。新增插件一般使用自己的 JSON 集合，需要分页、检索或多记录不变量时可新增核心仓库契约及后端实现。

`hasRepository(name)` 查询业务数据结构是否已初始化，不创建表；`isAvailable()` 查询后端是否已加载；`getRevision()` 与 `subscribe()` 用于观察后端变更。插件卸载或后端更换后，旧仓库和集合句柄会拒绝操作。

## 后端接口

提供插件声明 `provides: ["storage"]`，在激活时调用 `context.storage.registerBackend(implementation)`，在卸载时调用返回的注销函数并关闭连接。宿主也会兜底注销。仅允许同时注册一个后端；声明提供能力才能注册，其他插件不能替换后端。

`storage.compact()` 请求后端回收空闲磁盘空间，返回 `{ supported: true }`；后端可选实现同步 `compact()`，不支持时核心返回 `{ supported: false }`。调用须位于事务外。

后端实现 `collection(namespace)`、`blobs(namespace)`、`repository(name, options)`、`hasRepository(name)` 和 `transaction(work)`。SQL、迁移、索引、连接池或其他数据库细节由后端内部负责。依赖规划根据 `storage` 服务安排先加载后端、后加载消费者；后端配置变化时，消费者先完成清理，再卸载后端，然后按依赖顺序重新加载。

SQLite 实现在 `plugins/storageSqlite/backend.js` 和 `repositories/`，保留原有业务表、迁移命名空间、唯一约束及来源记录。通用集合新增 `storage_json` 表，核心响应诊断日志使用 `core.ai-log` 集合。数据库仍位于配置的 `userData/pet.sqlite3`，已有数据库直接复用。旧配置 `storageService=storage-sqlite.database` 自动转换为核心 `storage`，不需要手动改配置；原有 JSONL 日志保留，不再追加。

## 二进制文件与截图

`storage.blobs(namespace)` 提供 `put(Uint8Array, metadata)`、`get(id)`、`getMetadata(id)`、`updateMetadata(id, patch)`、`list({before, limit})`、`delete(id)` 和 `clear()`。写入返回 ID、字节大小、保存时间与元数据；get 返回上述字段及二进制 data。getMetadata 和 list 不加载图片字节，list 按保存顺序倒序分页。updateMetadata 合并元数据，保留原图。句柄生命周期和事务语义与 JSON 集合相同。SQLite 用新增的 `storage_blobs` BLOB 表保存，无需 Base64 包装。

自动与手动截图均保存到 `screenshots` 命名空间，记录 JPEG、截图时间、文件名、宽高、MIME 类型、字节大小、trigger 和 manual。自动截图先做变化检测，只有哈希距离严格大于 changeDetect.threshold 才保存并入队；首帧作为基准保存，关闭变化检测时全部保存。未超过阈值的图片仅用于更新检测基准，不写入 Storage。手动保存截图跳过变化检测、直接保存且不入队；停止或卸载期间返回的迟到截图不保存。当前不自动删除持久化截图，历史截图文件不自动导入或删除。

模型收到的观察用 `storage://screenshots/<id>` 引用原图。处理成功后，截图元数据追加 analyses：decisionId、completedAt、screenshotIds、screenSummary 和 workSummary。同批多图共享模型的整批摘要，screenshotIds 明确标记范围；未处理或失败的截图没有分析结果。观察完成、过期、丢弃及插件卸载不删除原图或摘要。

原始请求日志中的图片 URL 保存为 Storage 引用。核心模型客户端在请求正文之外传递图片位置与原图引用，实际 API 请求仍携带缩放、压缩后的 Base64；日志中的 `logImageSource=original` 表示引用原图，不能据此逐字节还原发送时的图片。查看单条日志时才读取图片生成临时预览，日志 JSON 始终保留短引用。

无原图引用的新请求以及已有日志中的合法内联图片转存到 `raw-log-images`，按 MIME 类型与图片字节的 SHA-256 去重，`raw-log.image-index` 保存哈希索引。这些图片标记为 `encoded-request`，保留实际编码字节；无法可靠关联到现有截图的旧图片不猜测匹配，未知格式保留原字段。原始日志仓库的 `rewriteRequests(transform)` 分批遍历内联图片请求，每行转换及关联图片写入同一事务；`raw-log.migrations` 保存完成标记，失败后可继续迁移。当前不自动删除图片；SQLite 替换大 JSON 后释放的页用于后续写入，数据库文件不会立即缩小，不自动执行 VACUUM。旧 JSONL 文件不自动修改。

原始日志仓库新增 `listGroups({before, limit})` 和 `getGroup(id)`，同上下文段由客户端在请求正文之外携带 conversation 元数据关联；raw-log 版本2保存该标识及轮次／重试标识，旧记录不推测关联。listGroups 以每组最早请求序号倒序分页，返回累计用量及轮数／请求数／失败数；计数缺失时累计值保持未知。后端 getGroup 按序返回完整请求记录，消费层只发送首轮初始上下文和各次新增输入／响应给界面，逐次完整请求继续通过 get 读取。

原始日志消费层的 clear() 组合仓库清理、screenshots/raw-log-images 清空、图片哈希索引、core.ai-log、web-search.history 和 rss.history 清空，在同一事务中递增 core.log-lifecycle.generation；仓库后端 clear() 只删除该仓库请求记录。代次永久保留，用于拒绝清理前工作产生的迟到写入，RSS 获取日志同样拒绝清理前开始的响应回写。其它业务仓库、记忆、对话历史及 rss.feeds 更新检查点保留，清理事务提交、旧文件及待处理截图清理后，调用核心 storage.compact() 自动压缩数据库。SQLite 后端在事务外先合并并截断 WAL、执行 VACUUM，再合并并截断 WAL，将空闲空间归还磁盘；压缩期间同步阻塞写入。压缩失败不回滚已完成的清理，界面分别提示清理成功和压缩失败，可再次清理重试。
