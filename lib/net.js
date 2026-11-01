// 抓取网页用的 GET。服务器模式下拒绝访问内网地址（防 SSRF），手动跟随重定向，每一跳都检查。
// 检查放在建立连接时的 lookup 里做，DNS 在“检查”和“连接”之间换了地址也绕不过去。
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

export class FetchError extends Error {}

const v4ToInt = (ip) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
].map(([a, bits]) => [v4ToInt(a), bits]);

function privateV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

function v6Words(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [h, t] = s.split('::');
  const head = h ? h.split(':') : [];
  const words = t === undefined ? head
    : [...head, ...Array(Math.max(0, 8 - head.length - (t ? t.split(':').length : 0))).fill('0'), ...(t ? t.split(':') : [])];
  return words.map((w) => parseInt(w, 16));
}

function privateV6(ip) {
  const w = v6Words(ip);
  if (w.length !== 8 || w.some(Number.isNaN)) return true; // 解析不了就当内网，宁可错拦
  const embedded = () => privateV4(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`);
  if (w.slice(0, 7).every((x) => x === 0) && w[7] <= 1) return true; // :: 和 ::1
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return embedded(); // IPv4 映射地址
  if (w[0] === 0x64 && w[1] === 0xff9b) return embedded(); // NAT64
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地地址
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  return (w[0] & 0xff00) === 0xff00; // 组播
}

export function isPrivateAddress(ip) {
  const t = net.isIP(ip);
  return t === 4 ? privateV4(ip) : t === 6 ? privateV6(ip) : true;
}

function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, list) => {
      if (err) return cb(err);
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return cb(new FetchError(`拒绝访问内网地址：${hostname}`));
      }
      if (options.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  };
}

function once(u, { allowPrivate, headers, timeout, maxBytes }) {
  return new Promise((resolve, reject) => {
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new FetchError('只支持 http/https'));
    // 主机名本身就是 IP 时不会走 lookup，要在这里先查
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) return reject(new FetchError(`拒绝访问内网地址：${host}`));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers, timeout, lookup: guardedLookup(allowPrivate) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) });
      }
      const enc = (res.headers['content-encoding'] ?? '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
        : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
          : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks = [];
      let size = 0, finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).subarray(0, maxBytes) });
      };
      stream.on('data', (c) => {
        chunks.push(c);
        size += c.length;
        if (size >= maxBytes) { done(); req.destroy(); }
      });
      stream.on('end', done);
      stream.on('error', (e) => (size ? done() : reject(e)));
    });
    req.on('timeout', () => req.destroy(new FetchError('请求超时')));
    req.on('error', reject);
  });
}

export async function safeGet(url, { allowPrivate = false, headers = {}, timeout = 8000, maxBytes = 1 << 20, redirects = 5 } = {}) {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const res = await once(current, { allowPrivate, headers, timeout, maxBytes });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (hop >= redirects) throw new FetchError('重定向次数太多');
      current = new URL(res.headers.location, current);
      continue;
    }
    return { ...res, url: current.toString() };
  }
}
