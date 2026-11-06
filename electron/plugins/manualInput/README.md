# 手动输入插件

`manual-input` 提供右键输入窗口，将用户文字提交到核心观察队列并主动请求决策。默认加载，无必需插件服务依赖。

## 配置

```json
{ "name": "manual-input", "enabled": true }
```

## 使用与消息流

右键桌宠或打开托盘菜单，选择「手动对话…」。Ctrl/Cmd+Enter 发送，Esc 关闭，单条最多 4000 个字符。

输入以 `role=user` 的文字观察通过 `perception.submit()` 入队，成功后关闭窗口并后台调用 `decisions.request()`；当前决策忙碌时等待下一轮。容量不足或提交失败时保留输入供重试。手动输入不直接调用记忆和历史插件，记录由 `decision.completed` 的订阅者完成。

输入窗口、preload 和提交逻辑都位于本插件目录；配置重载会关闭插件窗口并取消待决策请求。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
