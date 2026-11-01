// npm test：分别启动本机模式和服务器模式的临时实例，把主要功能和安全检查跑一遍。
// 不访问外网，链接收藏用的是本机地址（本机模式允许、服务器模式应当拒绝抓取）。
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ok, results, startServer, request, makeZip, TINY_PNG, ROOT, baseEnv } from './helpers.mjs';
import { isPrivateAddress } from '../lib/net.js';
import { qrMatrix } from '../public/qr.js';
import { extractText } from '../lib/extract.js';

const DOCX = makeZip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>装甲板识别 &amp; 卡尔曼滤波</w:t></w:r></w:p></w:body></w:document>',
});

console.log('== 纯函数');
ok(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:192.168.1.1', '100.64.1.1'].every(isPrivateAddress), '内网地址都识别出来');
ok(!['8.8.8.8', '2606:4700::1111', '::ffff:1.1.1.1'].some(isPrivateAddress), '公网地址不误伤');
ok(extractText(DOCX, 'a.docx') === '装甲板识别 & 卡尔曼滤波', '从 docx 抽出文字');
ok(extractText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'gbk.txt') === '中文', 'GBK 文本按 GB18030 解码');
ok(qrMatrix('https://example.com/login?t=cfl_abc').length === 29, '二维码尺寸正确（版本 3）');

