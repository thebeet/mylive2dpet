# 3D 形象插件

`avatar-3d` 支持 PMX（MMD）格式的 3D 模型，需显式启用，与其它形象插件互斥。

## 配置

在根配置的 `plugins` 数组中添加或修改对应条目。以下为配置示例：

```json
{
  "name": "avatar-3d",
  "physicsEnabled": true,
  "enabled": true,
  "modelPath": "assets/3d/model.pmx",
  "scale": 1,
  "verticalOffset": 0,
  "rotationY": 0
}
```

`modelPath` 必须是项目 `assets/` 下的相对路径，保留模型引用的贴图。`scale` 控制大小，`verticalOffset` 是垂直偏移（CSS 像素），`rotationY` 是初始朝向（度），`physicsEnabled` 控制 PMX 刚体与关节物理，默认开启。

## 使用与兼容性

支持贴图、表情、自动眨眼、头部跟随和骨骼动作，效果取决于模型资源及兼容性。右键拖动旋转模型，菜单「角度回正」恢复初始朝向；右键单击打开菜单，左键拖动移动窗口。

目前支持 PMX、预生成的 Three.js 骨骼关键帧和模型自带物理，不包含 VRM/glTF、VMD 动画或通用布料模拟。模型资源自行准备并遵守资源包授权。

启用本插件时需在同一次配置保存中关闭 `avatar-live2d`。动作资源、物理参数与宿主契约的详细说明见 [形象共用文档](../avatarShared/README.md)。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
