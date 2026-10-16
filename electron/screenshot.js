const { desktopCapturer, screen } = require("electron");
const fs = require("fs");
const path = require("path");

const SCREENSHOTS_DIR = path.join(__dirname, "../logs/screenshots");

function ensureDir() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/** 2026-10-10_00-53-12.jpg */
function timestampFilename(prefix = "") {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const name =
    (prefix ? `${prefix}_` : "") +
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

function uniqueJpgPath(filename) {
  const filePath = path.join(SCREENSHOTS_DIR, filename);
  if (!fs.existsSync(filePath)) return filePath;
  return path.join(
    SCREENSHOTS_DIR,
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

  const finalPath = uniqueJpgPath(timestampFilename());
  fs.writeFileSync(finalPath, source.thumbnail.toJPEG(quality));

  return {
    path: finalPath,
    filename: path.basename(finalPath),
    width: source.thumbnail.getSize().width,
    height: source.thumbnail.getSize().height,
  };
}

/**
 * 框选结束后截取屏幕区域（实时画面，非冻结帧）。
 * @param {{ x: number, y: number, width: number, height: number }} region 屏幕 DIP 坐标
 * @param {number} [quality]
 */
async function captureRegionToJpg(region, quality = 40) {
  ensureDir();

  if (
    !region ||
    !Number.isFinite(region.width) ||
    !Number.isFinite(region.height) ||
    region.width < 4 ||
    region.height < 4
  ) {
    throw new Error("截图区域无效");
  }

  const display = screen.getDisplayMatching({
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.round(region.width),
    height: Math.round(region.height),
  });
  const scale = display.scaleFactor || 1;
  const thumbW = Math.max(1, Math.floor(display.size.width * scale));
  const thumbH = Math.max(1, Math.floor(display.size.height * scale));

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: thumbW, height: thumbH },
    fetchWindowIcons: false,
  });

  if (!sources.length) {
    throw new Error("未找到可截取的屏幕源");
  }

  const source = pickSourceForDisplay(sources, display);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("屏幕缩略图为空，截图失败");
  }

  let image = source.thumbnail;
  const size = image.getSize();
  if (size.width !== thumbW || size.height !== thumbH) {
    image = image.resize({ width: thumbW, height: thumbH, quality: "better" });
  }

  let x = Math.round((region.x - display.bounds.x) * scale);
  let y = Math.round((region.y - display.bounds.y) * scale);
  let w = Math.round(region.width * scale);
  let h = Math.round(region.height * scale);
  const imgSize = image.getSize();

  x = Math.max(0, Math.min(x, imgSize.width - 1));
  y = Math.max(0, Math.min(y, imgSize.height - 1));
  w = Math.max(1, Math.min(w, imgSize.width - x));
  h = Math.max(1, Math.min(h, imgSize.height - y));

  const cropped = image.crop({ x, y, width: w, height: h });
  if (cropped.isEmpty()) {
    throw new Error("裁剪区域为空");
  }

  const finalPath = uniqueJpgPath(timestampFilename("region"));
  fs.writeFileSync(finalPath, cropped.toJPEG(quality));

  return {
    path: finalPath,
    filename: path.basename(finalPath),
    width: cropped.getSize().width,
    height: cropped.getSize().height,
  };
}

module.exports = {
  SCREENSHOTS_DIR,
  captureFullscreenToJpg,
  captureRegionToJpg,
};
