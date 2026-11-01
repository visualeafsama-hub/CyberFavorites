// 前端：拉取数据、按分组渲染、拖拽排序、上传、监听 SSE。AI 通过 API 改了数据或主题，这里会实时刷新。
import { qrSvg } from './qr.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '');

const TYPE_LABEL = { repo: 'GitHub 项目', skill: 'Skill', mcp: 'MCP', site: '网站', article: '文章', tool: '工具',
  image: '图片', file: '文件', text: '文本' };
const LINK_TYPES = ['repo', 'skill', 'mcp', 'site', 'article', 'tool'];
const AUTO = '__auto', NEW = '__new';
const SORT_LABEL = { new: '最新收藏', old: '最早收藏', stars: 'Star 最多', title: '按标题' };
const UNGROUPED = 'none';
const state = { items: [], groups: [], tags: [], stats: null, theme: null, auth: null,
  group: '', type: '', tag: '', q: '', sort: 'manual' };
const collapsed = new Set(JSON.parse(localStorage.getItem('cf-collapsed') ?? '[]'));

async function api(path, opts = {}) {
  const { rawBody, body, ...rest } = opts;
  const r = await fetch(path, {
    ...rest,
    headers: rawBody ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {},
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('需要登录'); }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), 2200);
}

/* ===== 玫瑰窗 ===== */
(function rose() {
  let g = '';
  [70, 130, 210, 330, 470, 540].forEach((r) => (g += `<circle r="${r}"/>`));
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    g += `<circle cx="${(210 * Math.cos(a)).toFixed(1)}" cy="${(210 * Math.sin(a)).toFixed(1)}" r="120"/>`;
  }
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI) / 12, c = Math.cos(a), s = Math.sin(a);
    g += `<line x1="${330 * c}" y1="${330 * s}" x2="${540 * c}" y2="${540 * s}"/>`;
  }
  for (let i = 0; i < 96; i++) {
    const a = (i * Math.PI) / 48, c = Math.cos(a), s = Math.sin(a);
    g += `<line x1="${470 * c}" y1="${470 * s}" x2="${485 * c}" y2="${485 * s}"/>`;
  }
  $('rose').innerHTML = g;
})();
/* ===== 主题 ===== */
function applyTheme(t) {
  state.theme = t;
  const vars = Object.entries(t.colors).map(([k, v]) => `--c-${k}:${v};`).join('');
  const font = { serif: 'var(--serif)', sans: 'var(--sans)', mono: 'var(--mono)' }[t.font];
  $('theme-vars').textContent = `:root{${vars}--font:${font};--card-w:${t.cardWidth}px;--radius:${t.radius}px;color-scheme:${t.dark ? 'dark' : 'light'}}`;
  $('custom-css').textContent = t.customCss ?? '';
  document.body.className = `layout-${t.layout}${t.decor.rose ? '' : ' no-rose'}${t.decor.rays ? '' : ' no-rays'}${t.dark ? ' dark' : ''}`;
  $('title').textContent = t.title;
  $('subtitle').textContent = t.subtitle;
  document.querySelectorAll('#layout-switch button').forEach((b) => b.classList.toggle('on', b.dataset.layout === t.layout));
  renderPresets();
}

async function renderPresets() {
  if (!renderPresets.schema) renderPresets.schema = await api('/api/theme/schema').catch(() => null);
  if (!renderPresets.schema) return;
  $('presets').innerHTML = Object.entries(renderPresets.schema.presets).map(([k, p]) =>
    `<button type="button" data-preset="${esc(k)}" class="${state.theme?.preset === k ? 'on' : ''}">
       <span class="sw">${['card', 'accent', 'accentSoft', 'ink'].map((c) => `<i style="background:${esc(p.colors[c])}"></i>`).join('')}</span>${esc(p.label)}</button>`).join('');
}

