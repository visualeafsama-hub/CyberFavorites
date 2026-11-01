// 数据接口：收藏、分组、标签、搜索、主题、上传、导出、SSE。认证在 server.js 里做完才会进到这里。
import { HttpError, send, readJson } from './http.js';
import { collect, autoTags, TYPES, LINK_TYPES } from './meta.js';
import { search } from './search.js';
import * as launcher from './launcher.js';
import { applyThemePatch, defaultTheme, ThemeError, PRESETS, COLOR_KEYS, ENUMS } from './theme.js';
import { cleanTags, cleanName, checkUrl, MAX_TEXT_ITEM } from './items.js';
import { SERVER, MAX_UPLOAD } from './config.js';

const EDITABLE = ['title', 'description', 'note', 'tags', 'type', 'pinned', 'url', 'groupId', 'text'];
const PREVIEW = 600;
// 表单能跨站直接提交的三种类型，上传接口不接受，挡掉 CSRF
const FORM_TYPES = ['multipart/form-data', 'application/x-www-form-urlencoded', 'text/plain'];

export const API_DOC = {
  name: 'CyberFavorites API',
  note: '写操作用 JSON 请求体（上传除外）。修改后网页会通过 SSE 实时刷新。服务器模式要带 Authorization: Bearer <API 令牌>。详细说明见 SKILL.md',
  types: TYPES,
  groupModes: { none: '不分组', pick: '指定分组（groupId 或分组名 group）', auto: '自动分组' },
  endpoints: [
    'GET    /api/items?q=&group=<id|none>&type=&tag=&pinned=true&sort=manual|new|old|stars|title  列表里的长文字只给前 600 字',
    'POST   /api/items            {url | text, groupMode?, groupId?, group?, note?, tags?, type?, title?}  收藏链接或文字片段',
    'POST   /api/upload?name=&groupMode=&groupId=&group=&note=&tags=  请求体是文件本身（Content-Type: application/octet-stream）',
    'GET    /api/items/:id        完整内容',
    'PATCH  /api/items/:id        {title?, description?, note?, tags?, type?, pinned?, url?, groupId?, text?}',
    'DELETE /api/items/:id        上传的文件会一起删除',
    'POST   /api/items/:id/refresh  重新抓取链接信息（保留 note、pinned、手动标签）',
    'POST   /api/items/bulk       {ids, addTags?, removeTags?, type?, pinned?, groupId?}',
    'POST   /api/items/reorder    {groupId, ids}  把 ids 按顺序排进分组（可跨分组移动）',
    'POST   /api/items/delete     {ids}',
    'GET    /files/:id[?download] 上传的文件',
    'GET    /api/groups',
    'POST   /api/groups           {name}',
    'PATCH  /api/groups/:id       {name}',
    'DELETE /api/groups/:id       里面的收藏回到未分组',
    'POST   /api/groups/reorder   {ids}',
    'GET    /api/search?q=&limit=  带分数的搜索，返回 score 和命中字段',
    'GET    /api/tags',
    'POST   /api/tags/rename      {from, to}',
    'GET    /api/stats',
    'GET    /api/theme | GET /api/theme/schema | PATCH /api/theme | POST /api/theme/undo | POST /api/theme/reset',
    'GET    /api/system | PATCH /api/system {autostart?, startMenu?, desktop?}  仅本机模式（Windows）',
    'GET    /api/export',
    'GET    /api/events           SSE',
    'GET    /api/auth/status',
  ],
};

