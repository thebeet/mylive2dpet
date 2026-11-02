const { desktopCapturer, screen } = require("electron");

/** 2026-10-10_00-53-12.jpg */
function timestampFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const name =
    [
      d.getFullYear(),
      pad(d.getMonth() + 1),
      pad(d.getDate()),
    ].join("-") +
    "_" +
    [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join("-") +
    ".jpg";
  return name;
}

function pickSourceForDisplay(sources, display) {
  const byId = sources.find(
    (s) => s.display_id && String(s.display_id) === String(display.id),
  );
  if (byId) return byId;

  return sources.slice().sort((a, b) => {
    const aa = a.thumbnail.getSize();
    const bb = b.thumbnail.getSize();
    return bb.width * bb.height - aa.width * aa.height;
  })[0];
}

function pickPrimarySource(sources, primary) {
  return pickSourceForDisplay(sources, primary);
}

/**
 * 截取主屏全屏，返回 JPEG 字节；持久化由感知插件通过 Storage 完成。
 */
async function captureFullscreenToJpg(options = {}) {
  const { quality = 25 } = typeof options === "number" ? { quality: options } : options;

  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const thumbW = Math.max(1, Math.floor(width * scale));
  const thumbH = Math.max(1, Math.floor(height * scale));

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: thumbW, height: thumbH },
    fetchWindowIcons: false,
  });

  if (!sources.length) {
    throw new Error("未找到可截取的屏幕源");
  }

  const source = pickPrimarySource(sources, primary);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("屏幕缩略图为空，截图失败");
  }

  return {
    data: source.thumbnail.toJPEG(quality),
    mimeType: "image/jpeg",
    capturedAt: new Date().toISOString(),
    filename: timestampFilename(),
    width: source.thumbnail.getSize().width,
    height: source.thumbnail.getSize().height,
  };
}

module.exports = {
  captureFullscreenToJpg,
};
