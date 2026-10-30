# 主进程与插件消息流

核心提供插件生命周期、消息总线、观察队列、决策调度、对话策略与共享模型客户端。具体感知来源、记忆维护和输出扩展由插件实现；Electron 窗口、托盘、受控 IPC、Live2D 以及底层屏幕捕获是宿主能力。

```text
视觉插件：定时截图 → 变化检测 ─┐
音频插件：输出监视源 → ASR ───┼→ perception.submit(observation)
手动对话插件：输入窗口 ──────┘
  → 通用观察队列
  → 定时 / 点击 / 手动消息触发 decision.requested
  → 核心过滤过期观察并按时间排序
  → 调用核心 conversation 收集上下文并生成决策
  → 等待 decision.completed 的记忆、历史及其它观察者完成记录
  → 显式调用 execution.presentDecision，展示气泡并发布 execution.speech.requested
  → TTS 插件合成和播放
```

队列为空时跳过决策。用户消息优先进入批次，再按时间排序；默认每批最多 16 条。瞬时网络错误允许有限回队重试，永久错误进入失败记录；能够定位到观察 ID 的错误只拒绝该观察，其余输入保留。没有图片时也可以处理手动消息或音频文字。

## 观察队列、调度与资源

`observations` 配置默认总容量 128、每批 16、回队重试 2 次；来源配额为视觉 6、音频 20、手动输入 100，其它来源默认 32。补充观察达到容量时淘汰最旧补充项；用户消息容量不足时提交直接报错，输入窗口保留文本。回队不会淘汰已接收的用户消息，因此故障恢复时队列最多额外保留一个在途批次。失败记录在进程内最多保留 100 条，可通过核心 `perception.getRejected()` 查询；`pipeline.failed` 带有回队和拒绝数量。

生产者通过 `perception.submit()`、`discard()` 操作观察。核心取批、完成、过期、失败或丢弃观察时发布 `perception.observation.released`，资源所有者据此释放文件。视觉观察默认有效期 60 秒，自动截图写入 `userData/cache/screen-perception/`，由视觉插件追踪和删除；启动时清理该临时目录的遗留 JPG。手动保存截图仍写入 `logs/screenshots/`。以前该目录中的文件不自动删除。

`decisionScheduler.js` 独立管理串行请求、间隔计时和等待者取消，不使用轮询。忙碌期间相同 trigger 的等待请求合并为下一轮；即使关闭自动决策，批次剩余的用户消息仍会触发后续决策。自动感知的剩余观察遵循配置间隔。停止时取消等待者和在途决策，应用等待调度器与插件完成清理后退出。

`conversation/history.js` 由对话核心拥有，每个模型会话维护进程内的记忆快照、会话摘要和 user/assistant 文字历史。核心串行处理主决策，文本提取请求可独立进行。请求布局为固定 system、快照/摘要背景、历史消息、当前观察；动态时间位于本轮输入，记忆仅在段首检索一次，段内不追加检索背景，成功汇总后再刷新快照。已提交的历史文本不重写，图片仅用于当前批次，历史保存主模型的观察摘要。`conversationHistory=true` 告知上下文提供者已有核心历史，记忆插件据此跳过重复的近期对话注入；其它调用者仍可获得原有近期上下文。

`conversation.history` 控制压缩：默认已有32轮或预计输入50000 token 时汇总较早回合，保留最近4轮；摘要请求输出上限1600 token、正文上限6000字符，成功验证后才消费旧历史。输入估算使用文字 UTF-8 字节数和上一轮接口 usage，不能精确预判新图片成本；硬预算默认100000，连续失败最多积累64轮。硬上限阻止继续发送更长主请求，原内容仍保留供重试。摘要和长期记忆维护使用各自的任务提示词与必要数据。`memory.cleared` 同步清除核心历史并取消在途决策/汇总；上下文提供者注册代次变化在下一轮重置会话，模型配置变化建立新会话，停止/恢复保留本次进程状态。未将会话摘要写入旧的记忆摘要数据库字段。

## 消息发布与错误处理

总线提供两种发布方式，订阅者都按注册顺序执行，并等待每个订阅者返回的 Promise：

- `await bus.publish(type, payload)` 用于请求：`decision.requested`、`execution.speech.requested` 和 `execution.speech.stop.requested`。订阅者失败时停止本次发布并向调用方抛出错误；调用方必须等待并处理错误。
- `await bus.notify(type, payload)` 用于通知：观察入队、感知跳过、决策开始/完成、播放状态和流水线失败。逐个捕获订阅者错误、记录事件名与订阅者标识，然后继续通知其余订阅者。需要保证后续流程顺序时必须等待；无需等待时可用 `void bus.notify(...)`。

插件通过 `context.bus` 使用发布与订阅接口，不直接访问总线队列。插件发布 `decision.requested` 时也经过调度器，推荐使用 `context.decisions.request()`。宿主自动给插件订阅附加插件名。核心订阅也可通过 `bus.subscribe(type, handler, { owner: "模块名" })` 标明归属。通知错误直接写日志，不再发布错误事件，日志记录失败也不会中断通知。

观察已入队后，入队通知的订阅者失败不会让提交报错；决策完成通知的订阅者失败不会让成功的观察重新入队。决策流程在完成记录后显式调用执行模块，并等待语音请求；呈现失败通过 `pipeline.failed` 报告，仍释放已完成观察，不重放成功回合。TTS 播放开始与结束状态仍按顺序通知，某个订阅者报错不会阻止音频感知更新播放状态。

## 通用观察与决策契约

`electron/architecture/contracts.js` 定义观察和决策结果，`perceptionService.js` 提供统一观察入口与来源注册。决策模块通过注入的 `conversation.decideFromObservations` 调用核心对话，验证结果、完成记录，再呈现回复；模型请求封装在共享客户端中。

