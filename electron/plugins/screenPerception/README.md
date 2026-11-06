# 视觉感知插件

`screen-perception` 定时全屏截图、检测画面变化，并提交图片观察；同时提供手动保存截图。依赖 Storage 和支持图片输入的核心模型。

## 配置

在根配置的 `plugins` 数组中添加或修改对应条目。以下为配置示例：

```json
{
  "name": "screen-perception",
  "enabled": true,
  "interval_ms": 5000,
  "changeDetect": {
    "enabled": true,
    "hashSize": 8,
    "threshold": 4
  },
  "observationTtlMs": 60000
}
```

`enabled=false` 仅关闭自动采集，手动截图仍可用。`interval_ms` 是自动截图周期；`observationTtlMs` 是图片观察有效期。`changeDetect.enabled` 控制变化检测，`hashSize` 是哈希尺寸，`threshold` 是变化阈值。

## 采集与摘要

自动截图首帧保存，之后哈希距离严格大于 `changeDetect.threshold` 才保存并入队；未超过阈值时只更新检测基准。手动保存跳过变化检测，保存截图但不入队。

截图通过核心 Storage 的 `screenshots` 二进制命名空间保存 JPEG 原图及采集信息，不生成临时 JPG。观察释放、过期或插件重载不会删除已保存截图。

通过 `systemPrompt.register()` 声明图片观察所需的 `summaries.screen` 和 `summaries.work`，订阅 `decision.completed` 将模型摘要关联到截图。多图分析记录整批摘要范围。

截图作为外部观察等待正常决策，入队不会立即让桌宠发言；画面不变也不会阻止已有音频或用户文字参与决策。截图查看与清理由 [原始日志插件](../rawLog/README.md) 提供。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
