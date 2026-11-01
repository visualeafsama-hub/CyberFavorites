// 服务器模式的登录。三种凭证，文件里都只存 SHA-256 哈希：
//   会话（session）：浏览器 Cookie，一台设备一个，能在“设备”列表里单独踢下线
//   登录链接（link）：一次性，用过或过期作废。新设备扫码登录、命令行恢复登录都用它
//   API 令牌（token）：给 AI / 脚本用，走 Authorization: Bearer
// auth.json 可能被另一个进程（node server.js --login-link）改写，所以每次用之前看一下修改时间，变了就重新读。
import { readFileSync, writeFileSync, renameSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 365;
const LINK_MINUTES = 10;
const MAX_SESSIONS = 50;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const token = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;
const now = () => Date.now();

export class Auth {
  constructor(file, ownerToken = '') {
    this.file = file;
    this.ownerHash = ownerToken ? sha(ownerToken) : '';
    this.mtime = 0;
    this.load();
  }

  load() {
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    this.data.sessions ??= [];
    this.data.links ??= [];
    this.data.tokens ??= [];
    this.mtime = existsSync(this.file) ? statSync(this.file).mtimeMs : 0;
  }

  fresh() {
    const m = existsSync(this.file) ? statSync(this.file).mtimeMs : 0;
    if (m !== this.mtime) this.load();
    return this.data;
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const d = this.data;
    d.links = d.links.filter((l) => !l.usedAt && l.expiresAt > now());
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.mtime = statSync(this.file).mtimeMs;
  }

  // 没有任何已登录设备、也没有 API 令牌：说明还没“认领”，启动时要打印登录链接
  get unclaimed() {
    const d = this.fresh();
    return !d.sessions.length && !d.tokens.length && !this.ownerHash;
  }

  /* ===== 登录链接 ===== */
  createLink({ minutes = LINK_MINUTES, note = '' } = {}) {
    this.fresh();
    const t = token('cfl');
    const expiresAt = now() + minutes * 60_000;
    this.data.links.push({ hash: sha(t), createdAt: now(), expiresAt, note });
    this.save();
    return { token: t, expiresAt };
  }

  // 用掉一个登录链接；成功返回 true
  consumeLink(t) {
    const d = this.fresh();
    const link = d.links.find((l) => l.hash === sha(String(t ?? '')));
    if (!link || link.usedAt || link.expiresAt < now()) return false;
    link.usedAt = now();
    this.save();
    return true;
  }

  checkOwner(t) {
    if (!this.ownerHash || !t) return false;
    const a = Buffer.from(sha(String(t))), b = Buffer.from(this.ownerHash);
    return timingSafeEqual(a, b);
  }

  /* ===== 会话 ===== */
  createSession({ name = '', ua = '' } = {}) {
    this.fresh();
    const t = token('cfs');
    const s = { id: randomBytes(5).toString('hex'), hash: sha(t), name: name || describeUa(ua), ua: ua.slice(0, 300),
      createdAt: now(), lastSeen: now(), expiresAt: now() + SESSION_DAYS * 86_400_000 };
    this.data.sessions.push(s);
    // 太多了就踢掉最久没用的
    this.data.sessions.sort((a, b) => b.lastSeen - a.lastSeen).splice(MAX_SESSIONS);
    this.save();
    return { token: t, session: s, maxAge: SESSION_DAYS * 86_400 };
  }

  findSession(t) {
    if (!t) return null;
    const h = sha(t);
    const s = this.fresh().sessions.find((x) => x.hash === h);
    if (!s || s.expiresAt < now()) return null;
    // lastSeen 最多每 10 分钟写一次盘
    if (now() - s.lastSeen > 600_000) { s.lastSeen = now(); this.save(); }
    return s;
  }

  listSessions(currentId) {
    return this.fresh().sessions
      .filter((s) => s.expiresAt > now())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map(({ hash, ...s }) => ({ ...s, current: s.id === currentId }));
  }

  removeSession(id) {
    const d = this.fresh();
    const i = d.sessions.findIndex((s) => s.id === id);
    if (i < 0) return false;
    d.sessions.splice(i, 1);
    this.save();
    return true;
  }

  /* ===== API 令牌 ===== */
  createToken(name) {
    this.fresh();
    const t = token('cft');
    const rec = { id: randomBytes(5).toString('hex'), hash: sha(t), name: name || 'API 令牌',
      prefix: t.slice(0, 10), createdAt: now(), lastUsed: null };
    this.data.tokens.push(rec);
    this.save();
    const { hash, ...pub } = rec;
    return { token: t, record: pub };
  }

  findToken(t) {
    if (!t) return null;
    const h = sha(t);
    const rec = this.fresh().tokens.find((x) => x.hash === h);
    if (!rec) return null;
    if (!rec.lastUsed || now() - rec.lastUsed > 600_000) { rec.lastUsed = now(); this.save(); }
    return rec;
  }

  listTokens() { return this.fresh().tokens.map(({ hash, ...t }) => t); }

  removeToken(id) {
    const d = this.fresh();
    const i = d.tokens.findIndex((t) => t.id === id);
    if (i < 0) return false;
    d.tokens.splice(i, 1);
    this.save();
    return true;
  }
}

// “Windows · Edge”这种设备名，只用来在设备列表里认出是哪台
export function describeUa(ua = '') {
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '未知系统';
  const br = /Edg\//.test(ua) ? 'Edge' : /MicroMessenger/.test(ua) ? '微信' : /QQ\//.test(ua) ? 'QQ'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari'
      : /curl|node|python/i.test(ua) ? '命令行' : '浏览器';
  return `${os} · ${br}`;
}

// 登录失败限流：每个 IP 15 分钟内最多 10 次
const fails = new Map();
export function tooManyFailures(ip) {
  const f = fails.get(ip);
  if (!f || f.until < now()) return false;
  return f.count >= 10;
}
export function recordFailure(ip) {
  const f = fails.get(ip);
  if (!f || f.until < now()) fails.set(ip, { count: 1, until: now() + 15 * 60_000 });
  else f.count++;
  if (fails.size > 10_000) fails.clear();
}