```js
// 所有感知插件通过同一入口入队。
await context.perception.submit({
  source: "my-source",
  role: "context", // user：直接对桌宠说的话；context：外部补充观察
  trigger: "interval",
  capturedAt: new Date().toISOString(), // 省略时由宿主生成
  expiresAt: Date.now() + 60000, // 可选，毫秒时间戳
  content: [
    { type: "text", text: "观察内容" },
    { type: "image", path: "/absolute/path/image.jpg", mimeType: "image/jpeg" },
  ],
  metadata: { label: "来源说明" },
});

// 宿主生成 observation.id。来源扩展通过通用上下文补充对话。
context.decisionContext.register(async () => [
  { id: "background", title: "背景信息", text: "供本轮对话参考的内容" },
]);
```

核心验证通用字段，不根据截图路径或音频类型决定流程。核心对话策略适配支持的内容类型；当前实现支持文本、本地图片、图片 URL 和图片 data URI，遇到其它类型会明确报错。`summaries` 可按来源扩展，当前核心对话使用 `screen` 和 `audio`。

## 插件宿主与扩展接口

`electron/plugins/manifest.js` 只汇总各插件的 `definition.js`；每个定义集中声明 `normalizeOptions`、加载规则及服务依赖。`electron/pluginHost.js` 使用同一清单加载插件，注入配置读取、日志、总线、菜单、感知入口、决策请求、上下文注册、核心模型、通用服务、路径、窗口创建、受控 IPC、屏幕捕获及表情列表。插件通过 `activate(context)` 注册能力，并返回包含 `start`、`stop`、`dispose` 的生命周期对象。方法可以返回 Promise；不再使用单独的清理函数作为插件句柄。

宿主串行处理激活、启动、停止和卸载请求，重复启动不会再次启动已运行的插件。停止时按加载的逆序向所有插件发出取消请求，再等待全部停止完成；卸载先停止所有插件，再按逆序等待各插件清理注册和资源。单个插件清理失败会记录日志，其余插件继续清理。重复卸载返回同一 Promise，卸载后的宿主不再启动或激活插件。应用在 `before-quit` 中等待卸载完成后退出。

manifest 使用 `provides`、`requires`、`optional` 声明服务，字段可以是数组或读取配置的函数。宿主按依赖排序，检测缺失服务和循环，并在启动时检查必需依赖是否已启动。失败不会阻止无关插件加载；`pluginHost.getState()` 返回每个插件的状态和不可用原因。存储关闭前，依赖插件先完成卸载。

停止后的插件菜单隐藏，旧菜单回调不再执行，IPC、观察提交、来源捕获、决策请求和新注册被拒绝；停止期间的普通订阅不执行，卸载后已被总线取出的订阅快照也不会执行。用于清理文件或维护播放状态的订阅可以显式设置 `{ allowWhileStopped: true }`。服务函数和对象方法也受生命周期检查；SQLite 服务显式允许停止期间访问，供依赖插件收尾。窗口由拥有它的插件在停止时关闭，宿主在卸载时兜底销毁。

菜单通过 `context.menu.register()` 挂载，通过 `context.menu.refresh()` 请求刷新。来源插件通过 `context.perception.registerSource(name, capture)` 注册可主动调用的来源，宿主通过 `perception.capture(name, request)` 调用。底层 Electron 截图适配器 `electron/platform/screenCapture.js` 通过 `context.screen.captureFullscreen()` 提供给视觉插件。

插件通过 `context.decisions.request({ trigger, signal, waitTimeoutMs })` 请求核心调度决策。默认等待上限为 120 秒。`signal` 可取消尚未开始的请求，已开始的模型任务由核心对话管理，调度器停止时统一取消在途请求。插件负责捕获返回 Promise 的错误。窗口定位可以读取 `context.pet.getBounds()`（桌宠未显示时为 `null`），以及 `context.screen.getPrimaryDisplay()`、`getDisplayNearestPoint(point)` 提供的显示器工作区。

- `manual-input`：输入窗口、preload、文本验证、用户观察提交、即时决策请求与「手动对话…」菜单。IPC 使用 `manual-input:submit` 和 `manual-input:close`，仅接受自身窗口发送的请求。停止时关闭窗口并取消等待中的决策请求；卸载时清理菜单与 IPC。
- `screen-perception`：截图周期、变化检测状态和图片观察生成。停止时清理定时器，丢弃并清理尚未完成的旧周期截图。手动保存截图不入队。
- `audio-output-perception`：音频采集、分段、转写、去重与观察有效期。转写使用 `content: [{ type: "text", text }]`，音频详情保存在 `metadata`。
- `tts`：独立订阅通用语音请求并发布播放状态。实例管理运行开关、任务队列、取消信号、合成器和播放器；停止或卸载时取消全部任务并等待清理完成。
- `storage-sqlite`：共享数据库连接、事务与表结构迁移；最先加载、最后卸载。
- `dialogue-history`：独立记录决策完成事件，管理历史表、分页与搜索、历史窗口、IPC 和菜单。
- `memory`：统一管理近期对话、人物画像和长期 SQLite 存储。注册上下文提供者，订阅决策完成事件独立记录回合，通过宿主注入的核心模型接口每20轮对话更新长期记忆。

手动对话插件默认加载，配置 `manual-input.enabled=false` 时不加载。视觉插件随宿主加载，`enabled` 控制自动采集；`enabled=false` 或 `interval_ms<=0` 时仍可通过截图服务手动采集。音频插件配置存在时加载，`enabled` 控制启动时是否采集，以支持本次运行的菜单开关。TTS 和记忆插件按各自的启用配置加载；对话核心由应用创建，其 `enabled` 控制对话和文本生成，记忆插件的整体开关与 shortTerm/longTerm 子项开关独立。

## 文件归属

插件专用实现与入口放在同一个插件目录，多个功能共用的系统适配器放在 `electron/platform/`，通用契约与调度保留在核心。

