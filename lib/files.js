// 上传文件的保存和读取。文件存在 FILES_DIR/<文件id>.<扩展名>，名字由服务端生成，不用用户给的文件名。
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync, createReadStream, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { extOf } from './extract.js';

export const RASTER = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico']);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  avif: 'image/avif', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};
export const mimeOf = (ext) => MIME[ext] ?? 'application/octet-stream';

// 按文件头判断真实格式，不信任扩展名和 Content-Type
export function sniff(head) {
  const h = (n) => head.subarray(0, n).toString('hex');
  if (h(8) === '89504e470d0a1a0a') return 'png';
  if (h(3) === 'ffd8ff') return 'jpg';
  if (h(4) === '47494638') return 'gif';
  if (h(4) === '52494646' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (h(2) === '424d') return 'bmp';
  if (head.subarray(4, 12).toString('latin1') === 'ftypavif') return 'avif';
  if (h(4) === '25504446') return 'pdf';
  if (h(4) === '504b0304') return 'zip';
  return '';
}

// 读图片宽高，卡片排版用。不认识的格式返回 null
export function imageSize(buf, ext) {
  try {
    if (ext === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (ext === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (ext === 'bmp') return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    if (ext === 'jpg') {
      for (let p = 2; p + 9 < buf.length;) {
        if (buf[p] !== 0xff) { p++; continue; }
        const m = buf[p + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5) };
        p += 2 + buf.readUInt16BE(p + 2);
      }
    }
    if (ext === 'webp') {
      const kind = buf.subarray(12, 16).toString('latin1');
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch { /* 头不完整 */ }
  return null;
}

export class FileStore {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  path(file) { return join(this.dir, `${file.id}${file.ext ? `.${file.ext}` : ''}`); }

  // 把请求体流式写到临时文件，边写边算哈希，超过上限就中止
  receive(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const declared = +(req.headers['content-length'] ?? 0);
      if (declared > maxBytes) return reject(Object.assign(new Error(`文件太大，上限 ${Math.round(maxBytes / 1048576)} MB`), { status: 413 }));
      const tmp = join(this.dir, `.upload-${randomBytes(6).toString('hex')}`);
      const out = createWriteStream(tmp, { mode: 0o600 });
      const hash = createHash('sha256');
      let size = 0, head = Buffer.alloc(0), failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        rmSync(tmp, { force: true });
        reject(err);
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          return fail(Object.assign(new Error(`文件太大，上限 ${Math.round(maxBytes / 1048576)} MB`), { status: 413 }));
        }
        if (head.length < 4096) head = Buffer.concat([head, chunk]).subarray(0, 4096);
        hash.update(chunk);
        if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('end', () => {
        if (failed) return;
        if (!size) return fail(Object.assign(new Error('文件是空的'), { status: 400 }));
        out.end(() => resolve({ tmp, size, head, sha256: hash.digest('hex') }));
      });
      req.on('error', fail);
      req.on('aborted', () => fail(new Error('上传中断')));
      out.on('error', (e) => fail(Object.assign(new Error(`保存文件失败：${e.code ?? e.message}`), { status: 500 })));
    });
  }

  // 临时文件转正，返回存进收藏里的 file 字段
  commit(upload, originalName) {
    const sniffed = sniff(upload.head);
    const named = extOf(originalName);
    // zip 格式的 docx/xlsx/pptx 保留原扩展名；其他情况以文件头为准
    const ext = sniffed && !(sniffed === 'zip' && named) ? sniffed : named;
    const file = { id: randomBytes(8).toString('hex'), ext, name: cleanName(originalName, ext), size: upload.size,
      mime: mimeOf(ext), sha256: upload.sha256 };
    renameSync(upload.tmp, this.path(file));
    if (RASTER.has(ext)) {
      const dim = imageSize(readHead(this.path(file), 256 * 1024), ext === 'jpeg' ? 'jpg' : ext);
      if (dim && dim.width > 0 && dim.height > 0) Object.assign(file, dim);
    }
    return file;
  }

  discard(upload) { rmSync(upload.tmp, { force: true }); }
  remove(file) { rmSync(this.path(file), { force: true }); }
  read(file) { return readFileSync(this.path(file)); }
  stream(file) { return createReadStream(this.path(file)); }
  exists(file) { try { return statSync(this.path(file)).isFile(); } catch { return false; } }
}

function readHead(path, n) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally { closeSync(fd); }
}

// 显示用的文件名：去掉路径和控制字符。剪贴板截图没有名字，网页会按本地时间起名，这里只兜底
function cleanName(name, ext) {
  let n = String(name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  if (!n) n = `文件${ext ? `.${ext}` : ''}`;
  return n;
}
