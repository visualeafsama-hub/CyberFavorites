// 粘贴链接后的自动处理：抓网页 meta、GitHub 仓库信息、判断类型、打初始标签。
// 抓取失败不影响收藏，最多就是只剩一个 URL。
import { safeGet } from './net.js';

const UA = 'CyberFavorites/0.1 (+https://github.com)';
const TIMEOUT = 8000;
const MAX_HTML = 512 * 1024;

export const LINK_TYPES = ['repo', 'skill', 'mcp', 'site', 'article', 'tool'];
// image / file / text 不是链接：上传的图片和文件、粘贴的文字
export const TYPES = [...LINK_TYPES, 'image', 'file', 'text'];

// allowPrivate：本机模式允许抓内网地址（比如收藏局域网 NAS 页面），服务器模式不允许
export async function collect(url, { allowPrivate = false } = {}) {
  const out = { url, type: 'site', title: '', description: '', favicon: '', image: '', site: '', tags: [] };
  const u = new URL(url);
  out.site = u.hostname.replace(/^www\./, '');

  const gh = parseGithub(u);
  if (gh) {
    const info = await githubRepo(gh.owner, gh.repo).catch(() => null);
    out.favicon = 'https://github.githubassets.com/favicons/favicon.svg';
    out.title = gh.path ? `${gh.owner}/${gh.repo} · ${gh.path.split('/').pop()}` : `${gh.owner}/${gh.repo}`;
    if (info) {
      out.description = info.description ?? '';
      out.image = `https://opengraph.githubassets.com/1/${gh.owner}/${gh.repo}`;
      out.github = {
        owner: gh.owner, repo: gh.repo, path: gh.path || '',
        stars: info.stargazers_count, forks: info.forks_count, language: info.language,
        topics: info.topics ?? [], license: info.license?.spdx_id && info.license.spdx_id !== 'NOASSERTION' ? info.license.spdx_id : null,
        archived: info.archived, pushedAt: info.pushed_at,
      };
    } else {
      out.github = { owner: gh.owner, repo: gh.repo, path: gh.path || '' };
    }
  } else {
    Object.assign(out, await pageMeta(u, allowPrivate).catch(() => ({})));
    if (!out.favicon) out.favicon = `${u.origin}/favicon.ico`;
  }

  out.type = classify(out);
  out.tags = autoTags(out);
  if (!out.title) out.title = out.site + (u.pathname !== '/' ? u.pathname : '');
  return out;
}

function parseGithub(u) {
  if (u.hostname !== 'github.com') return null;
  const [owner, repo, kind, , ...rest] = u.pathname.split('/').filter(Boolean);
  if (!owner || !repo || ['orgs', 'topics', 'settings', 'marketplace', 'features'].includes(owner)) return null;
  // /owner/repo/tree/main/skills/foo 这种指向仓库里某个目录（常见于 skill 合集）
  const path = (kind === 'tree' || kind === 'blob') ? rest.join('/') : '';
  return { owner, repo: repo.replace(/\.git$/, ''), path };
}

async function githubRepo(owner, repo) {
  const headers = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await safeGet(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers, timeout: TIMEOUT });
  if (r.status !== 200) throw new Error(`GitHub API ${r.status}`);
  return JSON.parse(r.body.toString('utf8'));
}

async function pageMeta(u, allowPrivate) {
  const r = await safeGet(u, { allowPrivate, timeout: TIMEOUT, maxBytes: MAX_HTML,
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.5', 'Accept-Encoding': 'gzip, br, deflate' } });
  const ctype = r.headers['content-type'] ?? '';
  if (r.status >= 400 || !ctype.includes('html')) return {};
  const html = decodeHtml(r.body, ctype);
  const head = html.slice(0, html.search(/<\/head>/i) + 1 || html.length);
  const meta = (name) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
    const tag = head.match(re)?.[0];
    return tag ? decode(tag.match(/content=["']([^"']*)["']/i)?.[1] ?? '') : '';
  };
  const icon = head.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/i)?.[1];
  const abs = (p) => { try { return p ? new URL(decode(p), r.url).toString() : ''; } catch { return ''; } };
  return {
    title: (meta('og:title') || decode(head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '')).trim().slice(0, 200),
    description: (meta('og:description') || meta('description')).trim().slice(0, 500),
    image: abs(meta('og:image')),
    favicon: abs(icon),
    siteName: meta('og:site_name'),
    ogType: meta('og:type'),
  };
}

// 先看响应头里的 charset，再看页面里的 <meta charset>，都没有就按 UTF-8。不少国内网站还是 GBK
function decodeHtml(buf, ctype) {
  const sniff = buf.subarray(0, 2048).toString('latin1');
  const cs = (ctype.match(/charset=([\w-]+)/i)?.[1] ?? sniff.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8').toLowerCase();
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder().decode(buf); }
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

const SKILL_RE = /\b(agent[- ]?skills?|claude[- ]?skills?|skill\.md|skills?)\b/i;
const MCP_RE = /\b(mcp|model[- ]context[- ]protocol)\b/i;

export function classify(item) {
  const topics = item.github?.topics ?? [];
  const hay = [item.title, item.description, item.url, ...topics].join(' ');
  if (MCP_RE.test(hay) || topics.some((t) => t.startsWith('mcp'))) return 'mcp';
  if (SKILL_RE.test(hay) || /\/skills?\//i.test(item.url)) return 'skill';
  if (item.github) return 'repo';
  if (item.ogType === 'article' || /\/(blog|posts?|article|p)\//i.test(item.url)) return 'article';
  return 'site';
}

// 关键词 → 标签。只做粗分，细的交给 AI 用 /api/items/bulk 和 /api/tags/rename 整理
const KEYWORDS = {
  'ai': /\b(ai|llm|gpt|claude|gemini|agent|openai|anthropic)\b|大模型|智能体/i,
  'agent': /\bagents?\b|智能体/i,
  'claude-code': /claude[- ]code/i,
  'frontend': /\b(react|vue|svelte|css|tailwind|frontend|ui kit)\b|前端/i,
  'backend': /\b(api|server|backend|database|postgres|redis)\b|后端/i,
  'devtools': /\b(cli|devtools?|terminal|vscode|editor|debug)\b/i,
  'design': /\b(design|figma|icons?|fonts?|color)\b|设计/i,
  'self-hosted': /self[- ]hosted|自托管/i,
  'automation': /\b(automation|workflow|crawler|scraper|bot)\b|自动化|爬虫/i,
  'learning': /\b(tutorial|course|awesome|roadmap|guide|learn)\b|教程|学习/i,
  'robotics': /\b(robot|ros|robotics|slam)\b|机器人/i,
  'vision': /\b(opencv|vision|yolo|detection)\b|视觉/i,
};

export function autoTags(item) {
  const tags = new Set();
  if (item.github?.language) tags.add(item.github.language.toLowerCase());
  for (const t of (item.github?.topics ?? []).slice(0, 5)) tags.add(t.toLowerCase());
  const hay = [item.title, item.description].join(' ');
  for (const [tag, re] of Object.entries(KEYWORDS)) if (re.test(hay)) tags.add(tag);
  tags.delete(item.type);
  return [...tags].slice(0, 8);
}