```text
electron/
├── architecture/                  # 通用观察、决策、队列与总线
├── conversation/                  # 对话策略、提示词、解析与模型生命周期
├── llm/                           # 共享模型传输、超时、重试与日志
├── platform/
│   └── screenCapture.js           # 全屏截图，共享宿主能力
└── plugins/
    ├── manualInput/               # 输入窗口、preload、IPC、菜单与提交策略
    ├── audioOutputPerception/
    │   ├── index.js
    │   ├── options.js
    │   ├── segmenter.js           # PCM 能量检测、分段与 WAV 编码
    │   ├── transcribe.js          # HTTP ASR 请求与返回处理
    │   ├── funasr.js              # WebSocket 2-pass 音频与结果处理
    │   └── capture/linux.js       # 输出监视源选择与 parec 采集
    ├── storageSqlite/             # 连接、事务与表结构迁移
    ├── dialogueHistory/           # 对话仓库、窗口、preload、菜单与事件记录
    ├── screenPerception/          # 视觉观察生成、采集周期与变化检测
    └── memory/
        ├── index.js               # 回合记录、上下文、菜单与窗口
        ├── maintenanceCoordinator.js # 维护、整理、清空屏障与任务生命周期
        ├── definition.js          # 配置、加载规则与服务依赖
        ├── options.js             # 插件配置默认值与校验
        ├── shortTerm.js           # 实例缓冲与快照压缩
        ├── context.js             # 近期对话格式化和记忆上下文块
        ├── longTerm.js            # SQLite 存储与检索
        └── extractor.js           # 长期事实提取
```

测试直接引用插件内的实现。全屏采集由宿主注入视觉插件，插件为自动截图指定临时目录，手动截图使用项目根目录的 `logs/screenshots/`。

## 上下文与通用服务

插件用 `context.decisionContext.register(provide)` 注册上下文提供者，返回 `{ id, title, text }[]`。核心对话在每次决策前收集内容块，将其作为 `context` 传给对话策略，块 ID 自动加上插件命名空间。上下文扩展失败时只记录日志，其它扩展和决策继续执行。核心不解释记忆类别、摘要策略或存储格式。

AI 对话请求的 `system` 仅包含角色设定、固定行为/记忆使用规则及输出格式，角色配置和可用表情列表不变时，各轮内容相同。长期记忆、近期对话及其它动态上下文统一放在 `user.content` 的「补充上下文」中，随后是「本次输入」的观察与图片；当前时间也在用户消息中。观察 role 的含义、缺失图片/音频的处理和 JSON 输出要求统一由系统提示词说明，本轮用户消息开头仅标记时间和输入数量。固定规则说明历史上下文属于背景数据，不作为当前用户指令。记忆整理的文本服务仍使用各自的固定整理提示词，待整理内容放在用户消息中。

`conversation/output.js` 集中定义主对话的六字段 JSON Schema、可用表情枚举和本地业务校验；系统提示词与请求 schema 使用相同表情列表。`ai.outputFormat=auto` 默认优先 strict json_schema，仅对明确“不支持 response_format/json_schema”等400/422错误协商到 json_object/prompt，协商结果保存在模型会话的策略实例中；显式模式不降级。主决策每次拿到完整响应后，先拒绝 refusal、content_filter 和 length，再严格解析整个 JSON 正文，验证字段完整性、类型、额外字段、表情名、发言状态及输入与摘要的一致性。普通文本、代码块、旧字段映射与类型强转兼容均移除。`AI_INVALID_OUTPUT` 最多重试3次，耗尽后标记不可回队重试；`AI_REFUSAL` 和 `AI_OUTPUT_TRUNCATED` 直接失败。校验通过后才提交核心历史并返回通用决策，失败不发布 `decision.completed`、不写入记忆或呈现回复，原始日志仍保存每次原响应供排查。

宿主注入 `context.model.generateText(messages, { max_tokens, temperature, signal, timeoutMs, retryBudgetMs })`，供记忆维护等扩展使用共享模型客户端。它与核心对话使用同一份 `conversation.ai` 设置，不依赖插件服务注册。`isAvailable()` 查询可用性，`getRevision()` 标识模型配置代次，`subscribe(listener)` 监听可用性与代次变化。宿主将插件停止信号合并到请求中，停止后禁止新请求，卸载时清理监听。

`conversation/index.js` 管理配置快照、在途请求及取消。对话配置变化时拒绝新请求、取消并等待旧请求，切换客户端与对话策略后通知扩展恢复；迟到结果不能成为新回合或记忆更新。停止取消所有请求，恢复使用当前配置；卸载后不能恢复。`conversation/decision.js` 负责提示词、图片和输出策略，`llm/client.js` 负责传输、代理、超时、重试与日志。

插件可以用 `context.services.subscribe(({ name, service }) => ...)` 监听服务注册与移除，返回清理函数；停止时暂停投递，卸载时解除监听。记忆协调器监听存储恢复和核心模型变化，取消旧代次任务，保留待处理队列，新模型可用后重试维护。

宿主统一追踪总线订阅、菜单、来源、上下文、服务、模型及服务变化监听的注册清理函数。激活失败会回滚已注册能力，卸载时也会清理残留注册项。

## SQLite 存储与历史插件

`storage-sqlite` 默认启用，使用 `better-sqlite3`；`path` 默认为 Electron `userData` 目录下的 `pet.sqlite3`，相对路径以 `userData` 为基准，绝对路径直接使用。数据库路径和服务选择在激活时确定，配置变化后自动重载存储及其必需依赖消费者。启用外键、WAL 和锁等待超时，数据库连接保持到依赖插件全部卸载后再执行检查点并关闭。

