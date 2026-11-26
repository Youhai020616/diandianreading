/** Search-term extraction for related-highlight lookup and FTS5 phrase quoting. */

const RELATED_STOPWORDS = new Set([
  "我们", "你们", "他们", "自己", "这个", "那个", "什么", "怎么", "为什么", "因为", "所以", "但是", "如果", "可以",
  "应该", "需要", "已经", "还是", "或者", "以及", "一个", "一些", "这种", "那种", "时候", "地方", "东西", "问题",
  "觉得", "认为", "发现", "感觉", "其实", "就是", "不是", "没有", "不要", "不能", "不会", "这里", "那里", "现在",
  "以前", "以后", "通过", "关于", "对于", "进行", "开始", "使用", "非常", "比较", "可能", "一定", "很多", "大家",
  "the", "and", "for", "that", "this", "with", "from", "have", "your", "about", "into", "more", "some", "what",
]);

export function extractSearchTermsFromDraft(rawText: string): { ftsTerms: string[]; shortTerms: string[] } {
  const cleaned = rawText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^>\s*.*$/gm, " ") // Skip already-quoted lines so we surface fresh highlights
    .replace(/[#*_`~>\[\]()（）《》「」『』“”"'，。！？、：；,.!?;:|/\\+-]/g, " ")
    .trim();

  const ftsCounts = new Map<string, number>();
  const shortCounts = new Map<string, number>();

  // 1. English / alphanumeric tokens (>= 3 chars)
  for (const m of cleaned.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,20}/g)) {
    const token = m[0].toLowerCase();
    if (RELATED_STOPWORDS.has(token)) continue;
    ftsCounts.set(token, (ftsCounts.get(token) ?? 0) + 2);
  }

  // 2. Chinese runs: extract clean 2-4 char candidate spans
  for (const m of cleaned.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    if (run.length <= 4) {
      if (!RELATED_STOPWORDS.has(run)) {
        if (run.length >= 3) ftsCounts.set(run, (ftsCounts.get(run) ?? 0) + 3);
        else shortCounts.set(run, (shortCounts.get(run) ?? 0) + 2);
      }
      continue;
    }
    // Extract 2-char and 3-char sliding tokens along longer Chinese phrases
    for (let i = 0; i <= run.length - 3; i++) {
      const tri = run.slice(i, i + 3);
      if (!RELATED_STOPWORDS.has(tri)) {
        ftsCounts.set(tri, (ftsCounts.get(tri) ?? 0) + 1);
      }
    }
    for (let i = 0; i <= run.length - 2; i += 2) {
      const bi = run.slice(i, i + 2);
      if (!RELATED_STOPWORDS.has(bi)) {
        shortCounts.set(bi, (shortCounts.get(bi) ?? 0) + 1);
      }
    }
  }

  const ftsTerms = [...ftsCounts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 10)
    .map(([t]) => t);

  const shortTerms = [...shortCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([t]) => t);

  return { ftsTerms, shortTerms };
}

export function escapeFtsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}
