const { execFile } = require("child_process");
const { promisify } = require("util");
const { createHash } = require("crypto");
const { setTimeout: delay } = require("timers/promises");
const { readFileSync } = require("fs");
const path = require("path");

const bootstrap = readFileSync(path.join(__dirname, "cosyvoiceBootstrap.py"), "utf8");

const exec = promisify(execFile);
const OWNER = "io.mylive2dpet.tts";
const SPEC = "io.mylive2dpet.tts.spec";

async function runDocker(args, { signal, timeout = 30000 } = {}) {
  try {
    const { stdout, stderr } = await exec("docker", args, { signal, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return (args[0] === "logs" ? `${stdout}\n${stderr}` : stdout).trim();
  } catch (error) {
    signal?.throwIfAborted();
    const detail = String(error.stderr || error.message).slice(-1200);
    throw new Error(`Docker 操作失败（${args[0]}）：${detail}。请确认 Docker 已安装并运行，当前用户有访问权限；GPU 模式还需要 NVIDIA Container Toolkit。`);
  }
}

/** Owns only labelled application containers; named data volumes survive shutdown/replacement. */
function createDockerService({ run = runDocker, fetchImpl = (...args) => fetch(...args), logger = console,
  wait = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  let containerName = null;
  let spec = null;

  async function inspect(name, signal) {
    const id = await run(["ps", "-aq", "--filter", `name=^/${name}$`], { signal });
    if (!id) return null;
    const containers = JSON.parse(await run(["inspect", name], { signal }));
    return containers[0];
  }

  async function ensure(service, signal, onStatus = () => {}) {
    signal.throwIfAborted();
    onStatus("checking-docker");
    await run(["info", "--format", "{{.ServerVersion}}"], { signal });
    const name = `mylive2dpet-tts-cosyvoice-${service.port}`;
    const desired = createHash("sha256").update(JSON.stringify({ recipe: 2, image: service.image, port: service.port, gpu: service.gpu })).update(bootstrap).digest("hex");
    let container = await inspect(name, signal);
    if (container && container.Config?.Labels?.[OWNER] !== "cosyvoice") {
      throw new Error(`容器名称 ${name} 已被其他服务占用，请修改 tts.service.port`);
    }
    // Remember ownership before mutations, including when a canceled `docker run` created the container.
    containerName = name;
    spec = desired;
    if (container && container.Config.Labels[SPEC] !== desired) {
      await run(["rm", "-f", name], { signal });
      container = null;
    }
    if (!container) {
      const image = await run(["image", "ls", "-q", service.image], { signal });
      if (!image) {
        onStatus("pulling-image");
        logger.info("[tts] 正在下载本地语音模型镜像，首次下载可能需要较长时间:", service.image);
        await run(["pull", service.image], { signal, timeout: service.pullTimeoutMs });
      }
      signal.throwIfAborted();
      onStatus("starting-container");
      const args = ["run", "-d", "--name", name,
        "--label", `${OWNER}=cosyvoice`, "--label", `${SPEC}=${desired}`,
        "--restart", "no", "-p", `127.0.0.1:${service.port}:8188`,
        "-v", `mylive2dpet-cosyvoice-${service.port}-data:/data`,
        "-e", "MODEL_DIR=pretrained_models/Fun-CosyVoice3-0.5B",
        "-e", "MODELSCOPE_CACHE=/data/cache/modelscope", "-e", "HF_HOME=/data/cache/huggingface"];
      if (service.gpu) args.push("--gpus", "all");
      args.push(service.image, "python", "-u", "-c", bootstrap);
      // Let issued create/start mutations finish before shutdown inspects and stops the container.
      // Killing the Docker client midway can otherwise leave a late-created orphan behind.
      await run(args, { timeout: 120000 });
    } else if (!container.State?.Running) {
      onStatus("starting-container");
      await run(["start", name], { timeout: 120000 });
    }
    signal.throwIfAborted();
    onStatus("loading-model");
    logger.info("[tts] 正在等待 CosyVoice 模型加载完成");
    const deadline = Date.now() + service.startupTimeoutMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      container = await inspect(name, signal);
      if (!container?.State?.Running) {
        const logs = await run(["logs", "--tail", "60", name], { signal });
        logger.error("[tts] CosyVoice 容器启动失败:", logs);
        if (/modelscope|wetext/i.test(logs) && /HTTPError|403|ConnectionError|timed out/i.test(logs)) {
          throw new Error("CosyVoice 辅助模型资源下载失败（ModelScope/WeText），请检查模型站点网络或鉴权；详细原因见应用日志");
        }
        const detail = container?.State?.Error || logs.replace(/\s+/g, " ").slice(-1200) || "容器已退出";
        throw new Error(`CosyVoice 容器启动失败：${detail}`);
      }
      try {
        const response = await fetchImpl(`http://127.0.0.1:${service.port}/health`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        });
        const health = response.ok ? await response.json() : null;
        if (health?.status === "healthy" && health.gpu?.model_loaded === true) {
          return `http://127.0.0.1:${service.port}/v1`;
        }
      } catch { signal.throwIfAborted(); }
      await wait(1000, signal);
    }
    throw new Error("CosyVoice 模型加载超时，请检查 Docker 日志、GPU 兼容性或增加 tts.service.startupTimeoutMs");
  }

  async function stop() {
    if (!containerName) return;
    const name = containerName;
    const expected = spec;
    containerName = null;
    spec = null;
    const container = await inspect(name);
    // Never stop another application's container or a replacement with a different configuration.
    if (container?.Config?.Labels?.[OWNER] === "cosyvoice" && container.Config.Labels[SPEC] === expected && container.State?.Running) {
      await run(["stop", "-t", "10", name], { timeout: 20000 });
    }
  }

  return { ensure, stop };
}

module.exports = { createDockerService, runDocker };