```json
{
  "plugins": [
    { "name": "manual-input", "enabled": true },
    { "name": "storage-sqlite", "enabled": true, "path": "pet.sqlite3", "busyTimeoutMs": 5000 },
    { "name": "dialogue-history", "enabled": true,
      "storageService": "storage-sqlite.database" }
  ]
}
```

核心提供 `context.paths`、`context.windows.create(options)` 和自动清理的 `context.ipc.handle(channel, handler)`。IPC 通道自动加上插件命名空间。历史窗口只通过自己的 preload 调用 `dialogue-history:list`，插件验证发送窗口身份；主进程不包含历史窗口、菜单或读取路由，宿主不再提供 `context.history`。

存储插件注册 `storage-sqlite.database`，提供同步的 `prepare`、`exec`、`transaction`和 `migrate`。事务回调必须同步。历史与记忆各自维护表结构和迁移版本：`sessions` 保存应用会话时间，`dialogue_turns` 保存用户文本、回复、表情、通用摘要、来源和决策 ID，`memory_entries` 保存事实、标签、重要性及提取批次的来源决策/会话 ID。来源 ID 表示提取时覆盖的回合集合，不代表模型已精确定位每条事实的出处；记忆插件可以独立于历史插件运行。

历史记录来自核心验证后的 `decision.completed`，与决策实现无关。事件携带统一的 `id`、`sessionId`、`sessionStartedAt` 和 `completedAt`。历史按时间和序号倒序分页，默认每页 100 条，窗口支持搜索用户输入和回复；搜索使用文字包含匹配。来源摘要保存在通用 `summaries` 中。

长期记忆使用标准化文本唯一索引去重，保留旧的相似文本检查及中文分词/评分规则；SQLite 不执行语义检索。每批提取结果的插入和超限清理在同一事务中完成。`memory.longTerm.maxEntries` 继续控制容量，`maxInject` 控制注入数量。历史插件和启用长期记忆的插件声明存储为必需依赖；缺少存储时被标记为不可用。仅使用近期记忆与摘要时可以关闭 `longTerm.enabled`，它们仍能运行；清空全部记忆需要可用的存储服务。

记忆和历史对话统一使用共享 SQLite，不再自动导入旧 JSONL。SQLite 表结构版本由各插件的 `migrate` 管理，已有数据库记录继续保留。

安装依赖时 `postinstall` 会执行 `npm run rebuild:native`，按已安装的 Electron 版本重建 `better-sqlite3`。`npm start` 前也会检查并重建原生模块。构建工具要求 Node.js >=22.12，pnpm 的原生构建许可位于 `pnpm-workspace.yaml`。仓库当前没有 Electron 分发打包流程；后续打包需要为目标平台/架构重建模块，并在使用 ASAR 时解包原生 `.node` 文件。

备份数据库应在关闭应用后进行，或使用 SQLite 备份机制；运行期间仅复制主数据库可能遗漏 WAL 中的记录。

## AI 超时与日志

共享模型客户端的 `conversation.ai.timeoutMs` 默认 120000，覆盖单次网络请求与响应正文读取；`conversation.ai.retryBudgetMs` 默认 360000，覆盖整轮请求和重试等待。外部取消与超时都向网络操作传递 AbortSignal，并终止等待。瞬时状态码 408、429、5xx 与网络故障可以重试；配置错误和不支持的观察类型不反复重试。

`logs/openai.jsonl` 达到 5 MiB 时轮转，最多保留 3 个历史文件。不会把请求头或 API key 写入日志。

共享模型客户端在每次网络发送前通过应用注入的回调通知 `ai.request.started`，在返回、失败或取消时通知 `ai.request.finished`，每次重试拥有独立请求 ID。`raw-log` 插件依赖 `storage-sqlite.database`，维护 `ai_requests` 表，保存实际序列化的请求正文（包括所有 messages 和图片）、返回内容、时间及 HTTP 状态。日志观察者的失败不会阻断模型请求；停止期间仍接收完成通知，防止丢失取消结果。上次进程遗留的未完成记录在激活时标记为结果未记录。

「原始日志…」窗口按运行会话分组并倒序分页，每页 50 次请求；列表只读取元数据及从 response_json 提取的小型 usage 对象，选中时才读取完整正文，按消息原始顺序展示角色、文本、图片和模型返回。窗口每 2 秒刷新列表，关闭后停止轮询。`rawLog/usage.js` 统一 Chat Completions 与 Responses 用量字段，展示输入、输出、总量、缓存命中、未命中、可选缓存写入和推理 token；未命中优先使用接口显式字段，否则用已知输入减已知命中计算。缺失和异常字段保持未知，缓存写入与推理不重复计入总量。列表与详情均读取已保存响应，不更改原始数据、不新增数据库列，兼容历史记录与字符串形式的失败响应。使用隔离的 sandbox preload 和自身发送者校验，只允许 `raw-log:list/get` IPC；文本通过 textContent 展示，图片仅加载内联 data URL，远程图片显示原始 URL。功能默认启用，可通过插件 `raw-log.enabled=false` 关闭；记录持久保存，不复用历史响应 JSONL，也不记录请求头或 API key。

## 配置管理

`config.js` 缓存不可变的有效配置，验证根字段、插件名称、重复项和公共启用开关，将对话参数委托给 `conversation/options.js`，将插件参数委托给各插件的 `definition.js`。默认值由插件的 `options.js` 定义，配置读取与运行时使用同一套标准化规则；不可变配置的运行时选项视图按实例缓存，原始可变配置仍可独立读取。配置写入中或格式错误时保留上次有效配置，只记录错误位置与类型，不打印配置内容。初次加载无有效配置时明确报错。只接受 `ui`、`conversation`、`decision`、`observations` 和 `plugins` 根字段（以及下划线开头的注释）；根节点功能配置和记忆插件平铺参数会明确报错。

