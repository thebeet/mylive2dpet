# TTS 插件

`tts` 订阅核心语音输出请求，支持 OpenAI 兼容语音接口、自动部署的本地 CosyVoice、系统语音与 GPT-SoVITS。配置放在项目根目录 `config.json` 的 `plugins` 数组中，修改后自动重载。菜单可在运行期控制开关。

### 云端或自行管理的 API

填写支持 `POST /audio/speech`、返回 WAV 音频的兼容接口：

```json
{
  "name": "tts",
  "enabled": true,
  "provider": "openai-compatible",
  "apiBase": "https://your-tts-service.example/v1",
  "apiKey": "your-api-key",
  "model": "your-tts-model",
  "voice": "your-voice-id",
  "speed": 1,
  "interruptOnNewChat": true
}
```

`apiBase` 包含服务要求的版本前缀，插件自动追加 `/audio/speech`。`apiKey` 非空时通过 Bearer 头发送；本地无鉴权服务可省略。`voice` 是该服务支持的音色 ID，云端音色创建仍遵循服务商接口。这里兼容的是 Speech 协议，使用厂商专有协议的 API 需要额外适配。

### 自动部署本地 CosyVoice

用户只需配置参考音频和对应文字，无需执行 Docker 命令或手动注册音色：

```json
{
  "name": "tts",
  "enabled": true,
  "provider": "openai-compatible",
  "service": { "type": "docker", "preset": "cosyvoice" },
  "refAudio": "assets/voice/reference.wav",
  "promptText": "这段参考录音里实际说的台词。",
  "interruptOnNewChat": true
}
```

应用在插件启动后后台检查 Docker，镜像缺失时自动拉取，再启动容器、等待模型就绪、创建音色。初始化不阻塞应用启动；期间的语音请求等待服务，已被打断的旧请求不会恢复播放。菜单「语音 TTS」显示下载、模型加载、音色创建、就绪及错误状态，初始化失败后可重新点击「开启」重试。

本地运行前提是已安装并运行 Docker，当前用户有 Docker 访问权限；默认使用 NVIDIA GPU，还需驱动和 NVIDIA Container Toolkit。应用不会安装 Docker、驱动或修改系统权限。首次拉取的是完整模型镜像，需要下载时间和磁盘空间。启动时自动从 PyPI 下载固定版本 WeText 0.0.9 安装包（约 1.5 MB），校验 SHA-256 后仅提取合成所需的中英文资源，不安装其中的 Python 代码。这些资源保存在 `/data/cache/wetext-0.0.9`，后续启动直接复用，避免镜像默认的 ModelScope 全仓下载。参考文字留空时仍会额外加载 Fun-ASR 自动转写模型，建议填写准确文字。下载站点的网络或鉴权错误会作为服务错误显示。

可选的完整本地参数如下，通常不必填写默认值：

```json
"service": {
  "type": "docker",
  "preset": "cosyvoice",
  "image": "neosun/cosyvoice:v3.4.0",
  "port": 8188,
  "gpu": true,
  "startupTimeoutMs": 1200000,
  "pullTimeoutMs": 1800000
}
```

`gpu=false` 不传 GPU 给容器，性能及可用性取决于模型的 CPU 支持。这个 preset 针对该镜像的端口、模型路径、健康检查及音色接口设计，`image` 应仅覆盖为兼容镜像，不能直接换成任意 TTS 镜像。`service.type` 默认 `external`，该模式只调用 API，不运行 Docker。

本地 `apiBase` 和 `model` 默认分别为 `http://127.0.0.1:8188/v1`、`cosyvoice-v3`；端口改变时地址自动调整。提供 `voice` 时直接使用已有自定义音色 ID；否则用 `refAudio` 和 `promptText` 自动注册。相同录音及参考文字生成稳定指纹，在服务端复用已保存的音色；改变录音或文字会创建新音色，旧音色不会自动删除。参考音频使用主机路径，插件通过上传传给容器，无需配置容器内文件路径。

容器只绑定 `127.0.0.1`，名称为 `mylive2dpet-tts-cosyvoice-<port>`。音色、辅助模型缓存和输出保存在命名卷 `mylive2dpet-cosyvoice-<port>-data`，挂载到 `/data`。应用退出、TTS 配置禁用或插件重载时停止其管理的容器，保留容器和数据供下次复用；更换镜像或 GPU 配置时替换自己的容器并保留数据卷。端口改变会使用另一组容器和数据卷。运行期菜单关闭只取消语音，保留已加载服务便于再次开启。应用不会接管或停止无本项目标签的容器。

两种模式都支持 `speed`（默认 1）、`timeoutMs`（单次 HTTP 请求超时，默认 120000）和 `interruptOnNewChat`（默认 true）。当前只支持 `responseFormat=wav`，先合成完整文件再播放；尚未实现边生成边播放。`instruct` 可选，用于这个 CosyVoice 镜像的指令控制扩展，并非通用协议字段。

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

验证：`node --test tests/tts.test.js tests/config.test.js`。
辅助资源缓存验证：`python3 -B tests/cosyvoiceBootstrap.test.py`。

返回 [项目概览](../../../README.md)，插件扩展接口见 [架构文档](../../architecture/README.md)。