/* ===== 设置：开机自启、快捷方式 ===== */
const SYSTEM_ROWS = [
  ['autostart', '开机自启', '登录 Windows 后在后台启动服务，不弹窗口'],
  ['startMenu', '开始菜单', '可以在开始菜单搜索 “CyberFavorites” 打开'],
  ['desktop', '桌面快捷方式', '双击打开；服务没运行会先启动它'],
];
async function renderSystem() {
  const server = state.auth?.mode === 'server';
  $('system-wrap').hidden = server;
  $('devices-wrap').hidden = !server;
  if (server) return renderDevices();
  const s = await api('/api/system').catch(() => ({ supported: false }));
  if (!s.supported) {
    $('system').innerHTML = '<p class="hint">开机自启和快捷方式目前只支持 Windows。</p>';
    return;
  }
  $('system').innerHTML = SYSTEM_ROWS.map(([k, label, hint]) => `
    <label class="switch"><input type="checkbox" data-sys="${k}" ${s[k] ? 'checked' : ''}>
      <span class="knob"></span><span><b>${label}</b><small>${hint}</small></span></label>`).join('');
}
$('system').addEventListener('change', async (e) => {
  const k = e.target.dataset.sys;
  if (!k) return;
  e.target.disabled = true;
  try {
    await api('/api/system', { method: 'PATCH', body: { [k]: e.target.checked } });
    toast(`${SYSTEM_ROWS.find((r) => r[0] === k)[1]}：${e.target.checked ? '已开启' : '已关闭'}`);
  } catch (err) { toast(err.message); }
  renderSystem();
});
/* ===== 设置：设备和 API 令牌（服务器模式） ===== */
const ago = (t) => {
  if (!t) return '从未';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 2 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};
async function renderDevices() {
  const [{ sessions }, { tokens }] = await Promise.all([api('/api/auth/sessions'), api('/api/auth/tokens')]);
  $('sessions').innerHTML = sessions.map((d) => `<li>
      <span><b>${esc(d.name)}</b>${d.current ? ' <em>这台设备</em>' : ''}<small>最后使用：${ago(d.lastSeen)}</small></span>
      ${d.current ? '' : `<button type="button" class="ghost sm danger" data-kick="${esc(d.id)}">移除</button>`}</li>`).join('')
    || '<li class="hint">没有已登录的设备</li>';
  $('tokens').innerHTML = tokens.map((t) => `<li>
      <span><b>${esc(t.name)}</b> <code>${esc(t.prefix)}…</code><small>最后使用：${ago(t.lastUsed)}</small></span>
      <button type="button" class="ghost sm danger" data-revoke="${esc(t.id)}">撤销</button></li>`).join('')
    || '<li class="hint">还没有令牌。给 AI 用的话生成一个，填进 Skill 的 CF_TOKEN</li>';
}
$('add-device').addEventListener('click', async () => {
  try {
    const { url } = await api('/api/auth/link', { method: 'POST', body: {} });
    $('device-qr').innerHTML = qrSvg(url);
    $('device-url').value = url;
    $('device-link').hidden = false;
  } catch (e) { toast(e.message); }
});
$('copy-device').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('device-url').value);
  toast('登录链接已复制');
});
$('add-token').addEventListener('click', async () => {
  const name = await askName({ title: 'TOKEN · 令牌名称', value: 'Claude Code' });
  if (!name) return;
  try {
    const { token } = await api('/api/auth/tokens', { method: 'POST', body: { name } });
    $('token-value').value = token;
    $('new-token').hidden = false;
    $('token-value').select();
    renderDevices();
  } catch (e) { toast(e.message); }
});
$('logout').addEventListener('click', async () => {
  if (!confirm('退出这台设备？之后要用登录链接重新登录。')) return;
  await api('/api/auth/logout', { method: 'POST', body: {} });
  location.href = '/login';
});
$('devices-wrap').addEventListener('click', async (e) => {
  const kick = e.target.closest('[data-kick]')?.dataset.kick;
  const revoke = e.target.closest('[data-revoke]')?.dataset.revoke;
  if (kick && confirm('移除这台设备？它会立即退出登录。')) await api(`/api/auth/sessions/${kick}`, { method: 'DELETE' });
  else if (revoke && confirm('撤销这个令牌？用它的 AI 和脚本会立即失效。')) await api(`/api/auth/tokens/${revoke}`, { method: 'DELETE' });
  else return;
  renderDevices();
});

/* ===== 数据 ===== */
async function load() {
  const p = new URLSearchParams({ sort: state.sort });
  if (state.type) p.set('type', state.type);
  if (state.tag) p.set('tag', state.tag);
  if (state.q) p.set('q', state.q);
  const [{ items }, { groups }, { tags }, stats] = await Promise.all([
    api(`/api/items?${p}`), api('/api/groups'), api('/api/tags'), api('/api/stats')]);
  Object.assign(state, { items, groups, tags, stats });
  if (state.group && state.group !== UNGROUPED && !groups.some((g) => g.id === state.group)) state.group = '';
  renderSide();
  renderAddGroup();
  renderItems();
}

