# 设备音频感知插件

`audio-output-perception` 支持同时监听多个电脑播放与麦克风声音源，经 ASR 转写后提交观察；需配置并启用，目前采集仅支持 Linux。

## 环境与部署

音频插件使用 PulseAudio 或 PipeWire 的 PulseAudio 兼容服务：`output` 采集电脑**播放的声音**（输出监视源），`microphone` 采集麦克风输入。每个声音源独立采集、分段、转写和去重，使用共享 ASR 配置。Linux 需要 `pactl` 和 `parec`，通常由 `pulseaudio-utils` 提供：

```bash
sudo apt install pulseaudio-utils
```

### 启动 ASR 容器

下面的 Docker Compose 命令均在项目根目录执行。

[compose.asr.yaml](../../../compose.asr.yaml) 使用 FunASR 官方 CPU 在线服务镜像，运行 Paraformer 的 **2-pass** 模式：在线模型边听边出字，离线模型在语音结束后修正文字并补标点。

```bash
docker compose -f compose.asr.yaml up -d
docker compose -f compose.asr.yaml logs -f
docker compose -f compose.asr.yaml ps
```

服务地址为 `ws://127.0.0.1:10096`，仅绑定本机。首次启动需要下载镜像以及中文在线、离线、VAD、标点、语言模型和 ITN 模型；模型缓存保存在 `mylive2dpet-funasr-models` 卷。等待日志显示模型加载完成、容器变为 healthy 后再开启监听。CPU 性能决定实际识别延迟；默认使用 4 个解码线程。

### 配置音频插件

在 `plugins` 数组中加入：

```json
{
  "name": "audio-output-perception",
  "enabled": true,
  "sources": [
    { "type": "output", "source": "default", "label": "电脑播放", "enabled": true },
    { "type": "microphone", "source": "default", "label": "桌面麦克风", "enabled": true }
  ],
  "speechThresholdDb": -40,
  "minSpeechMs": 400,
  "silenceMs": 800,
  "maxSegmentMs": 15000,
  "ttsCooldownMs": 600,
  "asr": {
    "provider": "funasr",
    "endpoint": "ws://127.0.0.1:10096",
    "language": "zh",
    "chunkSize": [5, 10, 5],
    "chunkInterval": 10,
    "timeoutMs": 60000
  }
}
```

确认累计 400ms 语音后，插件开始通过 WebSocket 发送 16kHz 单声道 PCM16，保留开头的预录音；后续每 60ms 发送一块，不等整段结束。`chunkSize=[5,10,5]` 对应 600ms 在线解码窗口，每块大小由 `60 × chunkSize[1] / chunkInterval` 毫秒计算。静音 800ms 或达到 15 秒后发送结束标记，等待最终结果。`timeoutMs` 控制连接和段尾最终识别等待时间。

菜单「声音感知 → 实时显示内容 → 开启」打开字幕窗口，每条字幕标注声音源标签。流式文字标记为“识别中”，后续离线修正替换同一条字幕；只有段尾最终修正文本进入观察队列，按决策周期供桌宠理解和回应。中间字幕不会触发模型调用。默认不保存原始音频，桌宠播放 TTS 时会取消尚未完成的识别并暂时抑制采集。

`sources` 可配置多个声音源；每项包含 `type`（`output` / `microphone`）、`source`、可选 `label` 和 `enabled`。`source=default` 分别选择启动时的默认输出监视源或默认输入源。用 `pactl list short sources` 查看具体名称：电脑播放选择 `.monitor` 源，麦克风选择输入源，如 `alsa_input.usb-…`，将完整名称填入对应项的 `source`。指定设备不可用或类型不匹配时显示错误，不回退到其他设备。一个来源失败不会停止其他来源。

插件顶层 `enabled` 控制是否随启动自动采集；每项 `enabled: false` 表示仅列出设备供菜单手动开启。`sources: []` 表示不自动选择任何声音源。未设置 `sources` 时兼容旧 `source` 字段，仍只自动采集电脑播放声音；设置 `sources` 后以数组为准。同一类型和源名称不能重复；默认源与其具体名称指向同一设备时仅采集一次，具体名称配置优先。`config.example.json` 默认关闭麦克风自动采集，可按需修改。

观察保持 `source: "audio-output"` 以兼容已有队列和摘要，`metadata.sourceType` 区分播放与麦克风，`metadata.sourceId`、`device` 和 `label` 标识具体来源。同一来源 15 秒内的重复文本去重，不同来源分别保留。

当前容器模型主要面向中文，`language` 仅标记结果语言，切换识别语言需要更换服务端模型。`apiKey` 可用于需要 Bearer 验证的 WebSocket 网关；`proxy` 可填写 HTTP(S) 代理 URL，留空直连本地服务。

### 使用原有 Whisper 或其他转写服务

原有 Whisper 部署保存在 [compose.whisper.yaml](../../../compose.whisper.yaml)，可运行 `docker compose -f compose.whisper.yaml up -d`，将 `asr.provider` 改回 `whisper-asr-webservice`、`endpoint` 改为 `http://127.0.0.1:9000`。该方式在分段完成后通过 HTTP `/asr` 转写，不提供流式字幕。

也支持兼容 `/audio/transcriptions` 的服务，配置 `provider=openai` 和 `model`，详见 [架构文档](../../architecture/README.md)。修改配置后自动重载音频插件。

### 运行期开关与验证

菜单「声音感知」参考摄像头感知按设备列出所有电脑播放和麦克风声音源，已开启设备置顶并标记 `●`。每个设备的子菜单可独立开启、关闭并查看状态；「关闭所有」停止所有声音源。「刷新声音源」更新设备列表并释放已断开的采集设备，新发现设备需手动开启。启动时默认设备会解析为具体设备；更改系统默认设备后重启插件以重新选择，也可直接在菜单中开启对应设备。

开关仅影响本次运行，不修改配置文件。关闭单个来源取消其转写并清除该来源待处理观察和字幕，其他设备继续采集；关闭所有或停止插件还会清空并关闭字幕窗口。字幕显示开关只控制窗口。桌宠播放 TTS 时所有来源（包括麦克风）均取消未完成识别并暂停采集，播放结束后等待 `ttsCooldownMs` 再恢复，避免把桌宠自身声音识别为新观察。

在项目根目录执行 `npm run test:audio` 检查分段、转写与播放抑制；更详细的采集协议、Whisper 部署和生命周期说明见 [架构文档](../../architecture/README.md#设备音频感知)。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
