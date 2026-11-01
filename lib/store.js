// 存储：一个 JSON 文件，写入时先写临时文件再改名，进程崩了也不会写坏。
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { defaultTheme } from './theme.js';

const THEME_HISTORY = 30;

export class Store {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    this.data.version ??= 1;
    this.data.items ??= [];
    this.data.groups ??= [];
    this.data.theme = { ...defaultTheme(), ...this.data.theme };
    this.data.themeHistory ??= [];
    // 旧数据没有分组和顺序：全部放进“未分组”，按原来的先后排
    this.data.items.forEach((it, i) => { it.groupId ??= null; it.order ??= i; });
    this.save();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  get items() { return this.data.items; }
  get groups() { return this.data.groups; }
  get theme() { return this.data.theme; }

  find(id) { return this.items.find((i) => i.id === id); }
  findByUrl(url) { return this.items.find((i) => i.url && normalizeUrl(i.url) === normalizeUrl(url)); }
  findByHash(sha256) { return this.items.find((i) => i.file?.sha256 === sha256); }
  findByText(text) { return this.items.find((i) => i.type === 'text' && i.text === text); }

  add(item) {
    const now = new Date().toISOString();
    const groupId = item.groupId ?? null;
    // 新收藏放在分组最前面
    const first = Math.min(0, ...this.items.filter((i) => i.groupId === groupId).map((i) => i.order));
    const full = { id: newId(), pinned: false, note: '', tags: [], ...item, groupId, order: first - 1, createdAt: now, updatedAt: now };
    this.items.unshift(full);
    this.save();
    return full;
  }

  update(id, patch) {
    const item = this.find(id);
    if (!item) return null;
    if ('groupId' in patch && patch.groupId !== item.groupId) {
      patch.order = Math.min(0, ...this.items.filter((i) => i.groupId === patch.groupId).map((i) => i.order)) - 1;
    }
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return item;
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.save();
    return true;
  }

  // 把 ids 按给定顺序排进 groupId 分组（可以从别的分组拖过来）
  reorderItems(groupId, ids) {
    const moved = [];
    ids.forEach((id, order) => {
      const it = this.find(id);
      if (!it) return;
      it.groupId = groupId;
      it.order = order;
      moved.push(id);
    });
    this.save();
    return moved;
  }

  /* ===== 分组 ===== */
  findGroup(id) { return this.groups.find((g) => g.id === id); }
  findGroupByName(name) {
    const n = name.trim().toLowerCase();
    return this.groups.find((g) => g.name.toLowerCase() === n);
  }

  addGroup(name) {
    const order = Math.max(-1, ...this.groups.map((g) => g.order)) + 1;
    const g = { id: newId(), name: name.trim(), order, createdAt: new Date().toISOString() };
    this.groups.push(g);
    this.save();
    return g;
  }

  renameGroup(id, name) {
    const g = this.findGroup(id);
    if (!g) return null;
    g.name = name.trim();
    this.save();
    return g;
  }

  // 删分组不删收藏，收藏回到“未分组”
  removeGroup(id) {
    const i = this.groups.findIndex((g) => g.id === id);
    if (i < 0) return 0;
    this.groups.splice(i, 1);
    let n = 0;
    for (const it of this.items) if (it.groupId === id) { it.groupId = null; n++; }
    this.save();
    return n;
  }

  reorderGroups(ids) {
    ids.forEach((id, order) => { const g = this.findGroup(id); if (g) g.order = order; });
    // 没列出的分组排到后面，保持原相对顺序
    const rest = this.groups.filter((g) => !ids.includes(g.id)).sort((a, b) => a.order - b.order);
    rest.forEach((g, i) => { g.order = ids.length + i; });
    this.groups.sort((a, b) => a.order - b.order);
    this.save();
  }

  setTheme(theme) {
    this.data.themeHistory.push(this.data.theme);
    this.data.themeHistory = this.data.themeHistory.slice(-THEME_HISTORY);
    this.data.theme = theme;
    this.save();
  }

  undoTheme() {
    const prev = this.data.themeHistory.pop();
    if (!prev) return null;
    this.data.theme = prev;
    this.save();
    return prev;
  }
}

function newId() { return randomBytes(5).toString('hex'); }

export function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    let s = x.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.replace(/^http:/, 'https:').replace('://www.', '://').toLowerCase();
  } catch { return u; }
}
