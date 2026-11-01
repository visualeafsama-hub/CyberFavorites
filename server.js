#!/usr/bin/env node
// CyberFavorites 服务：静态页面 + JSON API + SSE 推送 + 文件上传。只用 Node 内置模块，没有依赖。
// 两种模式见 lib/config.js：本机模式不用登录；服务器模式（设置了 CF_PUBLIC_URL）所有访问都要登录。
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cfg from './lib/config.js';
import { Store } from './lib/store.js';
import { FileStore } from './lib/files.js';
import { Items } from './lib/items.js';
import { Auth, describeUa, tooManyFailures, recordFailure } from './lib/auth.js';
import { createApi } from './lib/api.js';
import { HttpError, send, redirect, readJson, parseCookies, cookie, clientIp, disposition } from './lib/http.js';
import { qrMatrix } from './public/qr.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const OPEN = process.argv.includes('--open');
const COOKIE = 'cf_session';

const problem = cfg.checkConfig();
if (problem) { console.error(problem); process.exit(1); }

const auth = cfg.SERVER ? new Auth(cfg.AUTH_FILE, cfg.OWNER_TOKEN) : null;

// node server.js --login-link：在服务器上直接生成一个登录链接，所有设备都丢了的时候用
if (process.argv.includes('--login-link')) {
  if (!cfg.SERVER) { console.log('本机模式不需要登录，直接打开', cfg.PUBLIC_URL); process.exit(0); }
  printLoginLink(auth.createLink({ minutes: 30, note: 'cli' }), '30 分钟');
  process.exit(0);
}

const store = new Store(cfg.DATA);
const files = new FileStore(cfg.FILES_DIR);
const items = new Items(store, files);
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

const api = createApi({ store, files, items, broadcast, clients,
  launcherOpts: { root: ROOT, icon: join(PUBLIC, 'icon.ico') } });

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
// 页面只加载自己的脚本和样式；图片允许外链（网站图标、GitHub 预览图）
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data: blob:; " +
  "media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
// 登录页不需要登录就能看到的静态资源
const PUBLIC_ASSETS = new Set(['/login.html', '/login.js', '/style.css', '/qr.js', '/favicon.svg', '/fonts/cinzel-latin.woff2']);

/* ===== 认证 ===== */
function whoami(req) {
  if (!cfg.SERVER) return { kind: 'local' };
  const bearer = (req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) {
    if (auth.checkOwner(bearer)) return { kind: 'owner' };
    const t = auth.findToken(bearer);
    if (t) return { kind: 'token', id: t.id, name: t.name };
    return null;
  }
  const s = auth.findSession(parseCookies(req.headers.cookie)[COOKIE]);
  return s ? { kind: 'session', id: s.id, name: s.name } : null;
}

function setSession(res, req, name) {
  const { token, maxAge } = auth.createSession({ name, ua: req.headers['user-agent'] ?? '' });
  return cookie(COOKIE, token, { maxAge, secure: cfg.SECURE_COOKIE });
}

