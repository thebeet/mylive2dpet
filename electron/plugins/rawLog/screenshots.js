/** Read saved screenshots through core Storage; pagination never loads image bytes. */
function createScreenshotReader(storage) {
  const screenshots = storage.blobs("screenshots");
  const uriFor = id => `storage://screenshots/${encodeURIComponent(id)}`;
  return {
    listScreenshots(options = {}) {
      const page = screenshots.list(options);
      return { ...page, entries: page.entries.map(entry => ({ ...entry, uri: uriFor(entry.id) })) };
    },
    getScreenshot(id) {
      if (typeof id !== "string" || !id || id.length > 200) throw new Error("无效的截图 ID");
      const blob = screenshots.get(id);
      if (!blob) throw new Error("截图不存在或已删除");
      const { data, ...entry } = blob;
      const mimeType = entry.metadata.mimeType;
      if (!/^image\/(jpeg|png|webp|gif)$/i.test(mimeType)) throw new Error("不支持的截图类型");
      return { ...entry, uri: uriFor(id), imageUrl: `data:${mimeType};base64,${data.toString("base64")}` };
    },
  };
}
module.exports = { createScreenshotReader };
