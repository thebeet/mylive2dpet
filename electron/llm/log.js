const fs = require("fs");
const path = require("path");

function createRotatingLog(filePath, { maxBytes = 5 * 1024 * 1024, backups = 3 } = {}) {
  return (entry) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    if (fs.existsSync(filePath) && fs.statSync(filePath).size + Buffer.byteLength(line) > maxBytes) {
      for (let index = backups; index >= 1; index -= 1) {
        const target = `${filePath}.${index}`;
        const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
        if (fs.existsSync(target)) fs.unlinkSync(target);
        if (fs.existsSync(source)) fs.renameSync(source, target);
      }
    }
    fs.appendFileSync(filePath, line, "utf8");
  };
}

module.exports = { createRotatingLog };