// 只有“自定义顺序 + 没有搜索和筛选”时才能拖，不然拖出来的位置没有意义
const canDrag = () => state.sort === 'manual' && !state.q && !state.type && !state.tag;

function renderSide() {
  const { stats, groups } = state;
  const g = [['', '全部', stats.total], ...groups.map((x) => [x.id, x.name, x.count])];
  if (stats.ungrouped || !groups.length) g.push([UNGROUPED, '未分组', stats.ungrouped]);
  $('groups').innerHTML = g.map(([k, label, n]) =>
    `<a data-group="${esc(k)}" class="${state.group === k ? 'on' : ''}" ${k ? 'data-drop-group' : ''}>
      <span>${esc(label)}</span><i>${n}</i></a>`).join('') +
    '<a class="new-group" data-act="new-group">＋ 新建分组</a>';

  const types = [['', '全部', stats.total], ...Object.entries(stats.byType).filter(([, n]) => n).map(([k, n]) => [k, TYPE_LABEL[k] ?? k, n])];
  $('types').innerHTML = types.map(([k, label, n]) =>
    `<a data-type="${esc(k)}" class="${state.type === k ? 'on' : ''}">${esc(label)}<i>${n}</i></a>`).join('');
  $('tags').innerHTML = state.tags.length
    ? state.tags.slice(0, 60).map(({ tag, count }) =>
      `<a data-tag="${esc(tag)}" class="${state.tag === tag ? 'on' : ''}">${esc(tag)}<i>${count}</i></a>`).join('')
    : '<span class="hint" style="margin:0">暂无标签</span>';
  $('counter').textContent = `${stats.total} 项收藏 · ${groups.length} 个分组`;
}

function groupOptions(selected) {
  return `<option value="">未分组</option>` +
    state.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === selected ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
}