应用监听配置文件所在目录，合并连续保存事件；有效更新交给宿主串行重载变化的插件及其必需依赖消费者，旧实例使用原配置完成清理。对话配置变化时先暂停并等待调度器，取消旧模型请求，再切换对话核心；插件只因自身配置或必需依赖变化而重载。仅切换模型和角色不会重建记忆与历史。观察配额和调度间隔在后续读取时生效，主窗口尺寸在创建时生效。视觉插件始终加载，开关控制自动截图；音频插件配置存在时加载，开关控制采集；其它插件保留原有加载规则。当前配置格式见 `config.example.json`。

## TTS 任务与取消

默认 `interruptOnNewChat=true`，新语音请求取消旧任务，只播放当前任务的结果；设为 `false` 时，语音请求按到达顺序串行合成和播放。显式停止事件仍会取消全部待处理语音，例如核心在开始决策时发出的停止事件。

右键菜单关闭 TTS、停止插件或卸载插件都会使旧任务失效。重新开启不会恢复已取消的语音；插件停止后再启动保留本次运行的菜单开关。系统合成进程和 GPT-SoVITS 网络请求接收取消信号，取消不触发系统合成的备用命令。播放器和合成器每个任务使用独立临时文件，仅在自身任务结束后清理，失败和取消也会删除未完成的文件。

每次实际播放会发布 `start` 和对应的 `end` 或 `error`，被打断的播放也会结束状态通知。子进程先请求正常终止，1 秒后仍未退出则强制终止；停止 Promise 等待任务和文件清理结束。

手动记忆整理的完成、空记忆及失败通知发布 `execution.bubble.requested`，执行模块直接发送文字气泡，不产生决策完成事件或语音请求，因此不会把通知写入对话与记忆提取。停止、清空和任务代次变化后不展示迟到通知。

记忆窗口的人物画像页不展示待提问队列和最近观察列表，只展示画像、修正、信息来源及整理历史。提问记录页将 `work.questions` 中尚未产生历史的 pending 候选与 `questionHistory` 按问题 ID 去重后展示，pending 优先；不伪造展示事件，原有历史接口语义保持兼容。画像信息来源继续使用对应的原始用户输入、回答、修正、画面摘要或音频转写，后台观察证据仍保留。

## 人物画像与提问

`memory.work.enabled=true` 启用工作记忆，并声明 SQLite 为必需依赖。`workStore.js` 维护 `work_evidence`、`work_entities`、`work_claims`、`work_questions`、`work_question_answers` 与 `work_memory_state`，迁移命名空间为 `work-memory`。证据保存原始文字或截图工作摘要、来源、采集时间与元数据；图片文件仍按现有观察释放策略清理。被画像引用的证据不参加普通容量清理。

`workMemory.js` 订阅观察入队及决策完成：文字观察直接保存，不依赖宠物发言；截图优先使用独立 `workSummary`，旧提供者退回 `screenSummary`。整理读取来源证据与旧画像，不把宠物台词当作事实。`workExtractor.js` 返回实体、画像关系和问题候选；忽略旧提供者返回的 summary 字段，兼容旧提供者返回的 facts，但不直接把它们写入长期记忆。画像主要记录用户的身份、稳定职责、习惯、偏好、沟通方式与人际关系；具体工作、任务、项目和技术细节按原始来源通过 `updateBuffer.stageEvidence` 暂存，到20轮对话门槛后统一评估是否更新长期记忆。启动时将已有画像中不属于人物信息的记录迁入长期记忆，保留来源、证据和用户确认依据，并在画像整理历史中归档原记录。更新在事务中完成，证据 ID 必须属于本批；无效 JSON、无效字段或伪造证据会保留整批待处理状态。维护由记忆协调器统一执行串行快照、取消与代次检查，不能在清空后重建旧画像。

关系按实体、字段、范围保存当前版本和被替代版本。`user_answer` 高于自动观察及猜测；用户可以在「人物画像」页修正已有关系，写入新的明确证据并关闭同一字段的待提问。名字和实体类型形成稳定键，别名保留为检索线索，不仅凭名字自动合并不同实体。检索使用当前转写、用户输入和最近工作摘要，用户画像作为核心背景保留，其他人物需要文字相关性命中。

`memory.work` 服务提供快照、问题读取、回答、画像修正和注意力信息；`questions` 插件以它为必需依赖。提问按人物、字段、范围去重，优先级排序；队列、回答、每日次数与冷却写入数据库。自动窗口等待系统闲置、决策结束、TTS 结束以及最近音频／会议线索失效，使用 `showInactive`；默认 `dailyLimit=0`、`cooldownMs=0`，关闭每日上限与全局提问间隔，正数可以恢复限制。手动菜单可绕过自动时机与每日限制。选择或自由回答直接更新关系，不清楚与跳过不提升确认程度，重复跳过会停止询问，单题延后默认 30 分钟且不增加跳过次数。忙碌条件仅阻止新窗口出现，后台决策、TTS 与新观察不关闭已显示的问题。自动窗口未操作时 90 秒超时；获得焦点或通过受窗口身份校验的 activity IPC 检测到点击、键盘、输入等操作后取消超时，手动打开不设超时。关闭和未操作超时按延后处理；清空直接关闭窗口，迟到 IPC 被拒绝。

`work_question_answers` 同时保存 `shown`、`answer`、`unknown`、`skip` 和 `defer` 事件；展示事件与每日计数更新处于同一事务。工作快照的 `questionHistory` 按问题关联完整事件，排除尚未展示且没有处理记录的候选。记忆窗口的提问记录页支持文字搜索、状态筛选、删除单条答案以及删除问题和全部关联记录；删除记录保留已确认的人物画像。删除 IPC 校验请求来自记忆窗口。菜单通过 `viewTab` 与 `memory:select-tab` 打开或切换到该页，复用已有窗口。旧数据保留最后展示时间与既有回答，缺失的历史展示事件不伪造。