async function authApi(req, res, parts, who) {
  const [, b, c] = parts;
  const { method } = req;
  if (b === 'status' && method === 'GET') {
    return send(res, 200, { mode: cfg.MODE, loggedIn: !!who, via: who?.kind ?? null, device: who?.name ?? null,
      publicUrl: cfg.PUBLIC_URL });
  }
  // 登录：粘贴一次性登录链接里的码，或者 CF_TOKEN 主令牌
  if (b === 'login' && method === 'POST') {
    if (!cfg.SERVER) return send(res, 200, { ok: true });
    const ip = clientIp(req);
    if (tooManyFailures(ip)) throw new HttpError(429, '失败次数太多，15 分钟后再试');
    const { code, name } = await readJson(req);
    const raw = String(code ?? '').trim();
    const t = raw.match(/[?&]t=([\w-]+)/)?.[1] ?? raw; // 整个链接粘进来也行
    if (!auth.consumeLink(t) && !auth.checkOwner(t)) {
      recordFailure(ip);
      throw new HttpError(401, '登录码不对，或者已经用过、过期了');
    }
    return send(res, 200, { ok: true }, { 'Set-Cookie': setSession(res, req, String(name ?? '').slice(0, 60)) });
  }
  if (!who) throw new HttpError(401, '需要登录');
  if (b === 'logout' && method === 'POST') {
    if (who.kind === 'session') auth.removeSession(who.id);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(COOKIE, '', { maxAge: 0, secure: cfg.SECURE_COOKIE }) });
  }
  // 给新设备生成一次性登录链接，网页上显示成二维码
  if (b === 'link' && method === 'POST') {
    const { token, expiresAt } = auth.createLink();
    return send(res, 200, { url: `${cfg.PUBLIC_URL}/login?t=${token}`, expiresAt });
  }
  if (b === 'sessions') {
    if (!c && method === 'GET') return send(res, 200, { sessions: auth.listSessions(who.kind === 'session' ? who.id : null) });
    if (c && method === 'DELETE') {
      if (!auth.removeSession(c)) throw new HttpError(404, '没有这个设备');
      return send(res, 200, { deleted: c });
    }
  }
  if (b === 'tokens') {
    if (!c && method === 'GET') return send(res, 200, { tokens: auth.listTokens() });
    if (!c && method === 'POST') {
      const { name } = await readJson(req);
      const r = auth.createToken(String(name ?? '').trim().slice(0, 40));
      return send(res, 201, { token: r.token, record: r.record, note: '令牌只显示这一次，请马上保存' });
    }
    if (c && method === 'DELETE') {
      if (!auth.removeToken(c)) throw new HttpError(404, '没有这个令牌');
      return send(res, 200, { deleted: c });
    }
  }
  throw new HttpError(404, '未知接口');
}

