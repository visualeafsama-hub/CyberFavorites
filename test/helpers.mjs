// 测试用的小工具：在临时目录启动服务、发请求、生成测试文件。不依赖任何第三方库。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 去掉外面带进来的 CF_* 变量（比如给 AI 配的 CF_URL / CF_TOKEN），测试只用自己设的配置
export const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CF_')));

let pass = 0, fail = 0;
export function ok(cond, msg, extra = '') {
  cond ? pass++ : fail++;
  console.log(cond ? '  ok  ' : '  FAIL', msg, extra === '' ? '' : String(extra));
}
export const results = () => ({ pass, fail });

// 在临时数据目录里启动一个服务实例，等它打印“已启动”再返回
export async function startServer({ port, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-test-'));
  const child = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: { ...baseEnv(), CF_PORT: String(port), CF_DATA: join(dir, 'data.json'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`服务没有启动：\n${log}`)), 8000);
    const check = () => { if (log.includes('已启动')) { clearTimeout(t); resolve(); } };
    child.stdout.on('data', check);
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`服务退出了（${code}）：\n${log}`)); });
  });
  return {
    port, dir, env: { CF_PORT: String(port), CF_DATA: join(dir, 'data.json'), ...env },
    log: () => log,
    stop() { child.kill(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// 用 http.request 发请求：fetch 不允许改 Host，而测试需要模拟不同的域名
export function request(port, path, { method = 'GET', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
    const json = body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string';
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: {
      Host: host ?? `127.0.0.1:${port}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers,
    } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d)).on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch { /* 不是 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, data, text });
      });
    });
    r.on('error', reject);
    if (raw !== undefined) r.write(raw);
    r.end();
  });
}

// 最小的 zip 生成（不压缩），用来造 docx 测试文件
export function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name), data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// 一张 2×1 的 PNG
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwHwQZGBgADh0D/U8UDn8AAAAASUVORK5CYII=', 'base64');