手动「记忆 → 整理」一次发送长期事实和启用的当前人物画像，使用 `max_tokens=16384`、单次超时 300000ms、重试总预算 605000ms。画像计划的 `workProfiles.merge` 引用同一对象及字段的来源关系并指定一个现有范围；`workProfiles.archive` 标记无价值或明确失效的关系。`profileOrganizer.js` 校验引用、范围、用户确认和观察依据，`workStore.organize` 校验当前画像与请求快照一致。合并保留最强来源依据、原有置信度、全部证据 ID 及最新来源时间，旧关系标记 superseded，归档关系标记 archived；原始内容与原因保存在 `work_profile_organization_history`（work-memory 迁移版本 2）。长期事实和画像整理在共享 SQLite 的同一外层事务中提交，提交后才通知画像更新；任一失败整体回滚。画像整理历史随快照提供给查看窗口，清空全部记忆时一并删除。

提问窗口的「移除该问题」通过现有受窗口身份校验的 answer IPC 发送 `action=remove`。存储在同一事务中删除该问题和关联的 `work_question_answers`，不新增处理事件、答案证据或画像关系，不改变已有展示次数和冷却统计；成功后关闭窗口，失败时回滚并保留窗口供重试。

宿主新增通用 `attention.getIdleSeconds()`，生产环境来自 Electron `powerMonitor.getSystemIdleTime()`。会议判断仅采用音频活动与文字线索，不进行说话人身份识别。所有提问和修正 IPC 仅接受本插件窗口的请求，preload 使用隔离与 sandbox，文本用 `textContent` 显示。

AI 输出新增 `workSummary` 与 `shouldSpeak`。纯观察可返回 `shouldSpeak=false`，转换成通用决策 `speak:false`；核心允许显式静默决策，呈现模块隐藏思考气泡并跳过 TTS，记忆仍记录观察摘要。未显式静默的空回复继续视为无效，直接用户输入不能被 AI 的静默标记跳过。

## 记忆插件

插件挂载「记忆 → 清空全部记忆」，菜单操作先显示确认弹窗，默认选择取消；确认后才清空。重复点击共享同一弹窗，插件停止时取消确认，迟到的确认结果不会清空恢复后的记忆。另注册 `memory.clear` 服务供程序调用。清空会增加任务代次、取消后台维护、清除近期对话与待更新缓冲及长期事实。清空前已开始的决策完成后不再写入记忆；清空期间的维护结果不会重新落库。操作不删除历史对话。重复清空共享同一个 Promise；存储不可用时菜单禁用，调用服务会明确报错。

记忆插件通过 `decision.completed` 记录经过验证的成功回合，保存用户文本、回复、表情和通用来源摘要。回合记录同步完成，后台维护不阻塞回复；对话核心不调用记忆记录或维护方法。决策流程明确先等待 `decision.completed` 的记录通知，再调用 `execution.presentDecision`，最后释放观察资源；呈现模块不订阅决策完成事件，顺序不依赖插件激活或重载时的注册位置。

`maintenanceCoordinator.js` 统一管理维护任务、手动整理和清空屏障，以及运行状态、取消信号、任务代次和停止等待；插件入口负责来源与回合记录、上下文查询、菜单及查看窗口。维护任务按回合快照串行执行。近期对话受 `shortTerm.maxTurns` 和 `shortTerm.ttlMs` 限制；长期记忆更新使用独立的持久队列 `memory_update_turns` 和 `memory_update_sources`（迁移命名空间 `memory-updates`，版本1），不受近期容量或时限影响。只有非静默成功对话推进20轮门槛，观察来源本身不增加轮数。`updater.js` 一次发送全部现有长期记忆、本批完整对话及暂存来源，返回 update/add 计划；更新保持原ID，新增重要性至少4，每项必须引用本批真实来源。`longTerm.updateFromDialogue` 检查快照、重复记录与容量，保留原确认依据、来源和更新时间，旧内容写入整理历史；更新和队列消费在同一外层事务内提交，不通过容量清理淘汰已有记忆。长期更新成功仅消费请求快照中的内容，新到回合保留。更新失败时原始内容保留，新观察、新回合、服务恢复、启动或每30秒的维护检查会再尝试；上下文读取不触发模型请求。核心模型不可用时，近期记忆和已有长期记忆检索仍可用。没有存储时先保存在进程内，服务恢复后迁入 SQLite。

短期记忆属于插件实例的进程内状态；待更新完整对话与观察来源保存到共享 SQLite，重启后继续累积。长期记忆保存到共享 SQLite 数据库。停止会取消后台请求并暂停记录/上下文注入，恢复后继续使用本次进程的会话状态。卸载会解除注册并清空实例会话状态，忽略迟到的模型结果，数据库保留。

「记忆 → 查看当前记忆…」打开插件自己的查看窗口，展示近期对话、全部长期事实与启用/整理状态，点击刷新重新读取。长期记忆查看不受检索注入数量限制，也不会触发模型请求或删除记录；子项关闭时仍可查看已保留内容。窗口通过 `memory:snapshot` IPC 读取快照，只接受自身窗口请求，停止时关闭，卸载时清理 IPC。

```json
{
  "name": "memory",
  "enabled": true,
  "shortTerm": {
    "enabled": true,
    "maxTurns": 8,
    "ttlMs": 1800000
  },
  "storageService": "storage-sqlite.database",
  "longTerm": {
    "enabled": true,
    "maxInject": 5,
    "extractEveryNTurns": 20,
    "maxTokens": 16384,
    "maxEntries": 500
  }
}
```

统一插件配置的 `enabled=false` 关闭插件提供的记忆。各子项可以独立关闭；关闭近期对话注入时，长期记忆更新仍使用独立的完整回合队列。近期和长期记忆参数分别放在插件的 `shortTerm`、`longTerm` 中，未配置 memory 插件时不启用插件记忆；核心的多轮对话与会话压缩由 `conversation.history` 独立管理。旧的 `memory.summary` 配置仍不接受，`work-memory` 版本3迁移清理 `work_memory_state.sessionSummary`，新会话摘要只保存在核心进程内。

