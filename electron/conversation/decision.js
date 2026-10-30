const { buildSystemPrompt } = require("./prompt");
const { extractChatPayload } = require("./parseChatText");
const { buildRequestBody, prepareObservations } = require("./request");
const { sleep, isRetryableError, messageContentToText } = require("../llm/retry");
const { resolveExpressions, createResponseFormat, unsupportedResponseFormat } = require("./output");

/** Pet dialogue policy; transport and text generation belong to the shared client. */
function createConversationPolicy({ client, getOptions, getExpressions = () => [], logger = console, encodeImage, retryWait = sleep }) {
  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 800;
  const encode = encodeImage || imageToBase64Jpeg;
  let negotiatedFormat = "json_schema";
  function imageToBase64Jpeg(filePath, maxWidth = 1920, quality = 25) {
    let image = require("electron").nativeImage.createFromPath(filePath);
    if (image.isEmpty()) {
      throw new Error(`无法读取截图: ${filePath}`);
    }
    const { width } = image.getSize();
    if (width > maxWidth) {
      image = image.resize({ width: maxWidth, quality: "better" });
    }
    return image.toJPEG(quality).toString("base64");
  }

  /**
   * Make a decision from queued observations produced by the perception module.
   * @param {Array<object>} observations Generic observations with text/image content.
   */
  async function decideFromObservations(observations, { context = [], signal, history, refreshContext } = {}) {
    signal?.throwIfAborted();
    if (!Array.isArray(observations) || observations.length === 0) {
      throw new Error("没有可用于决策的感知观察");
    }

    const { ai, character } = getOptions();
    const expressions = resolveExpressions(getExpressions());
    signal?.throwIfAborted();
    const inputs = prepareObservations(observations, encode);
    const systemPrompt = buildSystemPrompt(character, {
      expressions,
    });
    let prepared = history?.prepare(context);
    let body = buildRequestBody(ai, systemPrompt, inputs, history ? [] : context, prepared, expressions);
    if (history) {
      if (await history.compact(context, body.messages, signal, refreshContext)) {
        prepared = history.prepare(context);
        body = buildRequestBody(ai, systemPrompt, inputs, [], prepared, expressions);
      }
      history.assertBudget(body.messages);
    }
    let response = "";
    let expression = "neutral";
    let screenSummary = "";
    let audioSummary = "";
    let workSummary = "";
    let silent = false;
    let raw = "";
    let inputTokens = null;
    const hasImages = observations.some(({ content }) => content.some(({ type }) => type === "image"));
    const hasAudio = observations.some(({ metadata }) => metadata?.modality === "audio");
    const hasUserInput = observations.some((observation) => observation.role === "user");

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (ai.outputFormat === "auto") {
          const format = createResponseFormat(negotiatedFormat, expressions);
          if (format) body.response_format = format;
          else delete body.response_format;
        }
        const data = await client.complete(body, { signal, maxRetries: 0, label: "ai:vision" });

        signal?.throwIfAborted();
        const choice = data?.choices?.[0];
        if (choice?.message?.refusal || choice?.finish_reason === "content_filter") {
          throw Object.assign(new Error("AI 拒绝了本次请求，未返回可用对话 JSON"), { code: "AI_REFUSAL", retryable: false });
        }
        if (choice?.finish_reason === "length") {
          throw Object.assign(new Error("AI 回复达到输出 token 上限，拒绝接受不完整 JSON；请增大 conversation.ai.max_tokens"),
            { code: "AI_OUTPUT_TRUNCATED", retryable: false });
        }
        raw = messageContentToText(choice?.message?.content).trim();
        inputTokens = data?.usage?.prompt_tokens ?? data?.usage?.input_tokens ?? null;
        const parsed = extractChatPayload(raw, expressions, { hasImages, hasAudio, hasUserInput });
        response = (parsed.response || "").trim();
        expression = parsed.expression || "neutral";
        screenSummary = hasImages ? (parsed.screenSummary || "").trim() : "";
        audioSummary = hasAudio ? (parsed.audioSummary || "").trim() : "";
        workSummary = hasImages ? (parsed.workSummary || "").trim() : "";
        silent = parsed.shouldSpeak === false && observations.every((o) => o.role !== "user");

        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (ai.outputFormat === "auto" && unsupportedResponseFormat(err) && negotiatedFormat !== "prompt") {
          negotiatedFormat = negotiatedFormat === "json_schema" ? "json_object" : "prompt";
          logger.warn(`[ai:vision] response format unsupported; using ${negotiatedFormat} with strict local validation`);
          if (attempt < MAX_RETRIES) continue;
        }
        const canRetry =
          attempt < MAX_RETRIES &&
          isRetryableError(err);
        if (!canRetry) {
          if (err.code === "AI_INVALID_OUTPUT") err.retryable = false;
          throw err;
        }
        const delay = RETRY_BASE_MS * (attempt + 1);
        logger.warn(
          `[ai:vision] attempt ${attempt + 1}/${MAX_RETRIES + 1} failed, retry in ${delay}ms:`,
          err instanceof Error ? err.message : err,
        );
        await retryWait(delay, signal);
      }
    }

    signal?.throwIfAborted();
    const result = {
      reply: silent ? "" : response,
      ...(silent ? { speak: false } : {}),
      expression,
      summaries: { screen: screenSummary, audio: audioSummary, ...(workSummary ? { work: workSummary } : {}) },
      metadata: {
        raw,
        inputTokens,
        observationCount: observations.length,
        resources: observations.flatMap(({ content }) => content
          .filter(({ type }) => type !== "text")
          .map(({ type, path, uri }) => ({ type, path, uri }))),
      },
    };
    signal?.throwIfAborted();
    history?.commit(prepared, body, result);
    return result;
  }

  return {
    decideFromObservations: (observations, options = {}) => client.withBudget(
      (signal) => decideFromObservations(observations, { ...options, signal }), options),
  };
}

module.exports = { createConversationPolicy };
