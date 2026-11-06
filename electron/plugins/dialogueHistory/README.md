# 历史对话插件

`dialogue-history` 保存已完成决策的用户文字、桌宠回复及观察摘要，提供分页与文字搜索窗口。默认加载，依赖 Storage。

## 配置

在根配置的 `plugins` 数组中添加或修改对应条目。以下为配置示例：

```json
{
  "name": "dialogue-history",
  "enabled": true,
  "storageService": "storage"
}
```

`storageService` 默认使用 `storage`，消费者通过核心业务仓库访问存储。

## 查看与记录

通过右键或托盘菜单「历史对话」打开窗口，分页浏览或搜索文字。插件订阅 `decision.completed` 记录成功回合；模型请求失败不会写入历史。

历史对话持久保存在共享 SQLite 中，与核心进程内会话历史及记忆插件分别管理。清空记忆和清理原始日志都保留历史对话。停止或重载插件会关闭其窗口，已保存数据保留。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
