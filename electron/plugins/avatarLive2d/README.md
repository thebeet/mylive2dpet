# Live2D 形象插件

`avatar-live2d` 支持 Live2D Cubism 4 的 `.model3.json` 模型和配套 moc3、纹理、动作、表情资源，默认启用。

## 配置

在根配置的 `plugins` 数组中添加或修改对应条目。以下为配置示例：

```json
{
  "name": "avatar-live2d",
  "enabled": true,
  "modelPath": "assets/live2d/model.model3.json",
  "iconPath": "assets/live2d/icon.png",
  "scale": 1.5,
  "verticalOffset": 50,
  "defaultExpression": "neutral",
  "idleMotion": null,
  "clickMotion": null
}
```

`modelPath` 和非空 `iconPath` 必须是项目 `assets/` 下的相对路径，资源包目录结构须完整保留。`scale` 控制大小，`verticalOffset` 控制垂直偏移（CSS 像素，正值向下）。`defaultExpression`、非空 `idleMotion` 和 `clickMotion` 必须对应模型实际定义；动作设为 `null` 可关闭。

## 使用与切换

右键菜单可播放模型动作或切换表情，视线跟随使用指针坐标。Cubism Core 位于 `public/live2dcubismcore.min.js`，加载本插件时按需导入。

同时只能启用一个形象插件。切换到 [3D 插件](../avatar3d/README.md) 时在同一次保存中关闭本插件并开启 `avatar-3d`。模型资源自行准备并遵守资源包授权。宿主契约和生命周期见 [形象共用文档](../avatarShared/README.md)。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