function renderAddGroup() {
  const sel = $('add-group');
  const keep = sel.value || localStorage.getItem('cf-add-group') || AUTO;
  sel.innerHTML = `<option value="${AUTO}">✦ 自动分组</option><option value="">不分组</option>` +
    (state.groups.length ? `<optgroup label="指定分组">${state.groups.map((g) =>
      `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</optgroup>` : '') +
    `<option value="${NEW}">＋ 新建分组…</option>`;
  sel.value = [AUTO, ''].includes(keep) || state.groups.some((g) => g.id === keep) ? keep : AUTO;
}

// 收藏框当前的分组选择，转成接口参数
function groupParams() {
  const v = $('add-group').value;
  if (v === AUTO) return { groupMode: 'auto' };
  if (!v || v === NEW) return { groupMode: 'none' };
  return { groupMode: 'pick', groupId: v };
}

function fmtStars(n) { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n); }
function fmtDate(s) { return s ? s.slice(0, 10) : ''; }
function fmtSize(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}
const FILE_ICON = { pdf: 'PDF', docx: 'DOC', doc: 'DOC', xlsx: 'XLS', xls: 'XLS', pptx: 'PPT', ppt: 'PPT', zip: 'ZIP',
  rar: 'RAR', '7z': '7Z', md: 'MD', txt: 'TXT', csv: 'CSV', json: 'JSON', mp4: 'MP4', mp3: 'MP3' };
function card(it, draggable) {
  const gh = it.github;
  const ghRow = gh?.stars != null ? `<div class="gh">
      <span>★ <b>${fmtStars(gh.stars)}</b></span>
      ${gh.language ? `<span>${esc(gh.language)}</span>` : ''}
      ${gh.license ? `<span>${esc(gh.license)}</span>` : ''}
      ${gh.archived ? '<span class="arch">已归档</span>' : ''}
    </div>` : '';
  const isLink = LINK_TYPES.includes(it.type);
  const fav = isLink ? safeUrl(it.favicon) : '';
  const f = it.file;
  const src = f ? `/files/${encodeURIComponent(f.id)}` : '';
  const site = isLink ? it.site : f ? `${f.name} · ${fmtSize(f.size)}` : `${(it.textLength ?? it.text?.length ?? 0)} 字`;
  const title = isLink
    ? `<a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener noreferrer" draggable="false">${esc(it.title)}</a>`
    : `<a href="#" data-act="view" draggable="false">${esc(it.title || f?.name || '（无标题）')}</a>`;
  let body = '';
  if (it.type === 'image') {
    const ratio = f?.width && f?.height ? ` style="aspect-ratio:${f.width}/${f.height}"` : '';
    body = `<button class="thumb" data-act="view" title="查看大图"${ratio}><img src="${src}" alt="" loading="lazy" draggable="false"></button>`;
  } else if (it.type === 'file') {
    const ext = (f?.ext ?? '').toLowerCase();
    body = `<div class="file-row"><span class="file-icon">${esc(FILE_ICON[ext] ?? (ext.toUpperCase() || 'FILE'))}</span>
      <a class="ghost sm" href="${src}?download" draggable="false">下载</a></div>`;
  }
  const desc = it.type === 'text' ? it.text : it.description;
  const copyTitle = { text: '复制文字', image: '复制图片', file: '复制下载链接' }[it.type] ?? '复制链接';
  return `<article class="card kind-${esc(it.type)}${it.pinned ? ' pinned' : ''}" data-id="${esc(it.id)}" ${draggable ? 'draggable="true"' : ''}>
    <div class="top">
      ${draggable ? '<span class="grip" title="拖动排序，可拖到其他分组">⠿</span>' : ''}
      ${fav ? `<img src="${esc(fav)}" alt="" loading="lazy" class="fav">` : ''}
      <span class="site">${esc(site)}</span>
      <span class="type ${esc(it.type)}">${esc(it.type)}</span>
    </div>
    <div class="acts">
      <button data-act="pin" title="${it.pinned ? '取消置顶' : '置顶'}">${it.pinned ? '◆' : '◇'}</button>
      <button data-act="copy" title="${copyTitle}">⧉</button>
      <button data-act="edit" title="编辑">✎</button>
    </div>
    ${it.type === 'image' ? body : ''}
    <h3>${title}</h3>
    ${desc ? `<p class="desc${it.type === 'text' ? ' snippet' : ''}">${esc(desc)}</p>` : ''}
    ${it.type === 'file' ? body : ''}
    ${it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
    ${ghRow}
    <div class="chips">${it.tags.map((t) => `<span data-tag="${esc(t)}">${esc(t)}</span>`).join('')}</div>
    <div class="bottom"><span>${esc(TYPE_LABEL[it.type] ?? it.type)}</span><span>${fmtDate(it.createdAt)}</span></div>
  </article>`;
}

// 分组 → 收藏 → 分组 → 收藏。选中某个分组时只显示那一段
function sections() {
  const list = [...state.groups.map((g) => ({ id: g.id, name: g.name, group: g })), { id: UNGROUPED, name: '未分组' }];
  const byGroup = new Map(list.map((s) => [s.id, []]));
  for (const it of state.items) byGroup.get(it.groupId ?? UNGROUPED)?.push(it);
  const filtering = state.q || state.type || state.tag;
  return list
    .map((s) => ({ ...s, items: byGroup.get(s.id) }))
    .filter((s) => (state.group ? s.id === state.group : true))
    // 筛选时不显示空分组；平时空分组也显示，方便往里拖。未分组为空就不显示
    .filter((s) => s.items.length || (!filtering && s.id !== UNGROUPED) || state.group === s.id);
}

function renderItems() {
  const drag = canDrag();
  const secs = sections();
  $('items').innerHTML = secs.map((s) => {
    const fold = collapsed.has(s.id) && !state.group;
    return `<section class="group${fold ? ' folded' : ''}" data-section="${esc(s.id)}">
      <div class="group-head" ${s.group && drag ? 'draggable="true" data-group-drag' : ''}>
        <button class="fold" data-act="fold" title="${fold ? '展开' : '收起'}">${fold ? '▸' : '▾'}</button>
        <h2>${esc(s.name)}</h2><span class="count">${s.items.length}</span>
        <span class="line"></span>
        ${s.group ? `<span class="gacts">
          <button class="ghost sm" data-act="rename-group">重命名</button>
          <button class="ghost sm danger" data-act="delete-group">删除</button></span>` : ''}
      </div>
      <div class="group-body" data-drop-list>
        ${s.items.map((it) => card(it, drag)).join('') || '<div class="drop-empty">拖收藏到这里，或者收藏时选择这个分组</div>'}
      </div>
    </section>`;
  }).join('');

  const tip = $('drag-tip');
  tip.hidden = drag || !state.items.length;
  tip.textContent = state.sort !== 'manual'
    ? `当前按「${SORT_LABEL[state.sort]}」排列。切回「自定义顺序」才能拖动排序。`
    : '正在搜索或筛选，清除后才能拖动排序。';

  const total = state.stats.total;
  const empty = !state.items.length && !(state.groups.length && !(state.q || state.type || state.tag));
  $('empty').hidden = !empty;
  if (empty) {
    const filtered = total > 0;
    $('empty').querySelector('h2').textContent = filtered ? '没有找到' : '还没有收藏';
    $('empty').querySelector('p').textContent = filtered
      ? '换个关键词，或者清掉左侧的筛选。'
      : '把 GitHub 项目、Skill、MCP、神秘网站的链接粘贴到上面，或者让 AI 通过 API 帮你收藏。';
  }
}
/* ===== 拖拽排序 =====
   拖卡片：在分组内或跨分组移动，松手后把目标分组的新顺序发给 /api/items/reorder。
   拖到左侧分组名上：移进那个分组。拖分组标题：调整分组顺序。 */
const drag = { kind: null, el: null, from: null, pending: false };

function insertPoint(container, selector, x, y, horizontal) {
  // 找到指针之后的第一个元素，插在它前面；没有就放最后
  for (const el of container.querySelectorAll(selector)) {
    if (el === drag.el) continue;
    const r = el.getBoundingClientRect();
    if (horizontal) {
      if (y < r.top) return el;
      if (y <= r.bottom && x < r.left + r.width / 2) return el;
    } else if (y < r.top + r.height / 2) return el;
  }
  return null;
}

document.addEventListener('dragstart', (e) => {
  const head = e.target.closest?.('[data-group-drag]');
  const c = e.target.closest?.('.card[draggable]');
  if (head) {
    drag.kind = 'group';
    drag.el = head.closest('.group');
  } else if (c) {
    drag.kind = 'card';
    drag.el = c;
    drag.from = c.closest('.group').dataset.section;
  } else return;
  drag.el.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', drag.kind === 'card' ? drag.el.dataset.id : '');
});

document.addEventListener('dragover', (e) => {
  if (!drag.kind) return;
  document.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'));
  if (drag.kind === 'card') {
    const side = e.target.closest('[data-drop-group]');
    if (side) { e.preventDefault(); side.classList.add('drop-on'); return; }
    const body = e.target.closest('[data-drop-list]');
    if (!body) return;
    e.preventDefault();
    const horizontal = document.body.classList.contains('layout-grid');
    const before = insertPoint(body, '.card', e.clientX, e.clientY, horizontal);
    body.querySelector('.drop-empty')?.remove();
    if (before) { if (before !== drag.el.nextSibling) body.insertBefore(drag.el, before); }
    else if (body.lastElementChild !== drag.el) body.appendChild(drag.el);
  } else {
    if (!e.target.closest('#items')) return;
    e.preventDefault();
    const before = insertPoint($('items'), '.group', e.clientX, e.clientY, false);
    // 未分组始终在最后
    const tail = $('items').querySelector(`[data-section="${UNGROUPED}"]`);
    $('items').insertBefore(drag.el, before ?? tail);
  }
});

document.addEventListener('drop', async (e) => {
  if (!drag.kind) return;
  e.preventDefault();
  // 先把拖拽状态取出来再清掉：dragend 会在下面的 await 期间触发
  const { kind, el, from } = drag;
  const side = kind === 'card' && e.target.closest('[data-drop-group]');
  let req;
  if (side) {
    const gid = side.dataset.group === UNGROUPED ? null : side.dataset.group;
    req = [`/api/items/${el.dataset.id}`, 'PATCH', { groupId: gid }, `已移到「${side.querySelector('span').textContent}」`];
  } else if (kind === 'card') {
    const sec = el.closest('.group');
    const to = sec.dataset.section;
    const ids = [...sec.querySelectorAll('.card')].map((c) => c.dataset.id);
    req = ['/api/items/reorder', 'POST', { groupId: to === UNGROUPED ? null : to, ids },
      to !== from ? `已移到「${sec.querySelector('h2').textContent}」` : ''];
  } else {
    const ids = [...$('items').querySelectorAll('.group')].map((s) => s.dataset.section).filter((id) => id !== UNGROUPED);
    req = ['/api/groups/reorder', 'POST', { ids }, ''];
  }
  resetDrag();
  try {
    await api(req[0], { method: req[1], body: req[2] });
    if (req[3]) toast(req[3]);
  } catch (err) { toast(err.message); }
  load();
});

// 拖到页面外松手、或按 Esc 取消：恢复原样
document.addEventListener('dragend', () => { if (drag.kind) { resetDrag(); load(); } });

function resetDrag() {
  drag.el?.classList.remove('dragging');
  document.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'));
  drag.kind = drag.el = drag.from = null;
}
/* ===== 分组名输入框 ===== */
function askName({ title = 'GROUP · 新建分组', value = '' } = {}) {
  const dlg = $('name-dlg');
  const input = dlg.querySelector('input');
  $('name-kicker').textContent = title;
  input.value = value;
  dlg.returnValue = '';
  dlg.showModal();
  input.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null), { once: true });
  });
}

