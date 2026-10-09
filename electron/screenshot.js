const { desktopCapturer, screen } = require("electron");
const fs = require("fs");
const path = require("path");

const SCREENSHOTS_DIR = path.join(__dirname, "../logs/screenshots");

function ensureDir() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/** 2026-10-10_00-53-12.jpg */
function timestampFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const name = [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  ].join("-")
    + "_"
    + [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join("-")
    + ".jpg";
  return name;
}

function pickPrimarySource(sources, primary) {
  const byId = sources.find(
    (s) => s.display_id && String(s.display_id) === String(primary.id),
  );
  if (byId) return byId;

  // 部分环境下 display_id 为空，优先选 thumbnail 最大的（主屏通常最大）
  return sources.slice().sort((a, b) => {
    const aa = a.thumbnail.getSize();
    const bb = b.thumbnail.getSize();
    return bb.width * bb.height - aa.width * aa.height;
  })[0];
}

/**
 * 截取主屏全屏，保存为 JPG，返回绝对路径。
 */
async function captureFullscreenToJpg(quality = 25) {
  ensureDir();

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

  const filename = timestampFilename();
  const filePath = path.join(SCREENSHOTS_DIR, filename);
  // 若同秒冲突则加毫秒后缀
  const finalPath = fs.existsSync(filePath)
    ? path.join(
        SCREENSHOTS_DIR,
        filename.replace(/\.jpg$/, `_${Date.now() % 1000}.jpg`),
      )
    : filePath;

  const jpeg = source.thumbnail.toJPEG(quality);
  fs.writeFileSync(finalPath, jpeg);

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
