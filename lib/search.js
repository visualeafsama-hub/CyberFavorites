// 关键词打分搜索。不依赖向量库：AI 拿到排序后的候选，自己再判断哪个最合适。

const WEIGHTS = { title: 6, tags: 5, group: 4, type: 4, topics: 4, note: 3, description: 2, filename: 2, url: 1, content: 1 };

function fields(item, groupName) {
  return {
    title: item.title ?? '',
    tags: (item.tags ?? []).join(' '),
    group: groupName(item.groupId) ?? '',
    type: item.type ?? '',
    topics: (item.github?.topics ?? []).join(' '),
    note: item.note ?? '',
    description: item.description ?? '',
    url: item.url ?? '',
    filename: item.file?.name ?? '',
    // 文本片段的正文、docx 等文件里抽出来的文字
    content: String(item.text ?? '').slice(0, 20000),
  };
}

export function tokenize(q) {
  return String(q ?? '').toLowerCase().split(/[\s,，、;；]+/).filter(Boolean);
}

export function search(items, q, { limit = 20, groupName = () => '' } = {}) {
  const terms = tokenize(q);
  if (!terms.length) return [];
  const results = [];
  for (const item of items) {
    const f = fields(item, groupName);
    let score = 0; const matched = new Set();
    for (const t of terms) {
      let hit = false;
      for (const [k, w] of Object.entries(WEIGHTS)) {
        const v = f[k].toLowerCase();
        if (!v.includes(t)) continue;
        hit = true;
        // 完整单词命中比子串命中分高
        score += new RegExp(`(^|[^a-z0-9])${escape(t)}([^a-z0-9]|$)`).test(v) ? w * 1.5 : w;
        matched.add(k);
      }
      if (!hit) score -= 2;
    }
    if (score <= 0) continue;
    if (item.pinned) score += 1;
    if (item.github?.stars) score += Math.min(2, Math.log10(item.github.stars + 1) / 2);
    results.push({ score: +score.toFixed(2), matched: [...matched], item });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
