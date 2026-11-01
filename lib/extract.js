// 从上传的文件里抽出文字，用来搜索。支持 docx / pptx / xlsx（读 zip 里的 XML）和各种纯文本文件。
// 只用内置 zlib；解压时限制输出大小，防止压缩炸弹。
import { inflateRawSync } from 'node:zlib';

const MAX_TEXT = 20_000;
const MAX_ENTRY = 8 * 1024 * 1024;
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'conf', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'java', 'kt', 'go', 'rs', 'rb', 'php',
  'swift', 'lua', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'html', 'htm', 'css', 'scss', 'vue', 'svelte', 'tex', 'srt', 'vtt']);

export const extOf = (name) => (String(name).match(/\.([a-z0-9]{1,10})$/i)?.[1] ?? '').toLowerCase();
export const canExtract = (name) => TEXT_EXT.has(extOf(name)) || ['docx', 'pptx', 'xlsx'].includes(extOf(name));

export function extractText(buf, name) {
  const ext = extOf(name);
  try {
    if (TEXT_EXT.has(ext)) return clip(decodeText(buf));
    if (ext === 'docx') return clip(xmlText(zipEntries(buf, (n) => n === 'word/document.xml')));
    if (ext === 'pptx') return clip(xmlText(zipEntries(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))));
    if (ext === 'xlsx') return clip(xmlText(zipEntries(buf, (n) => n === 'xl/sharedStrings.xml')));
  } catch { /* 文件坏了就不抽文字，收藏照样成功 */ }
  return '';
}

const clip = (s) => s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);

// 优先 UTF-8；不是合法 UTF-8 就按 GB18030（Windows 记事本存的中文常是这个）
export function decodeText(buf) {
  const b = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch {
    try { return new TextDecoder('gb18030').decode(b); } catch { return ''; }
  }
}

function xmlText(parts) {
  return parts.map((xml) => xml
    .replace(/<\/w:p>|<\/a:p>|<\/si>|<w:br\/>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'))
    .join('\n\n');
}

// 最小的 zip 读取：从末尾的中央目录找到条目，再按本地文件头的偏移取数据
function zipEntries(buf, want) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (!want(name) || local + 30 > buf.length) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.push([name, data.subarray(0, MAX_ENTRY).toString('utf8')]);
    else if (method === 8) out.push([name, inflateRawSync(data, { maxOutputLength: MAX_ENTRY }).toString('utf8')]);
  }
  // 幻灯片按页码排（slide2 在 slide10 前面）
  return out.sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true })).map((e) => e[1]);
}