export function createApi({ store, files, items, broadcast, clients, launcherOpts }) {
  const groupName = (id) => store.findGroup(id)?.name ?? '';
  const preview = (it) => (it.text && it.text.length > PREVIEW
    ? { ...it, text: it.text.slice(0, PREVIEW), textLength: it.text.length, truncated: true } : it);

  function cleanPatch(body) {
    const patch = {};
    for (const [k, v] of Object.entries(body)) {
      if (!EDITABLE.includes(k)) throw new HttpError(400, `不能修改字段 "${k}"，可改：${EDITABLE.join(', ')}`);
      if (k === 'tags') patch.tags = cleanTags(v);
      else if (k === 'type') {
        if (!TYPES.includes(v)) throw new HttpError(400, `type 可选：${TYPES.join(', ')}`);
        Object.assign(patch, { type: v, typeLocked: true }); // 手动改过类型，刷新时不再覆盖
      } else if (k === 'pinned') patch.pinned = !!v;
      else if (k === 'url') patch.url = v === '' ? '' : checkUrl(v);
      else if (k === 'groupId') patch.groupId = items.checkGroup(v);
      else if (k === 'text') {
        patch.text = String(v ?? '');
        if (patch.text.length > MAX_TEXT_ITEM) throw new HttpError(413, `文字太长，上限 ${MAX_TEXT_ITEM} 字`);
      } else patch[k] = String(v ?? '').slice(0, k === 'note' ? 5000 : 500);
    }
    return patch;
  }

  function listItems(params) {
    let list = store.items;
    const type = params.get('type'), tag = params.get('tag'), q = params.get('q'), group = params.get('group');
    if (group) list = list.filter((i) => (i.groupId ?? '') === (group === 'none' ? '' : group));
    if (type) list = list.filter((i) => i.type === type);
    if (tag) list = list.filter((i) => i.tags.includes(tag.toLowerCase()));
    if (params.get('pinned') === 'true') list = list.filter((i) => i.pinned);
    if (q) return search(list, q, { limit: 500, groupName }).map((r) => r.item);
    const sort = params.get('sort') ?? 'manual';
    // 自定义顺序：完全按用户拖出来的 order，不再把置顶的往前提
    if (sort === 'manual') return [...list].sort((a, b) => a.order - b.order);
    const sorters = {
      new: (a, b) => b.createdAt.localeCompare(a.createdAt),
      old: (a, b) => a.createdAt.localeCompare(b.createdAt),
      stars: (a, b) => (b.github?.stars ?? -1) - (a.github?.stars ?? -1),
      title: (a, b) => a.title.localeCompare(b.title, 'zh'),
    };
    return [...list].sort((a, b) => (b.pinned - a.pinned) || (sorters[sort] ?? sorters.new)(a, b));
  }

  const groupList = () => [...store.groups].sort((a, b) => a.order - b.order)
    .map((g) => ({ ...g, count: store.items.filter((i) => i.groupId === g.id).length }));

  function tagCounts() {
    const m = new Map();
    for (const i of store.items) for (const t of i.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  function removeItem(id) {
    const it = store.find(id);
    if (!it) return false;
    if (it.file) files.remove(it.file);
    return store.remove(id);
  }

  const created = (r) => {
    if (r.status === 201) broadcast('items', { op: 'add', id: r.body.item.id });
    return r;
  };
  return async function api(req, res, url, parts) {
    const { method } = req;
    const [a, b, c] = parts;

    if (!a) return send(res, 200, API_DOC);

    if (a === 'events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
        'X-Accel-Buffering': 'no' }); // 让 nginx 不要缓冲 SSE
      res.write(': hello\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (a === 'upload' && method === 'POST') {
      const ctype = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!ctype || FORM_TYPES.includes(ctype)) throw new HttpError(415, '上传时请把文件本身作为请求体，Content-Type 用 application/octet-stream 或文件的真实类型');
      const p = Object.fromEntries(url.searchParams);
      const upload = await files.receive(req, MAX_UPLOAD).catch((e) => { throw new HttpError(e.status ?? 400, e.message); });
      const r = created(items.addFile(upload, p));
      return send(res, r.status, r.body);
    }

    if (a === 'items') {
      if (!b && method === 'GET') return send(res, 200, { items: listItems(url.searchParams).map(preview) });
      if (!b && method === 'POST') {
        const body = await readJson(req, 2e6);
        if (body.url && body.text) throw new HttpError(400, 'url 和 text 只能传一个');
        const r = created(body.text !== undefined ? items.addText(body) : await items.addLink(body));
        return send(res, r.status, r.body);
      }
      if (b === 'bulk' && method === 'POST') {
        const body = await readJson(req);
        if (!Array.isArray(body.ids) || !body.ids.length) throw new HttpError(400, 'ids 必须是非空数组');
        const add = body.addTags ? cleanTags(body.addTags) : [];
        const rm = body.removeTags ? cleanTags(body.removeTags) : [];
        if (body.type && !TYPES.includes(body.type)) throw new HttpError(400, `type 可选：${TYPES.join(', ')}`);
        const groupId = 'groupId' in body ? items.checkGroup(body.groupId) : undefined;
        const updated = [], missing = [];
        for (const id of body.ids) {
          const item = store.find(id);
          if (!item) { missing.push(id); continue; }
          item.tags = [...new Set([...item.tags.filter((t) => !rm.includes(t)), ...add])];
          if (body.type) Object.assign(item, { type: body.type, typeLocked: true });
          if ('pinned' in body) item.pinned = !!body.pinned;
          if (groupId !== undefined && item.groupId !== groupId) store.update(item.id, { groupId });
          item.updatedAt = new Date().toISOString();
          updated.push(id);
        }
        store.save();
        broadcast('items', { op: 'bulk', ids: updated });
        return send(res, 200, { updated, missing });
      }
      if (b === 'reorder' && method === 'POST') {
        const body = await readJson(req);
        if (!Array.isArray(body.ids)) throw new HttpError(400, 'ids 必须是数组');
        const moved = store.reorderItems(items.checkGroup(body.groupId ?? null), body.ids);
        broadcast('items', { op: 'reorder', ids: moved });
        return send(res, 200, { moved });
      }
      if (b === 'delete' && method === 'POST') {
        const body = await readJson(req);
        if (!Array.isArray(body.ids)) throw new HttpError(400, 'ids 必须是数组');
        const deleted = body.ids.filter((id) => removeItem(id));
        broadcast('items', { op: 'delete', ids: deleted });
        return send(res, 200, { deleted });
      }
      const item = store.find(b);
      if (!item) throw new HttpError(404, `没有 id 为 ${b} 的收藏`);
      if (c === 'refresh' && method === 'POST') {
        if (!item.url || !LINK_TYPES.includes(item.type)) throw new HttpError(400, '只有链接收藏能重新抓取');
        const meta = await collect(item.url, { allowPrivate: !SERVER });
        const manual = item.tags.filter((t) => !autoTags(item).includes(t));
        const next = store.update(b, { ...meta, tags: [...new Set([...meta.tags, ...manual])],
          type: item.typeLocked ? item.type : meta.type });
        broadcast('items', { op: 'update', id: b });
        return send(res, 200, { item: next });
      }
      if (c) throw new HttpError(404, '未知接口');
      if (method === 'GET') return send(res, 200, { item });
      if (method === 'PATCH') {
        const next = store.update(b, cleanPatch(await readJson(req, 2e6)));
        broadcast('items', { op: 'update', id: b });
        return send(res, 200, { item: next });
      }
      if (method === 'DELETE') {
        removeItem(b);
        broadcast('items', { op: 'delete', ids: [b] });
        return send(res, 200, { deleted: [b] });
      }
    }

    if (a === 'search' && method === 'GET') {
      const limit = Math.min(100, +(url.searchParams.get('limit') ?? 20) || 20);
      const results = search(store.items, url.searchParams.get('q'), { limit, groupName })
        .map((r) => ({ ...r, item: preview(r.item) }));
      return send(res, 200, { results });
    }

    if (a === 'groups') {
      if (!b && method === 'GET') return send(res, 200, { groups: groupList() });
      if (!b && method === 'POST') {
        const name = cleanName((await readJson(req)).name);
        if (store.findGroupByName(name)) throw new HttpError(409, `已经有叫「${name}」的分组`);
        const g = store.addGroup(name);
        broadcast('items', { op: 'groups' });
        return send(res, 201, { group: g });
      }
      if (b === 'reorder' && method === 'POST') {
        const { ids } = await readJson(req);
        if (!Array.isArray(ids)) throw new HttpError(400, 'ids 必须是数组');
        store.reorderGroups(ids);
        broadcast('items', { op: 'groups' });
        return send(res, 200, { groups: groupList() });
      }
      if (!store.findGroup(b)) throw new HttpError(404, `没有 id 为 ${b} 的分组`);
      if (method === 'PATCH') {
        const name = cleanName((await readJson(req)).name);
        const same = store.findGroupByName(name);
        if (same && same.id !== b) throw new HttpError(409, `已经有叫「${name}」的分组`);
        const g = store.renameGroup(b, name);
        broadcast('items', { op: 'groups' });
        return send(res, 200, { group: g });
      }
      if (method === 'DELETE') {
        const released = store.removeGroup(b);
        broadcast('items', { op: 'groups' });
        return send(res, 200, { deleted: b, released });
      }
    }

    if (a === 'system') {
      // 快捷方式是改这台电脑的开始菜单，服务器上没有意义，也不该让远程请求去动
      if (SERVER) return send(res, 200, { supported: false, reason: 'server' });
      if (method === 'GET') return send(res, 200, launcher.status());
      if (method === 'PATCH') {
        const body = await readJson(req);
        try {
          for (const k of ['autostart', 'startMenu', 'desktop']) if (k in body) await launcher.set(k, !!body[k], launcherOpts);
        } catch (e) { throw new HttpError(400, e.message); }
        return send(res, 200, launcher.status());
      }
    }

    if (a === 'tags') {
      if (!b && method === 'GET') return send(res, 200, { tags: tagCounts() });
      if (b === 'rename' && method === 'POST') {
        const { from, to } = await readJson(req);
        const [f] = cleanTags([from ?? '']), [t] = cleanTags([to ?? '']);
        if (!f || !t) throw new HttpError(400, '需要 from 和 to');
        let n = 0;
        for (const i of store.items) {
          if (!i.tags.includes(f)) continue;
          i.tags = [...new Set(i.tags.map((x) => (x === f ? t : x)))];
          n++;
        }
        store.save();
        broadcast('items', { op: 'tags' });
        return send(res, 200, { from: f, to: t, changed: n });
      }
    }

    if (a === 'stats' && method === 'GET') {
      const byType = Object.fromEntries(TYPES.map((t) => [t, store.items.filter((i) => i.type === t).length]));
      return send(res, 200, { total: store.items.length, byType, groups: store.groups.length,
        ungrouped: store.items.filter((i) => !i.groupId).length, tags: tagCounts().length,
        untagged: store.items.filter((i) => !i.tags.length).length,
        fileBytes: store.items.reduce((s, i) => s + (i.file?.size ?? 0), 0) });
    }

    if (a === 'theme') {
      if (!b && method === 'GET') return send(res, 200, { theme: store.theme });
      if (b === 'schema' && method === 'GET') {
        return send(res, 200, {
          presets: PRESETS, colorKeys: COLOR_KEYS, ...ENUMS,
          ranges: { cardWidth: [220, 520], radius: [0, 28] }, decor: ['rose', 'rays'],
          customCss: '任意 CSS，追加在样式表最后。页面结构见 SKILL.md 的“页面结构”一节',
        });
      }
      if (!b && method === 'PATCH') {
        let next;
        try { next = applyThemePatch(store.theme, await readJson(req)); } catch (e) {
          if (e instanceof ThemeError) throw new HttpError(400, e.message);
          throw e;
        }
        store.setTheme(next);
        broadcast('theme', next);
        return send(res, 200, { theme: next });
      }
      if (b === 'undo' && method === 'POST') {
        const prev = store.undoTheme();
        if (!prev) throw new HttpError(409, '没有可撤销的主题修改');
        broadcast('theme', prev);
        return send(res, 200, { theme: prev });
      }
      if (b === 'reset' && method === 'POST') {
        store.setTheme(defaultTheme());
        broadcast('theme', store.theme);
        return send(res, 200, { theme: store.theme });
      }
    }

    if (a === 'export' && method === 'GET') {
      return send(res, 200, { groups: store.groups, items: store.items, theme: store.theme,
        note: '上传的文件不在这里，在数据目录的 files/ 文件夹，备份时一起复制' });
    }

    throw new HttpError(404, `未知接口 ${method} ${url.pathname}，GET /api 查看全部接口`);
  };
}