/* ===== 文件和静态资源 ===== */
async function serveStatic(res, pathname) {
  const file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC + sep)) throw new HttpError(403, 'forbidden');
  let buf;
  try { buf = await readFile(file); } catch { throw new HttpError(404, 'not found'); }
  const ext = extname(file);
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME[ext] ?? 'application/octet-stream',
    ...(ext === '.html' ? { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache' } : { 'Cache-Control': 'no-cache' }) });
  res.end(buf);
}

// 上传的文件只在“图片”时内联显示（svg 除外，里面可以带脚本），其他一律下载
function serveFile(req, res, url, id) {
  const it = store.items.find((i) => i.file?.id === id);
  if (!it || !files.exists(it.file)) throw new HttpError(404, '文件不存在');
  const f = it.file;
  const inline = /^image\/(png|jpeg|gif|webp|bmp|avif|x-icon)$/.test(f.mime) && !url.searchParams.has('download');
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': inline ? f.mime : 'application/octet-stream',
    'Content-Length': f.size,
    'Content-Disposition': disposition(inline ? 'inline' : 'attachment', f.name),
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') return res.end();
  files.stream(f).pipe(res);
}

/* ===== 路由 ===== */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://placeholder');
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  try {
    // 只接受自己的域名。挡住 DNS 重绑定：恶意网页把自己的域名解析到这台机器，Host 是它的域名
    if (!cfg.ALLOWED_HOSTS.has(String(req.headers.host ?? '').toLowerCase())) {
      throw new HttpError(421, `不认识的 Host：${req.headers.host}。服务器模式请把域名写进 CF_PUBLIC_URL 或 CF_ALLOWED_HOSTS`);
    }
    // 跨站请求一律拒绝：别的网页没法替你收藏、删除、读取
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !cfg.ALLOWED_HOSTS.has(safeHost(origin))) throw new HttpError(403, '拒绝跨站请求');
    if (req.headers['sec-fetch-site'] === 'cross-site' && (isApi || url.pathname.startsWith('/files/'))) {
      throw new HttpError(403, '拒绝跨站请求');
    }

    const who = whoami(req);
    const parts = url.pathname.split('/').filter(Boolean);

    if (isApi && parts[1] === 'auth') return await authApi(req, res, parts.slice(1), who);

    // 一次性登录链接：/login?t=xxx。用掉它、种下 Cookie，再跳到首页，令牌不会留在地址栏和历史记录里
    if (url.pathname === '/login') {
      if (!cfg.SERVER) return redirect(res, '/');
      const t = url.searchParams.get('t');
      if (t) {
        const ip = clientIp(req);
        if (!tooManyFailures(ip) && auth.consumeLink(t)) {
          return redirect(res, '/', { 'Set-Cookie': setSession(res, req, describeUa(req.headers['user-agent'])) });
        }
        recordFailure(ip);
        return redirect(res, '/login?expired=1');
      }
      return await serveStatic(res, '/login.html');
    }

    if (!who) {
      if (isApi) throw new HttpError(401, '需要登录。网页请打开 /login；AI 和脚本请带 Authorization: Bearer <API 令牌>');
      if (PUBLIC_ASSETS.has(url.pathname)) return await serveStatic(res, url.pathname);
      return redirect(res, '/login');
    }

    if (isApi) return await api(req, res, url, parts.slice(1));
    if (parts[0] === 'files' && parts[1] && ['GET', 'HEAD'].includes(req.method)) return serveFile(req, res, url, parts[1]);
    if (url.pathname === '/login.html') return redirect(res, '/');
    return await serveStatic(res, url.pathname);
  } catch (e) {
    const status = e.status ?? 500;
    if (status === 500) console.error(e);
    if (res.headersSent) return res.end();
    if (isApi || status !== 404) return send(res, status, { error: status === 500 ? '服务器内部错误' : e.message }, BASE_HEADERS);
    res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

function safeHost(origin) {
  try { return new URL(origin).host.toLowerCase(); } catch { return ''; }
}

/* ===== 启动 ===== */
function openBrowser() {
  const page = cfg.PUBLIC_URL;
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', page]]
    : process.platform === 'darwin' ? ['open', [page]] : ['xdg-open', [page]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

// 在终端里画二维码：两个像素行拼成一个字符，用半块字符
function terminalQr(text) {
  const m = qrMatrix(text);
  const q = 2, n = m.length + q * 2;
  const at = (x, y) => x >= q && y >= q && x < n - q && y < n - q && m[y - q][x - q];
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    for (let x = 0; x < n; x++) {
      const top = at(x, y), bottom = at(x, y + 1);
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function printLoginLink({ token }, valid) {
  const link = `${cfg.PUBLIC_URL}/login?t=${token}`;
  console.log(`\n登录链接（${valid}内有效，只能用一次）：\n${link}\n`);
  console.log(terminalQr(link));
  console.log('\n用手机扫码，或者把链接复制到浏览器打开。之后在网页的 设置 → 设备 里给其他设备生成登录码。\n');
}

// 端口被占用时，看看是不是自己已经在跑：是就直接打开网页（快捷方式点第二次的情况），不是就报错
function alreadyRunning() {
  return new Promise((resolve) => {
    const r = request({ host: '127.0.0.1', port: cfg.PORT, path: '/api/auth/status', timeout: 1500,
      headers: { Host: `127.0.0.1:${cfg.PORT}` } }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d)).on('end', () => resolve(s.includes('"mode"')));
    });
    r.on('error', () => resolve(false)).on('timeout', () => { r.destroy(); resolve(false); });
    r.end();
  });
}

server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  if (await alreadyRunning()) {
    console.log(`CyberFavorites 已经在运行：${cfg.PUBLIC_URL}`);
    if (OPEN) openBrowser();
    process.exit(0);
  }
  console.error(`端口 ${cfg.PORT} 被其他程序占用，用 CF_PORT 换一个端口`);
  process.exit(1);
});

server.requestTimeout = 0; // 大文件上传可能很久；单次请求的空闲超时由下面的 timeout 管
server.headersTimeout = 30_000;
server.timeout = 120_000;

server.listen(cfg.PORT, cfg.HOST, () => {
  console.log(`CyberFavorites 已启动（${cfg.SERVER ? '服务器模式，需要登录' : '本机模式'}）：${cfg.PUBLIC_URL}`);
  console.log(`监听 ${cfg.HOST}:${cfg.PORT}，数据目录：${cfg.DATA_DIR}`);
  if (cfg.SERVER && auth.unclaimed) printLoginLink(auth.createLink({ minutes: 60, note: 'first-run' }), '60 分钟');
  if (OPEN) openBrowser();
});
