const { createHash } = require("node:crypto");

function resolveBlob(storage, uri, metadataOnly = false) {
  const match = /^storage:\/\/([^/]+)\/([^/?#]+)$/.exec(uri || "");
  if (!match) return undefined;
  const blobs = storage.blobs(decodeURIComponent(match[1]));
  return blobs[metadataOnly ? "getMetadata" : "get"](decodeURIComponent(match[2]));
}

function imageParts(request) {
  return (request.messages || []).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part?.type === "image_url" && typeof part.image_url?.url === "string") : []);
}

/** Request bodies are cloned: log compaction cannot change the outgoing model request. */
function compactRequestImages(storage, request, references = []) {
  const result = JSON.parse(JSON.stringify(request));
  for (const { messageIndex, contentIndex, uri } of references) {
    const part = result.messages?.[messageIndex]?.content?.[contentIndex];
    if (part?.type !== "image_url" || !part.image_url?.url?.startsWith("data:image/")) continue;
    // If the source was removed, preserve the encoded image through the fallback below.
    if (resolveBlob(storage, uri, true)) {
      part.image_url.url = uri;
      part.logImageSource = "original";
    }
  }
  for (const part of imageParts(result)) {
    const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(part.image_url.url);
    if (!match) continue; // Preserve unsupported or malformed historical image fields.
    const data = Buffer.from(match[2], "base64");
    if (!data.length || data.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) continue;
    const mimeType = match[1].toLowerCase();
    const hash = createHash("sha256").update(mimeType).update(data).digest("hex");
    const index = storage.collection("raw-log.image-index");
    const blobs = storage.blobs("raw-log-images");
    let id = index.get(hash);
    if (!id || !blobs.getMetadata(id)) {
      id = blobs.put(data, { mimeType, sha256: hash, source: "encoded-request" }).id;
      index.set(hash, id);
    }
    part.image_url.url = `storage://raw-log-images/${id}`;
    part.logImageSource = "encoded-request";
  }
  return result;
}

/** Preview bytes are fetched only when opening one request, never stored in request JSON. */
function requestImagePreviews(storage, request) {
  const previews = {};
  for (const part of imageParts(request)) {
    const uri = part.image_url.url;
    if (!uri.startsWith("storage://") || Object.hasOwn(previews, uri)) continue;
    try {
      const blob = resolveBlob(storage, uri);
      if (!blob) throw new Error("图片已不存在");
      const mimeType = blob.metadata.mimeType;
      if (!/^image\/(jpeg|png|webp|gif)$/i.test(mimeType)) throw new Error("不支持的图片类型");
      previews[uri] = { url: `data:${mimeType};base64,${blob.data.toString("base64")}` };
    } catch (error) {
      previews[uri] = { error: String(error.message || error) };
    }
  }
  return previews;
}

module.exports = { compactRequestImages, requestImagePreviews };
