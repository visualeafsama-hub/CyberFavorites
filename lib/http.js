// HTTP 小工具：错误、JSON 读写、Cookie、客户端 IP。
export class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body, null, 2));
}

export function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

export async function readJson(req, max = 1e6) {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, '请求体必须是 application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, `请求体太大，上限 ${Math.round(max / 1e6)} MB`);
    chunks.push(chunk);
  }
  // Windows 终端里 curl -d 传中文常被转成 GBK，直接存会变乱码，这里拦下并告诉调用方怎么改
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch {
    throw new HttpError(400, '请求体不是 UTF-8 编码。Windows 下请把 JSON 写进 UTF-8 文件，再用 curl --data-binary @file.json 发送');
  }
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, '请求体不是合法 JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体必须是 JSON 对象');
  return body;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* 坏 Cookie 跳过 */ }
  }
  return out;
}

export function cookie(name, value, { maxAge, secure, httpOnly = true } = {}) {
  return [
    `${name}=${encodeURIComponent(value)}`, 'Path=/',
    // Lax：从别的网站点链接进来时也能带上登录状态；跨站的 POST / fetch 不带
    'SameSite=Lax',
    httpOnly && 'HttpOnly', secure && 'Secure',
    maxAge !== undefined && `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// 只有请求来自本机（也就是本机上的 nginx）时，才相信它转发过来的真实 IP
export function clientIp(req) {
  const peer = req.socket.remoteAddress ?? '';
  if (LOOPBACK.has(peer)) {
    const fwd = req.headers['x-real-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0];
    if (fwd) return String(fwd).trim();
  }
  return peer;
}

// 文件名放进 Content-Disposition：ASCII 兜底名 + RFC 5987 的 UTF-8 名
export function disposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
