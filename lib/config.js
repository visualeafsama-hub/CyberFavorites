// 运行配置，全部来自环境变量。两种模式：
// local  本机使用（默认）：只监听本机，不需要登录。
// server 服务器部署：设置了 CF_PUBLIC_URL 或 CF_MODE=server 时启用，所有接口都要登录，抓取网页时屏蔽内网地址。
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const env = process.env;

export const MODE = env.CF_MODE ?? (env.CF_PUBLIC_URL ? 'server' : 'local');
if (!['local', 'server'].includes(MODE)) throw new Error(`CF_MODE 只能是 local 或 server，现在是 ${MODE}`);
export const SERVER = MODE === 'server';

export const PORT = +(env.CF_PORT ?? 4170);
export const HOST = env.CF_HOST ?? '127.0.0.1';
export const DATA = env.CF_DATA ?? join(homedir(), '.cyber-favorites', 'data.json');
export const DATA_DIR = dirname(DATA);
export const FILES_DIR = join(DATA_DIR, 'files');
export const AUTH_FILE = join(DATA_DIR, 'auth.json');

export const PUBLIC_URL = (env.CF_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
export const SECURE_COOKIE = PUBLIC_URL.startsWith('https://');

// 只接受这些 Host。挡住 DNS 重绑定：恶意网页把自己的域名解析到 127.0.0.1 后，Host 是它自己的域名，会被拒绝
export const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`,
  new URL(PUBLIC_URL).host,
  ...(env.CF_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
].map((h) => h.toLowerCase()));

// 服务器模式下可以用 CF_TOKEN 设一个主令牌，登录页输入它也能登录，AI 也能直接用它
export const OWNER_TOKEN = SERVER ? (env.CF_TOKEN ?? '') : '';
export const MAX_UPLOAD = Math.round(+(env.CF_MAX_UPLOAD_MB ?? 50) * 1024 * 1024);

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
export function checkConfig() {
  if (!SERVER && !LOOPBACK.includes(HOST)) {
    return `本机模式只能监听本机地址。要让其他设备访问，请用服务器模式：设置 CF_PUBLIC_URL（例如 https://fav.example.com），所有访问都需要登录`;
  }
  if (SERVER && OWNER_TOKEN && OWNER_TOKEN.length < 24) return 'CF_TOKEN 至少要 24 个字符';
  return null;
}