/* ===== 本机模式 ===== */
console.log('== 本机模式');
const local = await startServer({ port: 4191 });
const L = (path, opts) => request(local.port, path, opts);
try {
  ok((await L('/api/auth/status')).data.mode === 'local', '默认是本机模式，不用登录');

  const page = await L('/');
  ok(page.status === 200 && page.headers['content-security-policy']?.includes("script-src 'self'"), '首页带 CSP');

  const png = await L('/api/upload?name=image.png&groupMode=none', { method: 'POST', body: TINY_PNG,
    headers: { 'Content-Type': 'application/octet-stream' } });
  ok(png.status === 201 && png.data.item.type === 'image', '上传截图 → 图片收藏');
  ok(png.data.item.file.width === 2 && png.data.item.file.height === 1, '读出图片尺寸');
  const again = await L('/api/upload?name=x.png', { method: 'POST', body: TINY_PNG, headers: { 'Content-Type': 'application/octet-stream' } });
  ok(again.data.duplicate === true, '同一张图去重');

  const img = await L(`/files/${png.data.item.file.id}`);
  ok(img.headers['content-type'] === 'image/png' && img.headers['content-disposition'].startsWith('inline'), '图片内联显示');

  const doc = await L(`/api/upload?name=${encodeURIComponent('周报.docx')}&groupMode=pick&group=${encodeURIComponent('工作')}`,
    { method: 'POST', body: DOCX, headers: { 'Content-Type': 'application/octet-stream' } });
  ok(doc.status === 201 && doc.data.item.type === 'file' && doc.data.item.text.includes('卡尔曼'), 'docx → 文件，抽出正文');
  const groups = (await L('/api/groups')).data.groups;
  ok(groups.some((g) => g.name === '工作' && g.id === doc.data.item.groupId), '按分组名指定分组，不存在就新建');
  const s = (await L(`/api/search?q=${encodeURIComponent('卡尔曼')}`)).data.results;
  ok(s[0]?.item.id === doc.data.item.id, '能搜到文件里的文字');

  const html = await L('/api/upload?name=evil.html', { method: 'POST', body: '<script>alert(1)</script>', headers: { 'Content-Type': 'application/octet-stream' } });
  const served = await L(`/files/${html.data.item.file.id}`);
  ok(served.headers['content-type'] === 'application/octet-stream' && served.headers['content-disposition'].startsWith('attachment'), 'html 文件只能下载');
  ok((await L('/api/upload?name=a.txt', { method: 'POST', body: 'hi', headers: { 'Content-Type': 'text/plain' } })).status === 415, '表单类型上传被拒');

  const text = await L('/api/items', { method: 'POST', body: { text: 'git log --oneline\n看提交历史', groupMode: 'auto' } });
  ok(text.status === 201 && text.data.item.type === 'text' && text.data.item.title === 'git log --oneline', '文字片段，首行做标题');
  ok(text.data.autoGroup?.name === '文本片段', '自动分组：没有相似分组时按类型归入', text.data.autoGroup?.name);

  const link = await L('/api/items', { method: 'POST', body: { url: `http://127.0.0.1:${local.port}/login.html`, groupMode: 'none' } });
  ok(link.status === 201 && link.data.item.title.includes('CyberFavorites'), '本机模式能收藏并抓取内网页面', link.data.item.title);

  const del = await L(`/api/items/${doc.data.item.id}`, { method: 'DELETE' });
  ok(del.status === 200 && (await L(`/files/${doc.data.item.file.id}`)).status === 404, '删除收藏时一起删除文件');

  ok((await L('/api/items', { host: `evil.example:${local.port}` })).status === 421, '伪造 Host 被拒（DNS 重绑定）');
  ok((await L('/api/items', { method: 'POST', body: {}, headers: { Origin: 'https://evil.example' } })).status === 403, '跨站 Origin 被拒');
  ok((await L('/api/items', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status === 403, 'Sec-Fetch-Site: cross-site 被拒');
  ok([403, 404].includes((await L('/..%2fserver.js')).status), '路径穿越被拒');
} finally { local.stop(); }

/* ===== 服务器模式 ===== */
console.log('== 服务器模式');
const HOST = 'fav.test:4192';
const srv = await startServer({ port: 4192, env: { CF_PUBLIC_URL: `http://${HOST}` } });
const S = (path, opts = {}) => request(srv.port, path, { host: HOST, ...opts });
const cookieOf = (r) => (r.headers['set-cookie'] ?? [])[0]?.split(';')[0];
try {
  // 登录链接在“已启动”之后打印，可能分在下一块输出里
  for (let i = 0; i < 20 && !/login\?t=cfl_/.test(srv.log()); i++) await new Promise((r) => setTimeout(r, 100));
  ok(/login\?t=cfl_/.test(srv.log()), '首次启动打印登录链接');
  ok((await S('/api/items')).status === 401, '未登录访问接口 → 401');
  ok((await S('/')).headers.location === '/login', '未登录打开首页 → 跳登录页');
  ok((await S('/app.js')).status === 303, '未登录拿不到主程序');

  const cli = execFileSync(process.execPath, [join(ROOT, 'server.js'), '--login-link'], { env: { ...baseEnv(), ...srv.env }, encoding: 'utf8' });
  const t = cli.match(/login\?t=(cfl_[\w-]+)/)[1];
  const login = await S(`/login?t=${t}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' } });
  const c = cookieOf(login);
  ok(login.headers.location === '/' && c?.startsWith('cf_session='), '登录链接 → 种 Cookie，跳回首页');
  ok(/HttpOnly/.test(login.headers['set-cookie'][0]) && /SameSite=Lax/.test(login.headers['set-cookie'][0]), 'Cookie 是 HttpOnly + SameSite');
  ok(!(await S(`/login?t=${t}`)).headers['set-cookie'], '登录链接只能用一次');
  ok((await S('/api/items', { headers: { Cookie: c } })).status === 200, '带 Cookie 能访问');

  const link = (await S('/api/auth/link', { method: 'POST', body: {}, headers: { Cookie: c } })).data.url;
  const phone = await S('/api/auth/login', { method: 'POST', body: { code: link } });
  ok(phone.status === 200 && cookieOf(phone), '新设备粘贴登录链接能登录');
  const sessions = (await S('/api/auth/sessions', { headers: { Cookie: c } })).data.sessions;
  const other = sessions.find((x) => !x.current);
  await S(`/api/auth/sessions/${other.id}`, { method: 'DELETE', headers: { Cookie: c } });
  ok((await S('/api/items', { headers: { Cookie: cookieOf(phone) } })).status === 401, '移除设备后立即失效');

  const tk = (await S('/api/auth/tokens', { method: 'POST', body: { name: 'AI' }, headers: { Cookie: c } })).data;
  const bearer = { Authorization: `Bearer ${tk.token}` };
  ok((await S('/api/items', { method: 'POST', body: { text: 'from ai' }, headers: bearer })).status === 201, 'API 令牌能读写');
  await S(`/api/auth/tokens/${tk.record.id}`, { method: 'DELETE', headers: { Cookie: c } });
  ok((await S('/api/stats', { headers: bearer })).status === 401, '撤销令牌后立即失效');

  const ssrf = await S('/api/items', { method: 'POST', headers: { Cookie: c },
    body: { url: `http://127.0.0.1:${srv.port}/login.html`, groupMode: 'none' } });
  ok(ssrf.status === 201 && ssrf.data.item.title !== '登录 · CyberFavorites', '服务器模式不抓取内网地址（SSRF）', ssrf.data.item.title);
  ok((await S('/api/system', { method: 'PATCH', body: { autostart: true }, headers: { Cookie: c } })).data.supported === false,
    '服务器模式不能远程改开机自启');

  let last;
  for (let i = 0; i < 11; i++) last = await S('/api/auth/login', { method: 'POST', body: { code: `cfl_x${i}` } });
  ok(last.status === 429, '猜登录码 10 次后限流');
} finally { srv.stop(); }

const { pass, fail } = results();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
