// 自动分组：给新收藏挑一个最合适的已有分组。
// 打分依据：分组名里的词出现在收藏的标题/描述/标签里，以及和分组里已有收藏的标签、类型、网站重合的程度。
// 都不够像的话，按类型放进“图片”“文件”“GitHub 项目”这类分组（没有就新建）。
import { tokenize } from './search.js';

export const KIND_GROUP = {
  repo: 'GitHub 项目', skill: 'Skill', mcp: 'MCP', site: '网站', article: '文章', tool: '工具',
  image: '图片', file: '文件', text: '文本片段',
};
const THRESHOLD = 3;

const words = (s) => new Set(tokenize(String(s ?? '').replace(/[·|/\\\-_—:：()（）[\]【】]/g, ' ')).filter((w) => w.length > 1));

function haystack(item) {
  return [item.title, item.description, item.note, item.site, item.file?.name, (item.tags ?? []).join(' '),
    (item.github?.topics ?? []).join(' '), String(item.text ?? '').slice(0, 2000)].join(' ').toLowerCase();
}

export function suggestGroup(item, groups, items) {
  const hay = haystack(item);
  const tags = new Set(item.tags ?? []);
  let best = null;
  for (const g of groups) {
    const members = items.filter((i) => i.groupId === g.id);
    let score = 0;
    const why = [];
    // 分组名本身是最强的信号：“AI 工具”分组 + 收藏里提到 ai
    const nameHits = [...words(g.name)].filter((w) => hay.includes(w));
    if (nameHits.length) { score += 4 * nameHits.length; why.push(`提到了分组名里的「${nameHits.join('、')}」`); }
    if (members.length) {
      const tagCount = new Map();
      for (const m of members) for (const t of m.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
      const shared = [...tags].filter((t) => tagCount.has(t));
      // 标签在分组里越常见，越说明是这个分组的“主题”
      const tagScore = shared.reduce((s, t) => s + Math.min(1, (tagCount.get(t) / members.length) * 2), 0) * 2;
      if (shared.length) { score += tagScore; why.push(`和组里的收藏有相同标签「${shared.slice(0, 3).join('、')}」`); }
      const sameType = members.filter((m) => m.type === item.type).length / members.length;
      if (sameType >= 0.5) { score += 1.5 * sameType; why.push(`组里大多也是${KIND_GROUP[item.type] ?? item.type}`); }
      if (item.site && members.some((m) => m.site === item.site)) { score += 1; why.push(`组里有同一网站 ${item.site}`); }
    }
    if (!best || score > best.score) best = { group: g, score, why };
  }
  if (best && best.score >= THRESHOLD) {
    return { groupId: best.group.id, name: best.group.name, created: false, reason: best.why.join('；') };
  }
  return { groupId: null, name: KIND_GROUP[item.type] ?? '其他', created: true,
    reason: best ? `没有足够相似的分组（最接近的「${best.group.name}」只有 ${best.score.toFixed(1)} 分），按类型归入` : '还没有分组，按类型归入' };
}