async function newGroup() {
  const name = await askName();
  if (!name) return null;
  try {
    const { group } = await api('/api/groups', { method: 'POST', body: { name } });
    toast(`已新建分组「${group.name}」`);
    await load();
    return group;
  } catch (e) { toast(e.message); return null; }
}

/* ===== 收藏 ===== */
function savedToast(r, what) {
  if (r.duplicate) return toast(`已经收藏过：${r.item.title}`);
  const g = state.groups.find((x) => x.id === r.item.groupId);
  const where = r.autoGroup ? `自动归入「${r.autoGroup.name}」${r.autoGroup.created ? '（新分组）' : ''}`
    : g ? `收藏到「${g.name}」` : '已收藏';
  toast(`${where}：${what ?? r.item.title}`);
}

const busy = (on) => $('add').classList.toggle('busy', on);
const URL_ONLY = /^(https?:\/\/\S+\s*)+$/i;

// 一段文字：整段都是链接就逐个收藏链接，否则作为文字片段收藏
async function addText(raw) {
  const text = raw.trim();
  if (!text) return;
  busy(true);
  try {
    if (URL_ONLY.test(text)) {
      for (const url of text.split(/\s+/)) savedToast(await api('/api/items', { method: 'POST', body: { url, ...groupParams() } }));
    } else {
      savedToast(await api('/api/items', { method: 'POST', body: { text, ...groupParams() } }), '文字片段');
    }
    $('url').value = '';
    await load();
  } catch (e) { toast(`收藏失败：${e.message}`); } finally { busy(false); }
}

