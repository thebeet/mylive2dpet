# TTS 插件

`tts` 订阅核心语音输出请求，支持系统语音与 GPT-SoVITS。需配置并启用；菜单可在运行期控制开关。

### 系统语音

在 `plugins` 中配置：

```json
{ "name": "tts", "enabled": true, "provider": "system", "interruptOnNewChat": true }
```

系统合成使用 Windows 的 `System.Speech`、macOS 的 `say`，或 Linux 的 `espeak-ng` / `espeak`。播放使用 Windows PowerShell、macOS `afplay` 或 Linux `aplay`。

Linux 示例依赖：

```bash
sudo apt install espeak-ng alsa-utils
```

### GPT-SoVITS

先在 GPT-SoVITS 项目中启动 API 服务，例如 `api_v2.py`，再配置插件：

```json
{
  "name": "tts",
  "enabled": true,
  "provider": "gpt-sovits",
  "apiBase": "http://127.0.0.1:9880",
  "apiVersion": "v2",
  "gptWeights": "assets/voice/model.ckpt",
  "sovitsWeights": "assets/voice/model.pth",
  "refAudio": "assets/voice/reference.wav",
  "promptText": "参考音频对应的台词。",
  "textLang": "zh",
  "promptLang": "zh",
  "interruptOnNewChat": true
}
```

模型和参考音频需自行准备。相对路径以本项目根目录为基准；本机 `refAudio` 必须存在。容器或远程服务看到的参考音频路径不同，可用 `refAudioApiPath` 指定服务端路径。服务已预加载权重时，可设 `weightsPreloaded=true`，跳过权重切换。

新语音默认取消旧任务。关闭 TTS 会取消待处理合成和播放；重新开启不会恢复已取消的语音。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
