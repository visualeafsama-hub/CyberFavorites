// 新建收藏：链接、文字片段、上传的文件（图片、截图、docx…）。三种都走同一套分组逻辑：
//   none  不分组
//   pick  指定分组（groupId，或分组名 group，不存在就新建）
//   auto  自动分组：挑最像的已有分组，都不像就按类型归入“图片”“文件”这类分组
import { collect, autoTags, TYPES } from './meta.js';
import { suggestGroup } from './autogroup.js';
import { extractText, canExtract } from './extract.js';
import { RASTER } from './files.js';
import { HttpError } from './http.js';
import { SERVER } from './config.js';

export const GROUP_MODES = ['none', 'pick', 'auto'];
export const MAX_TEXT_ITEM = 200_000;
const SCREENSHOT_RE = /截图|截屏|屏幕截图|screenshot|snipaste|微信图片|qq图片|wechat|image\.png/i;

export function cleanTags(tags) {
  if (!Array.isArray(tags)) throw new HttpError(400, 'tags 必须是字符串数组');
  return [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

export function cleanName(name) {
  const n = String(name ?? '').trim();
  if (!n || n.length > 40) throw new HttpError(400, '分组名必须是 1–40 个字符');
  return n;
}

export function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new HttpError(400, `不是合法链接：${raw}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, '只支持 http/https 链接');
  return u.toString();
}

export class Items {
  constructor(store, files) {
    this.store = store;
    this.files = files;
  }

  checkGroup(id) {
    if (id === null || id === undefined || id === '') return null;
    if (!this.store.findGroup(id)) throw new HttpError(400, `没有 id 为 ${id} 的分组，GET /api/groups 查看`);
    return id;
  }

  // 解析分组参数。没写 groupMode 时：传了 groupId / group 就是 pick，否则 none
  groupPlan(p) {
    const mode = p.groupMode || ((p.groupId ?? '') !== '' || p.group ? 'pick' : 'none');
    if (!GROUP_MODES.includes(mode)) throw new HttpError(400, `groupMode 可选：${GROUP_MODES.join(', ')}`);
    if (mode !== 'pick') return { mode };
    if ((p.groupId ?? '') !== '') return { mode, groupId: this.checkGroup(p.groupId) };
    if (p.group) return { mode, name: cleanName(p.group) };
    throw new HttpError(400, '指定分组时要传 groupId 或分组名 group');
  }

  // 收藏的信息都齐了以后再落分组：自动分组要看标题、标签这些
  resolveGroup(plan, draft) {
    if (plan.mode === 'none') return { groupId: null };
    if (plan.mode === 'pick') {
      if (plan.groupId !== undefined) return { groupId: plan.groupId };
      const g = this.store.findGroupByName(plan.name) ?? this.store.addGroup(plan.name);
      return { groupId: g.id };
    }
    const s = suggestGroup(draft, this.store.groups, this.store.items);
    if (s.groupId) return { groupId: s.groupId, auto: { name: s.name, created: false, reason: s.reason } };
    const existing = this.store.findGroupByName(s.name);
    const g = existing ?? this.store.addGroup(s.name);
    return { groupId: g.id, auto: { name: g.name, created: !existing, reason: s.reason } };
  }

  finish(draft, plan, extra) {
    const { groupId, auto } = this.resolveGroup(plan, draft);
    const item = this.store.add({ ...draft, groupId });
    return { status: 201, body: { duplicate: false, item, ...(auto ? { autoGroup: auto } : {}) } };
  }

  common(body) {
    return {
      ...(body.note ? { note: String(body.note).slice(0, 5000) } : {}),
      ...(body.title ? { title: String(body.title).slice(0, 200) } : {}),
    };
  }

  async addLink(body) {
    const url = checkUrl(body.url);
    const plan = this.groupPlan(body);
    const dup = this.store.findByUrl(url);
    if (dup) return { status: 200, body: { duplicate: true, item: dup } };
    // 本机模式可以收藏局域网地址（NAS、路由器页面）；服务器模式不行，防止被拿来探测服务器内网
    const meta = await collect(url, { allowPrivate: !SERVER });
    const extra = body.tags ? cleanTags(body.tags) : [];
    const draft = { ...meta, tags: [...new Set([...meta.tags, ...extra])], ...this.common(body) };
    if (body.type) {
      if (!TYPES.includes(body.type)) throw new HttpError(400, `type 可选：${TYPES.join(', ')}`);
      Object.assign(draft, { type: body.type, typeLocked: true });
    }
    return this.finish(draft, plan);
  }

  addText(body) {
    const text = String(body.text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new HttpError(400, 'text 不能为空');
    if (text.length > MAX_TEXT_ITEM) throw new HttpError(413, `文字太长，上限 ${MAX_TEXT_ITEM} 字`);
    const plan = this.groupPlan(body);
    const dup = this.store.findByText(text);
    if (dup) return { status: 200, body: { duplicate: true, item: dup } };
    const firstLine = text.split('\n').find((l) => l.trim())?.trim() ?? '';
    const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    const draft = { type: 'text', title, text, url: '', site: '', description: '', favicon: '', image: '', ...this.common(body) };
    const extra = body.tags ? cleanTags(body.tags) : [];
    draft.tags = [...new Set([...autoTags({ title, description: text.slice(0, 1000) }), ...extra])];
    return this.finish(draft, plan);
  }

  // upload 是 FileStore.receive 的结果；p 是查询参数（name、groupMode、groupId、group、note、title、tags）
  addFile(upload, p) {
    let plan;
    try { plan = this.groupPlan(p); } catch (e) { this.files.discard(upload); throw e; }
    const dup = this.store.findByHash(upload.sha256);
    if (dup) {
      this.files.discard(upload);
      return { status: 200, body: { duplicate: true, item: dup } };
    }
    const file = this.files.commit(upload, p.name || '');
    const image = RASTER.has(file.ext) || file.ext === 'svg';
    const text = !image && canExtract(file.name) ? extractText(this.files.read(file), file.name) : '';
    const tags = new Set(p.tags ? cleanTags(String(p.tags).split(/[\s,，]+/)) : []);
    if (file.ext) tags.add(file.ext === 'jpeg' ? 'jpg' : file.ext);
    if (image && SCREENSHOT_RE.test(file.name)) tags.add('screenshot');
    const draft = {
      type: image ? 'image' : 'file',
      title: file.name.replace(/\.[a-z0-9]{1,10}$/i, ''),
      description: text ? text.slice(0, 300) : '',
      url: '', site: '', favicon: '', image: '',
      file, text, tags: [...tags],
      ...this.common(p),
    };
    return this.finish(draft, plan);
  }
}