// 剪贴板里的截图没有文件名（Chrome 叫 image.png），按本地时间起一个
function fileName(file) {
  if (file.name && !/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return file.name;
  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  return `截图 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${ext}`;
}

async function uploadFiles(list) {
  const files = [...list].filter((f) => f.size > 0);
  if (!files.length) return toast('没有可以收藏的文件（文件夹不支持）');
  busy(true);
  try {
    for (const [i, file] of files.entries()) {
      const name = fileName(file);
      toast(`正在上传${files.length > 1 ? ` ${i + 1}/${files.length}` : ''}：${name}`);
      const q = new URLSearchParams({ name, ...groupParams() });
      // 一律用 octet-stream：text/plain 这类类型会被服务端当成表单拒绝
      savedToast(await api(`/api/upload?${q}`, { method: 'POST', rawBody: file }), name);
    }
    await load();
  } catch (e) { toast(`上传失败：${e.message}`); } finally { busy(false); }
}

$('add').addEventListener('submit', (e) => { e.preventDefault(); addText($('url').value); });
$('pick-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
$('add-group').addEventListener('change', async (e) => {
  if (e.target.value === NEW) {
    const g = await newGroup();
    e.target.value = g?.id ?? AUTO;
  }
  localStorage.setItem('cf-add-group', e.target.value);
});

// 粘贴：截图（PrtSc、QQ、微信、Snipaste）、复制的图片和文件 → 上传；链接 → 收藏链接；其他文字 → 文字片段。
// 在收藏框里粘贴文字照常填进输入框，粘贴图片和文件也会直接上传
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  const files = [...cd.files];
  const inAdd = e.target.id === 'url';
  const inOther = !inAdd && e.target.closest('input,textarea,[contenteditable]');
  if (inOther || document.querySelector('dialog[open]')) return;
  if (files.length) { e.preventDefault(); return uploadFiles(files); }
  if (inAdd) return;
  const text = cd.getData('text/plain');
  if (!text.trim()) return;
  e.preventDefault();
  addText(text);
});

