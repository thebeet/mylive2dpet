const { desktopCapturer, screen } = require("electron");
const fs = require("fs");
const path = require("path");

const SCREENSHOTS_DIR = path.join(__dirname, "../../logs/screenshots");

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

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

function uniqueJpgPath(filename, directory) {
  const filePath = path.join(directory, filename);
  if (!fs.existsSync(filePath)) return filePath;
  return path.join(
    directory,
    filename.replace(/\.jpg$/, `_${Date.now() % 1000}.jpg`),
  );
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
 * 截取主屏全屏，保存为 JPG，返回绝对路径。
 */
async function captureFullscreenToJpg(options = {}) {
  const { quality = 25, directory = SCREENSHOTS_DIR } = typeof options === "number" ? { quality: options } : options;
  ensureDir(directory);

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

  const finalPath = uniqueJpgPath(timestampFilename(), directory);
  fs.writeFileSync(finalPath, source.thumbnail.toJPEG(quality));

  return {
    path: finalPath,
    filename: path.basename(finalPath),
    width: source.thumbnail.getSize().width,
    height: source.thumbnail.getSize().height,
  };
}

module.exports = {
  SCREENSHOTS_DIR,
  captureFullscreenToJpg,
};
