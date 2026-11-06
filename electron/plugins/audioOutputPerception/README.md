# 设备音频感知插件

`audio-output-perception` 监听设备播放的声音，经 ASR 转写后提交观察；需配置并启用，目前采集仅支持 Linux。

## 环境与部署

音频插件采集设备**播放的声音**，使用 PulseAudio 或 PipeWire 的 PulseAudio 兼容输出监视源。Linux 需要 `pactl` 和 `parec`，通常由 `pulseaudio-utils` 提供：

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
  "source": "default",
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

菜单「感知设备播放的语音 → 实时显示内容 → 开启」打开字幕窗口。流式文字标记为“识别中”，后续离线修正替换同一条字幕；只有段尾最终修正文本进入观察队列，按决策周期供桌宠理解和回应。中间字幕不会触发模型调用。默认不保存原始音频，桌宠播放 TTS 时会取消尚未完成的识别并暂时抑制采集。

`source=default` 使用默认输出设备的 `.monitor` 源，可用 `pactl list short sources` 查看其它监视源并指定名称。这是设备播放音频监听；采集器不会退回麦克风。当前容器模型主要面向中文，`language` 仅标记结果语言，切换识别语言需要更换服务端模型。`apiKey` 可用于需要 Bearer 验证的 WebSocket 网关；`proxy` 可填写 HTTP(S) 代理 URL，留空直连本地服务。

### 使用原有 Whisper 或其他转写服务

原有 Whisper 部署保存在 [compose.whisper.yaml](../../../compose.whisper.yaml)，可运行 `docker compose -f compose.whisper.yaml up -d`，将 `asr.provider` 改回 `whisper-asr-webservice`、`endpoint` 改为 `http://127.0.0.1:9000`。该方式在分段完成后通过 HTTP `/asr` 转写，不提供流式字幕。

也支持兼容 `/audio/transcriptions` 的服务，配置 `provider=openai` 和 `model`，详见 [架构文档](../../architecture/README.md)。修改配置后自动重载音频插件。

### 运行期开关与验证

通过菜单「感知设备播放的语音 → 开启/关闭」控制本次运行的采集；字幕显示开关只控制窗口。关闭采集会取消转写、清空待处理音频并关闭字幕窗口，TTS 播放期间会抑制音频采集。

在项目根目录执行 `npm run test:audio` 检查分段、转写与播放抑制；更详细的采集协议、Whisper 部署和生命周期说明见 [架构文档](../../architecture/README.md#设备音频感知)。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