// 从桌面或资源管理器把文件拖进页面
let dropDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (drag.kind || !hasFiles(e)) return;
  dropDepth++;
  $('drop-mask').hidden = false;
});
document.addEventListener('dragleave', (e) => {
  if (drag.kind || !hasFiles(e)) return;
  if (--dropDepth <= 0) { dropDepth = 0; $('drop-mask').hidden = true; }
});
document.addEventListener('dragover', (e) => { if (!drag.kind && hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (drag.kind || !hasFiles(e)) return;
  e.preventDefault();
  dropDepth = 0;
  $('drop-mask').hidden = true;
  uploadFiles(e.dataTransfer.files);
});

/* ===== 查看：大图、全文、文件内容 ===== */
async function openViewer(id) {
  const { item: it } = await api(`/api/items/${id}`);
  const f = it.file;
  const src = f ? `/files/${encodeURIComponent(f.id)}` : '';
  $('viewer-kind').textContent = `${(TYPE_LABEL[it.type] ?? it.type)}${f ? ` · ${fmtSize(f.size)}` : ''}`;
  $('viewer-title').textContent = it.title || f?.name || '';
  $('viewer-download').hidden = !f;
  if (f) $('viewer-download').href = `${src}?download`;
  $('viewer-copy').hidden = it.type === 'file';
  $('viewer-copy').onclick = () => copyItem(it);
  const body = $('viewer-body');
  if (it.type === 'image') body.innerHTML = `<img src="${src}" alt="">`;
  else if (it.text) body.innerHTML = `<pre>${esc(it.text)}</pre>`;
  else body.innerHTML = '<p class="hint">这个文件没有可以预览的文字，点“下载”打开。</p>';
  $('viewer').showModal();
}

async function copyItem(it) {
  try {
    if (it.type === 'text') {
      const full = it.truncated ? (await api(`/api/items/${it.id}`)).item.text : it.text;
      await navigator.clipboard.writeText(full);
      return toast('文字已复制');
    }
    if (it.type === 'image') {
      // 剪贴板只认 PNG，其他格式先画到 canvas 上转一下
      const blob = await fetch(`/files/${encodeURIComponent(it.file.id)}`).then((r) => r.blob());
      const png = blob.type === 'image/png' ? blob : await toPng(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      return toast('图片已复制，可以直接粘贴到 QQ、微信');
    }
    if (it.type === 'file') {
      await navigator.clipboard.writeText(new URL(`/files/${it.file.id}?download`, location.href).href);
      return toast('下载链接已复制');
    }
    await navigator.clipboard.writeText(it.url);
    toast('链接已复制');
  } catch (e) { toast(`复制失败：${e.message}`); }
}

async function toPng(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

/* ===== 交互 ===== */
document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]');
  if (act) {
    const sec = act.closest('.group')?.dataset.section;
    switch (act.dataset.act) {
      case 'new-group': return newGroup();
      case 'fold':
        collapsed.has(sec) ? collapsed.delete(sec) : collapsed.add(sec);
        localStorage.setItem('cf-collapsed', JSON.stringify([...collapsed]));
        return renderItems();
      case 'rename-group': {
        const g = state.groups.find((x) => x.id === sec);
        const name = await askName({ title: 'GROUP · 重命名分组', value: g.name });
        if (!name || name === g.name) return;
        try { await api(`/api/groups/${sec}`, { method: 'PATCH', body: { name } }); } catch (err) { toast(err.message); }
        return load();
      }
      case 'delete-group': {
        const g = state.groups.find((x) => x.id === sec);
        if (!confirm(`删除分组「${g.name}」？里面的 ${g.count} 个收藏会移到“未分组”，不会被删除。`)) return;
        await api(`/api/groups/${sec}`, { method: 'DELETE' });
        toast(`已删除分组「${g.name}」`);
        return load();
      }
    }
    const id = act.closest('.card')?.dataset.id;
    const it = state.items.find((x) => x.id === id);
    if (!it) return;
    if (act.dataset.act === 'pin') { await api(`/api/items/${id}`, { method: 'PATCH', body: { pinned: !it.pinned } }); return load(); }
    if (act.dataset.act === 'copy') return copyItem(it);
    if (act.dataset.act === 'edit') return openEditor(it);
    if (act.dataset.act === 'view') { e.preventDefault(); return openViewer(id); }
  }
  const groupA = e.target.closest('[data-group]');
  if (groupA) { state.group = groupA.dataset.group; renderSide(); return renderItems(); }
  const typeA = e.target.closest('[data-type]');
  if (typeA) { state.type = typeA.dataset.type; return load(); }
  const tagA = e.target.closest('[data-tag]');
  if (tagA) { state.tag = state.tag === tagA.dataset.tag ? '' : tagA.dataset.tag; return load(); }
  const lay = e.target.closest('#layout-switch button');
  if (lay) return patchTheme({ layout: lay.dataset.layout });
  const pre = e.target.closest('[data-preset]');
  if (pre) return patchTheme({ preset: pre.dataset.preset });
});