## 配置格式

新配置见 `config.example.json`：

```json
{
  "conversation": {
    "enabled": true,
    "ai": {
      "endpoint": "https://api.example/v1",
      "apiKey": "...",
      "model": "..."
    },
    "character": {
      "name": "Setsuna"
    }
  },
  "decision": {
    "enabled": true,
    "interval_ms": 10000
  },
  "plugins": [
    {
      "name": "screen-perception",
      "enabled": true,
      "interval_ms": 5000,
      "changeDetect": {
        "enabled": true,
        "hashSize": 8,
        "threshold": 4
      }
    }
  ]
}
```

`decision.interval_ms` 控制每次决策结束后等待多久；0 时至少等待 1 秒，负数或 `decision.enabled=false` 时关闭自动决策，仍可手动触发。视觉采集周期独立配置，设备音频也独立采集。

模型与角色配置从根节点 `conversation.ai`、`conversation.character` 读取；感知、记忆和输出配置从对应 `plugins` 项读取。配置只接受当前格式，不转换旧插件或旧字段。`ai-conversation` 不在插件清单中，`decision.provider`、`memory.textService`、`memory.summary`、`memory.longTerm.legacyPath` 和历史插件的 `legacyPath` 以及其它旧根节点功能配置和记忆平铺字段会明确报错；未注册的插件也会报错。记忆和历史仅使用 SQLite，不提供旧 JSONL 导入入口。

手动对话插件在桌宠右键菜单挂载「手动对话…」，打开桌宠附近的输入窗口，Ctrl+Enter 发送，Esc 关闭，单条最多 4000 字。内容以 `role=user` 的文本观察入队，提交成功即关闭窗口，后台请求决策；当前决策忙碌时等待下一轮。记忆与历史插件独立记录决策完成事件，手动对话插件不直接调用它们。窗口、preload 和提交逻辑均位于 `electron/plugins/manualInput/`，主进程只提供通用宿主接口与调度。

## 设备音频感知

首版支持 Linux 上的 PulseAudio 或提供 PulseAudio 兼容服务的 PipeWire，依赖 `pactl` 和 `parec`（通常包含在 `pulseaudio-utils` 包中）。Windows/macOS 的采集适配器尚未实现，菜单中会显示暂不支持。

在 `config.json` 的 `plugins` 数组中配置 `name=audio-output-perception`（字段示例见 `config.example.json`）。音频配置使用插件项，旧根节点 `perception.audioOutput` 不再支持。`asr.provider` 支持 `funasr`、`whisper-asr-webservice` 和 `openai`（省略时沿用 `openai`，示例配置显式选用 `funasr`）。HTTP ASR 使用独立 Electron session；FunASR 使用独立 WebSocket 与可选 HTTP(S) 代理 URL，不改变聊天的代理。

### 本地 FunASR 2-pass

`compose.asr.yaml` 启动官方 `funasr-runtime-sdk-online-cpu-0.1.13` 服务，在 `ws://127.0.0.1:10096` 提供中文 Paraformer 在线与离线协同识别。首次启动下载模型并保存到 `mylive2dpet-funasr-models` 卷；容器健康检查检测服务监听端口。部署和完整配置见根目录 README。

`segmenter.js` 在语音能量累计达到 `minSpeechMs` 后通过 `onStart/onAudio` 回调开始发送音频，包含预录音及已累计音频，后续每帧继续发送；不会等到段尾才上传。`funasr.js` 每个本地片段建立独立连接，先发送 `mode=2pass`、`wav_format=pcm`、`audio_fs=16000`、`chunk_size`、`chunk_interval` 等 JSON 配置，再按固定块大小发送二进制 PCM。默认 `[5,10,5]`、间隔 10 对应 60ms 传输块和 600ms 在线解码窗口。

`2pass-online` 是增量文字，仅更新带片段 ID 的临时字幕；`2pass-offline` 替换该句在线内容，多个服务端 VAD 句子的修正结果累计保留。本地静音或最长片段结束后发送 `is_speaking=false`、`is_end=true`；收到段尾最终标记后汇总离线文字，通过共享观察入队逻辑提交一次，字幕同条替换为最终文字。在线消息即使带 `is_final=true` 也不会成为观察。`language` 是结果标签，模型由服务端选择。

最多并行 3 个连接（包括等待最终结果），满时取消最旧片段；音频缓存与发送积压受最长片段大小限制。连接和最终结果各有 `timeoutMs` 超时，单段失败后下一段重新连接。停止监听、采集异常、TTS 开始都会取消连接并清除临时字幕，旧连接不能污染新会话。

### 本地 Whisper 容器

仓库根目录的 `compose.whisper.yaml` 使用已有的 `onerahmet/openai-whisper-asr-webservice:latest` CPU 镜像，配置 `faster_whisper`、`small`、CPU `int8`，在 `127.0.0.1:9000` 提供服务。镜像拉取策略为 `never`，首次启动仍需下载模型，模型保存在持久化卷 `mylive2dpet-whisper-cache` 中；后续重启会复用缓存。`/openapi.json` 健康检查可用后才表示模型加载完成。

当前网络无法直连 Hugging Face，Compose 默认通过 `https://hf-mirror.com` 下载公开模型，并禁用 Xet 下载方式。若所在网络可直连官方站点，可在启动命令前设置 `WHISPER_HF_ENDPOINT=https://huggingface.co`。此地址只用于模型下载，音频转写仍在本地容器中完成。

```sh
docker compose -f compose.whisper.yaml up -d
docker compose -f compose.whisper.yaml logs -f
docker compose -f compose.whisper.yaml ps
```

应用配置：

