# 定时通知插件

`schedule` 提供单次定时通知，支持菜单创建、模型 effect 创建、查看和取消。默认加载，依赖 Storage。

## 使用与恢复

`schedule` 插件默认启用，依赖核心 Storage。通过桌宠右键菜单「定时通知…」选择本机时区的未来时间、填写内容，可查看记录和取消待提交通知。第一版支持单次通知，任务写入 `schedule.tasks` 集合，关闭窗口不影响计时；停止、禁用或重载插件保留任务。应用关闭或休眠期间无法准时提交，尚未入队的过期通知在恢复运行后补发，休眠恢复或系统时钟变化最多约 30 秒内校准。

到期只调用 `perception.submit()`，生成 `source=schedule`、`role=context`、`trigger=scheduled` 的文字观察，包含任务 ID、原定时间、通知内容和延迟信息。不主动请求决策，不直接显示气泡或播放语音。通知等待下一次正常决策；关闭自动决策时不会因通知入队而主动处理。记录中的「已提交」仅表示观察已经入队，后续遵循共享队列的容量与淘汰规则，不代表桌宠已回复。

## 配置

可在 `plugins` 中配置：

```json
{
  "name": "schedule",
  "enabled": true,
  "observationTtlMs": 0,
  "maxRetries": 2,
  "retryDelayMs": 30000
}
```

`observationTtlMs=0` 不设置观察过期时间；正数从实际入队时计算。提交失败默认每 30 秒重试，首次提交之外最多重试 2 次，耗尽后记录失败原因；可重新创建通知。已提交记录不会在重启后重放，共享观察队列仍是进程内队列。若进程在提交与状态保存之间崩溃，中断的任务会在启动后重试，可能重复，不能保证跨崩溃恰好一次。

## 插件服务与模型 effects

其他插件可声明依赖 `schedule.tasks` 并读取 `context.services.get("schedule.tasks")`，调用 `create({ text, scheduledAt })`、`list()` 和 `cancel(id)`。`scheduledAt` 接受毫秒时间戳或带时区的 ISO 时间。

`schedule` 在加载时注册系统提示词和 effect Schema，模型可在决策结果中返回以下副作用以新增通知：

```json
{
  "effects": [
    {
      "type": "schedule.create",
      "text": "提醒我开会",
      "scheduledAt": "2026-11-05T09:00:00+08:00"
    }
  ]
}
```

示例时间仅用于说明格式。模型根据本轮当前时间解析明确的未来通知请求；插件订阅 `decision.completed`，只处理 `schedule.create`，校验未来时间、时区和文字长度后保存，决策 ID 与 effect 序号用于持久化去重。未知 effect 忽略，非法定时 effect 逐项记录错误并继续处理后续项。静默回合也会处理 effects，提示词明确禁止重放历史 effect 或因到期通知再次创建同一任务。暂不支持周期通知或通过 effect 修改、取消通知。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