let qTimer;
$('q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 200); });
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; load(); });

async function patchTheme(patch) {
  try { applyTheme((await api('/api/theme', { method: 'PATCH', body: patch })).theme); } catch (e) { toast(e.message); }
}
$('settings-btn').addEventListener('click', () => { renderSystem(); $('settings').showModal(); });
$('theme-undo').addEventListener('click', async () => {
  try { applyTheme((await api('/api/theme/undo', { method: 'POST', body: {} })).theme); toast('已撤销'); } catch (e) { toast(e.message); }
});
$('theme-reset').addEventListener('click', async () => {
  applyTheme((await api('/api/theme/reset', { method: 'POST', body: {} })).theme); toast('已恢复默认主题');
});

/* ===== 编辑 ===== */
const form = $('edit-form');
form.elements.type.innerHTML = LINK_TYPES.map((k) => `<option value="${k}">${TYPE_LABEL[k]}</option>`).join('');
let editing = null;
async function openEditor(it) {
  if (it.truncated) it = (await api(`/api/items/${it.id}`)).item;
  editing = it;
  const isLink = LINK_TYPES.includes(it.type);
  $('f-url').hidden = !isLink;
  $('f-type').hidden = !isLink;
  $('edit-refresh').hidden = !isLink;
  $('f-text').hidden = it.type !== 'text';
  form.elements.groupId.innerHTML = groupOptions(it.groupId);
  for (const k of ['title', 'url', 'type', 'description', 'note', 'text']) form.elements[k].value = it[k] ?? '';
  form.elements.groupId.value = it.groupId ?? '';
  form.elements.tags.value = it.tags.join(' ');
  $('editor').showModal();
}
$('editor').addEventListener('close', async () => {
  const action = $('editor').returnValue;
  const id = editing?.id;
  if (!id) return;
  try {
    if (action === 'save') {
      const el = form.elements;
      const body = {
        title: el.title.value, groupId: el.groupId.value || null,
        description: el.description.value, note: el.note.value,
        tags: el.tags.value.split(/[\s,，]+/).filter(Boolean),
      };
      if (LINK_TYPES.includes(editing.type)) Object.assign(body, { url: el.url.value, type: el.type.value });
      if (editing.type === 'text') body.text = el.text.value;
      await api(`/api/items/${id}`, { method: 'PATCH', body });
      toast('已保存');
    } else if (action === 'delete') {
      if (!confirm(`删除「${editing.title}」？`)) return;
      await api(`/api/items/${id}`, { method: 'DELETE' });
      toast('已删除');
    } else if (action === 'refresh') {
      await api(`/api/items/${id}/refresh`, { method: 'POST', body: {} });
      toast('已重新抓取');
    }
  } catch (e) { toast(e.message); } finally { editing = null; }
  load();
});

/* ===== 实时同步：AI 改了什么，这里马上就变 ===== */
function listen() {
  const es = new EventSource('/api/events');
  let t;
  // 正在拖的时候不刷新，免得把拖到一半的卡片弹回去
  es.addEventListener('items', () => { clearTimeout(t); t = setTimeout(() => { if (!drag.kind) load(); }, 120); });
  es.addEventListener('theme', (e) => applyTheme(JSON.parse(e.data)));
}

(async function init() {
  state.auth = await api('/api/auth/status');
  if (!state.auth.loggedIn) return void (location.href = '/login');
  applyTheme((await api('/api/theme')).theme);
  await load();
  listen();
})();

// 网站图标加载失败就去掉（CSP 不允许写 onerror 内联脚本，统一在这里处理）
document.addEventListener('error', (e) => { if (e.target.matches?.('img.fav')) e.target.remove(); }, true);
