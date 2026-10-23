# 主进程消息流

对话处理在 Electron 主进程内通过 `MessageBus` 传递事件，各模块只依赖总线和消息数据，不直接调用下游模块。

```text
每 perception.interval_ms
  → perception.capture.requested
  → 感知：截图并入 perception.observation 队列

每 chat.interval_ms 或手动触发
  → decision.requested
  → 决策：取出所有待处理观察并调用视觉模型
  → decision.completed
  → 执行：展示台词并播放语音
```

- 感知模块按 `perception.interval_ms` 采集截图，使用 `chat.changeDetect` 中的 dHash 与上一张比较；汉明距离未超过阈值时跳过入队。变化足够大时，将截图路径、类型、变化距离和拍摄时间加入总线队列。新增摄像头、窗口、音频等输入时，可扩展观察数据。
- 决策请求会一次取出队列中所有待处理观察并一起交给视觉模型。队列为空时跳过决策；模型调用失败时，这批观察会放回队首等待重试。
- `chat.interval_ms` 控制自动决策频率，`perception.interval_ms` 独立控制截图采集频率。手动触发同样只消费已经入队的观察。
- 执行模块订阅决策结果。说话和 TTS 是当前执行器，后续可增加表情、动作或其它执行器。
- `pipeline.failed` 和 `perception.observation.queued` 用于传递失败及队列状态。

`MessageBus` 同时提供顺序事件分发和 FIFO 队列。耗时语音合成由执行模块异步启动，不阻塞台词展示。