```json
"asr": {
  "provider": "whisper-asr-webservice",
  "endpoint": "http://127.0.0.1:9000",
  "language": "zh",
  "vadFilter": true,
  "timeoutMs": 60000
}
```

该 provider 使用 multipart `POST /asr`，音频字段为 `audio_file`，通过查询参数设置 `task=transcribe`、`output=json`、`encode=true`、`language` 和 `vad_filter`。支持 API 基址或完整 `/asr` 地址。`encode=true` 保证上传的 WAV 容器经过 FFmpeg 解码；`vadFilter` 默认开启，仅适用于容器的 `faster_whisper` 引擎。语言留空会自动识别。容器不需要 API 密钥，模型由 Compose 中的 `ASR_MODEL` 选择，不在每次请求里传 `model`。修改模型后运行 `up -d` 重建服务。若要使用 GPU，需要另备 `latest-gpu` 镜像、配置 GPU 访问并修改 `ASR_DEVICE`；现有 `latest` CPU 镜像不自动使用显卡。

停止服务使用 `docker compose -f compose.whisper.yaml stop`；删除容器和网络使用 `down`，模型缓存卷会保留。

### 兼容 OpenAI 的转写服务

使用 `asr.provider=openai`，填写 `endpoint`、`model` 和服务所需的 `apiKey`。服务必须支持 multipart `POST /audio/transcriptions`，接受 WAV、`model`、`response_format=json`，返回带 `text` 的 JSON。endpoint 可以是 API 基址或完整转写地址。聊天接口支持图片并不代表它也支持转写。

### 感知与决策

示例中 `plugins[name=audio-output-perception].enabled` 默认 `true`，随应用启动采集；TTS 默认关闭。配置完成后也可在托盘或桌宠右键菜单中勾选「感知设备播放的语音」，菜单开关仅影响本次运行。音频与截图开关独立，关闭截图不影响音频。转写结果等待`decision.interval_ms` 决策周期；手动决策也可消费音频观察。

`source=default` 选择启动采集时默认输出设备的监视源；也可以用 `pactl --format=json list sources` 查看并指定某个 `.monitor` 名称。代码会验证输出监视源，不会退回麦克风。切换输出设备后，关闭再打开菜单开关以重新选择默认输出。采集进程失败后每 5 秒尝试重新连接；FunASR 单段识别失败后，在下一段语音开始时重新连接。

采集规格为 16kHz 单声道 PCM16。20ms 一帧，默认高于 -40dB 的音频累计至少 400ms 才接受，静音 800ms 后结束一段，最长 15 秒。该检测基于能量，不能可靠区分语音、音乐和音效；ASR 可能对背景音乐误识别。可通过提高 `speechThresholdDb` 降低敏感度，首版主要用于视频、播客和通话中的语音内容。

TTS 插件发布带播放 ID 的通用 `execution.speech.state`。桌宠语音开始时丢弃尚未完成的片段，播放期间丢弃采集数据，最后一个播放结束后额外抑制 `ttsCooldownMs`（默认 600ms），避免识别自身输出。这段时间其他应用的语音也会被跳过。

原始音频只在内存中分段并发送给配置的 ASR，不创建录音文件、不写入日志。等待转写的片段最多 3 段，待决策音频队列最多保留最近 20 条，音频观察 60 秒后过期，相同转写在 15 秒内去重。关闭采集会中止转写、清空待处理音频并停止 `parec`。菜单的「实时显示内容 → 开启」会在主屏工作区右上角打开置顶小窗口，显示监听状态、错误和最近 20 条转写文字。FunASR 流式文字持续更新同一条字幕，段尾替换成最终修正文字；HTTP provider 在整段转写完成后更新。重复文字也会显示，不受观察队列去重影响；关闭显示只关闭窗口，停止采集会关闭窗口并清空显示缓存。实时显示开关仅影响本次运行。模型生成的 `audioSummary` 与已有 `screenSummary` 一起保留在短期记忆及对话历史中，并标注为外部播放内容。

转写通过过滤和去重并入队后，音频插件会打印 `[plugin:audio-output-perception] transcript: 识别出的语音文本`，可在启动桌宠的终端日志中查看。

运行 `npm run test:audio` 检查分段、转写请求、TTS 抑制、停止与重启、队列边界和混合决策行为。

运行 `npm test` 检查全部音频与插件链路测试，包括通用观察、核心对话与模型生命周期、配置切换、失败重入队、纯文字/混合输入、视觉定时器与停止清理、当前配置校验和菜单卸载，以及记忆实例隔离、回合快照、维护串行化、模型服务缺失/恢复、请求取消和已有持久记忆可用性。测试使用模拟设备与模型服务，不调用真实模型或打开桌面窗口。

### 项目状态与经验记忆

`memory.practice` 使用 `practiceMemory.js` 管理采集、到期与更新，`practicePlanner.js` 校验模型计划和来源，`practiceStore.js` 管理独立 SQLite 表、来源队列、版本历史与上下文检索。直接用户输入、音频转写和有截图关联的观察摘要作为来源；不会保存宠物回答作为验证证据。来源达到数量或等待时间门槛后，在现有串行维护任务中执行，原有长期更新的20轮门槛不影响该任务。

项目与经验 ID、范围、来源引用及验证摘录在写入前检查，旧来源不能覆盖更近的状态。来源队列消费与条目／历史保存同一事务提交，请求期间到达的新来源不被消费。手动整理通过 `organizer.js` 在原有请求中携带实践记忆和待处理来源，返回的 `practice` 计划与长期事实／人物画像统一提交；会话停止、清空或开关变化拦截迟到结果。

`provideContext` 添加 `project-state` 与 `experience-memory` 上下文块，标记项目来源时间和未验证经验。查看窗口新增项目与经验页，可读原始来源和更新前版本；旧用户数据不做推测迁移，开启后从新的来源开始积累。
