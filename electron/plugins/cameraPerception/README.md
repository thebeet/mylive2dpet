# 摄像头感知插件

`camera-perception` 使用摄像头采集 JPEG 画面，以 `source: "camera"` 提交图片到共享观察队列，等待正常决策周期。需要摄像头、系统摄像头权限、Storage 和支持图片输入的核心模型。不采集麦克风。

在 `config.json` 的 `plugins` 数组加入：

```json
{
  "name": "camera-perception",
  "enabled": true,
  "deviceId": "",
  "interval_ms": 5000,
  "width": 640,
  "height": 480,
  "changeDetect": { "enabled": true, "hashSize": 8, "threshold": 4 },
  "observationTtlMs": 60000,
  "maxPendingObservations": 6
}
```

启用后在后台采集配置设备的第一帧，之后每隔 `interval_ms` 采集一次，不自动弹出预览。`interval_ms: 0` 只采集第一帧。采集中的请求按设备合并，不积压。图片按比例缩放到 `width` / `height` 以内；观察超时后由共享队列淘汰，超过来源配额时替换最旧画面。

菜单「摄像头感知」列出 Chromium 枚举出的全部视频输入设备，并随设备插拔更新。正在感知的设备显示 `●`，排列在最前面。点击设备打开预览，窗口内用「开启感知／关闭感知」切换该设备的采集状态；可同时开启多个设备。关闭预览只隐藏窗口，不改变开关状态，后台继续采集。存在开启设备时，菜单最后提供「关闭所有」，统一停止采集、释放设备并清除对应待处理观察。

与桌面截图使用相同的 dHash 变化检测，每个设备独立维护比较基准：首帧保存并入队，后续与上一次采集的画面比较，仅当哈希距离严格大于 `changeDetect.threshold`（默认 4）时保存并入队；变化较小时跳过保存和入队，仍更新比较基准。`hashSize` 默认 8，阈值越大越不容易入队；`changeDetect.enabled: false` 可关闭过滤。重新开启摄像头或清理原始日志后重置比较基准，下一帧重新入队。

`deviceId` 为空使用默认摄像头，也可填 Chromium `enumerateDevices()` 返回的设备 ID；指定设备不可用时报告错误。预览窗口显示连接、采集和权限错误。连接或单帧采集超过 15 秒会报告超时。

Linux 可用 `devicePath` 指定 `/dev/videoN`，与 `deviceId` 二选一。插件读取 sysfs 设备名称，再匹配 Chromium 视频设备；设备不可用或名称存在多个匹配时报告错误，不回退到默认摄像头。`label` 用于配置设备的菜单、预览、观察和图片元数据，其他设备使用自身名称。例如手机投屏设备：

```json
{
  "name": "camera-perception",
  "enabled": true,
  "devicePath": "/dev/video10",
  "label": "手机屏幕",
  "interval_ms": 5000,
  "width": 1080,
  "height": 1080
}
```

`enabled: false` 只枚举设备，不启动采集，仍可在预览中开启设备。本次运行的设备开关不修改配置文件。关闭感知、停止或卸载插件会释放设备并清除对应待处理观察；关闭预览不停止采集。未配置此插件时不加载，也不访问摄像头。设备枚举不调用 `getUserMedia`，只有开启感知才请求视频流，不请求麦克风。

JPEG 与来源、时间、尺寸和设备名称保存在 Storage 的 `screenshots` 命名空间，与桌面截图一样可通过原始日志插件查看、清理。观察释放后保留原图；日志清理期间尚未完成的采集不会重新保存旧画面。

返回 [项目概览](../../../README.md)。
