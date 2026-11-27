/**
 * Page/site names that end up in a draft's "book title" when text was captured from a web page
 * whose real book could not be determined. Shared by the renderer's draft cleanup and the
 * concept-visual extractor so both reject the same names.
 */
const GENERIC_SITE_TITLES = new Set([
  "微信读书",
  "weread",
  "豆瓣",
  "豆瓣读书",
  "小红书",
  "小红书创作",
  "小红书创作服务平台",
  "公众号",
  "微信公众号",
  "知乎",
  "哔哩哔哩",
  "b 站创作中心",
  "新标签页",
  "阅读页",
  "网页摘录",
  "加载中",
]);

export function isGenericSiteName(name: string): boolean {
  const clean = name.trim().toLowerCase().replace(/^《|》$/g, "");
  if (!clean) return true;
  if (GENERIC_SITE_TITLES.has(clean)) return true;
  return /^(微信读书|豆瓣读书|小红书|微信公众号|新标签页|加载中)/.test(clean);
}
