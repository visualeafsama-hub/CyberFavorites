// 生成 public/icon.ico（快捷方式图标）。和 favicon.svg 同一个光环图案，用代码逐像素画，不依赖图形库。
// 用法：node scripts/make-icon.mjs
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const ACCENT = [59, 151, 211], HI = [159, 214, 247], PALE = [238, 246, 252], SOFT = [210, 230, 245], WHITE = [255, 255, 255];
const SS = 4; // 每个像素 4×4 超采样抗锯齿

// 返回单位坐标 (x, y ∈ [-1, 1]) 处的颜色，null 表示透明
function shade(x, y) {
  const r = Math.hypot(x, y), a = Math.atan2(y, x);
  const ring = (c, w) => Math.abs(r - c) < w;
  // 字母 C：粗圆弧，右侧留缺口
  const deg = ((a * 180) / Math.PI + 360) % 360;
  if (ring(0.38, 0.1) && !(deg < 45 || deg > 315)) return ACCENT;
  if (ring(0.72, 0.06)) return ACCENT;
  if (r < 0.72) return WHITE;
  if (ring(0.9, 0.035) && Math.floor(((a + Math.PI) / (2 * Math.PI)) * 36) % 2 === 0) return HI;
  if (r < 0.97) return r < 0.85 ? PALE : SOFT;
  return null;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((i + (sx + 0.5) / SS) / size) * 2 - 1, y = ((j + (sy + 0.5) / SS) / size) * 2 - 1;
          const c = shade(x, y);
          if (!c) continue;
          R += c[0]; G += c[1]; B += c[2]; A++;
        }
      }
      const o = (j * size + i) * 4;
      if (A) { px[o] = R / A; px[o + 1] = G / A; px[o + 2] = B / A; }
      px[o + 3] = (A / (SS * SS)) * 255;
    }
  }
  return px;
}

function png(size) {
  const px = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let j = 0; j < size; j++) px.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 位 RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ICO 里直接放 PNG（Vista 以后都支持）
const sizes = [16, 24, 32, 48, 64, 256];
const images = sizes.map(png);
const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = Buffer.concat(sizes.map((s, k) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(images[k].length, 8); e.writeUInt32LE(offset, 12);
  offset += images[k].length;
  return e;
}));
writeFileSync(new URL('../public/icon.ico', import.meta.url), Buffer.concat([header, dir, ...images]));
writeFileSync(new URL('../public/icon-256.png', import.meta.url), images.at(-1));
console.log('public/icon.ico');
