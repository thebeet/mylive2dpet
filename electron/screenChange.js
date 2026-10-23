const { nativeImage } = require("electron");

/** @type {number[] | null} */
let lastHash = null;

const DEFAULTS = {
  enabled: true,
  hashSize: 8,
  threshold: 4,
};

function resolveOptions(config) {
  const raw = config?.chat?.changeDetect || {};
  const hashSize = Number(raw.hashSize) > 0 ? Math.floor(Number(raw.hashSize)) : DEFAULTS.hashSize;
  const threshold =
    Number.isFinite(Number(raw.threshold)) && Number(raw.threshold) >= 0
      ? Math.floor(Number(raw.threshold))
      : DEFAULTS.threshold;
  return {
    enabled: raw.enabled !== false,
    hashSize,
    threshold,
  };
}

/**
 * Difference hash：缩到 (n+1)×n、灰度后比较相邻像素，得到 n² bit。
 * @param {Electron.NativeImage} image
 * @param {number} hashSize
 * @returns {number[]}
 */
function computeDHash(image, hashSize = 8) {
  const resized = image.resize({
    width: hashSize + 1,
    height: hashSize,
    quality: "good",
  });
  const { width, height } = resized.getSize();
  const bitmap = resized.toBitmap();
  const bits = new Array(hashSize * hashSize);
  let k = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < hashSize; x++) {
      const i = (y * width + x) * 4;
      const j = i + 4;
      const g1 = 0.299 * bitmap[i + 2] + 0.587 * bitmap[i + 1] + 0.114 * bitmap[i];
      const g2 = 0.299 * bitmap[j + 2] + 0.587 * bitmap[j + 1] + 0.114 * bitmap[j];
      bits[k++] = g1 < g2 ? 1 : 0;
    }
  }
  return bits;
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) d++;
  }
  return d;
}

function hashFromPath(filePath, hashSize) {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    throw new Error(`无法读取截图做哈希: ${filePath}`);
  }
  return computeDHash(image, hashSize);
}

/**
 * 与上一帧对比。首帧或 force 时视为有变化。
 * @param {string} filePath
 * @param {{ force?: boolean, config?: object }} [opts]
 * @returns {{ changed: boolean, distance: number, threshold: number, hash: number[] }}
 */
function compareWithPrevious(filePath, opts = {}) {
  const { enabled, hashSize, threshold } = resolveOptions(opts.config);
  const hash = hashFromPath(filePath, hashSize);

  if (!enabled || opts.force || !lastHash) {
    const distance = lastHash ? hammingDistance(lastHash, hash) : -1;
    lastHash = hash;
    return { changed: true, distance, threshold, hash };
  }

  const distance = hammingDistance(lastHash, hash);
  const changed = distance > threshold;
  // 无论是否变化都更新，避免时钟等噪点跨多轮累积误触发
  lastHash = hash;
  return { changed, distance, threshold, hash };
}

function resetScreenChangeState() {
  lastHash = null;
}

module.exports = {
  computeDHash,
  hammingDistance,
  compareWithPrevious,
  resetScreenChangeState,
  DEFAULTS,
};
