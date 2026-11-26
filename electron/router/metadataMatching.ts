import { canonicalIsbn } from "../isbn";
import type { BookMetadataCandidate } from "../../src/types/desktop";

type BookHint = { title: string; author: string; isbn?: string };

export interface MetadataQuery {
  text: string;
  isbn: string;
  book?: BookHint;
  isbnTarget?: BookHint;
}

function compact(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function parseMetadataQuery(input: string, book?: BookHint): MetadataQuery | null {
  const text = input.normalize("NFKC").trim();
  if (!text) return null;
  const isbn = canonicalIsbn(text);
  if (isbn) {
    const isbnTarget = canonicalIsbn(book?.isbn) === isbn ? undefined : book;
    return { text: isbn, isbn, isbnTarget };
  }
  // A mistyped ISBN must not be silently retried as words against a recommendation feed.
  if (/^isbn(?:-1[03])?\s*[:\s]/i.test(text) || /^(?:\d[\s\p{Pd}]*){9,12}[\dX]$/iu.test(text)) return null;
  if (book) {
    const typed = compact(text);
    if (typed === compact(book.title) || typed === compact(book.title + book.author)) {
      return { text, isbn: "", book };
    }
    if (titleRank(text, book.title) === 1) return { text, isbn: "", book: { ...book, title: text } };
  }
  return { text, isbn: "" };
}

function authorNames(value: string): string[] {
  return value.normalize("NFKC").split(/(?:\s+著(?=\s)|[、;/；\n]|\s+(?:and|&)\s+)/i)
    .filter(name => !/译\s*$/.test(name))
    .map(name => compact(name.replace(/^\s*(?:\[[^\]]{1,12}\]|\([^)]{1,12}\))\s*/, "").replace(/(?:编著|著)\s*$/, "")))
    .filter(Boolean);
}

// A subtitle or an edition label can qualify a title. A collection, adaptation, or
// another volume cannot qualify the original, even if the author is the same.
function hasSeriesOrAdaptationLabel(title: string): boolean {
  return /全[\d一二三四五六七八九十百]+[册卷部]|套(?:装|书)|全集|全套|合集|合订|部曲|续集|[上中下][册卷部]|第[\d一二三四五六七八九十]+[册部卷集]|导读|解读|漫画|学习版/.test(title)
    || /\b(?:book|part|vol(?:ume)?\.?)\s+(?:\d+|[ivx]+|one|two|three)\b/i.test(title)
    || /\b(?:study guide|companion|workbook|graphic novel|box(?:ed)? set|collection|trilogy|omnibus)\b/i.test(title);
}

function titleRank(title: string, candidate: string): number {
  const wanted = compact(title);
  if (compact(candidate) === wanted) return 0;
  const full = candidate.normalize("NFKC");
  for (const sep of full.matchAll(/[(:【]/g)) {
    const base = full.slice(0, sep.index);
    const extra = full.slice(sep.index + 1);
    if (compact(base) !== wanted || hasSeriesOrAdaptationLabel(extra)) continue;
    // A short series name can prefix many unrelated titles and unnumbered sequels.
    if (/\p{Script=Han}/u.test(wanted) && wanted.length <= 2 &&
        !/^(?:纪念版|修订版|珍藏版|典藏版|精装版|平装版|插图版|新版|全译本|[\p{L}]{2,8}经典)[)】]?$/u.test(extra.trim())) continue;
    return 1;
  }
  return Infinity;
}

export function metadataRank(query: MetadataQuery, candidate: BookMetadataCandidate): number {
  if (query.isbn && canonicalIsbn(candidate.isbn) !== query.isbn) return Infinity;
  const target = query.book ?? query.isbnTarget;
  if (target) {
    const expected = authorNames(target.author);
    const actual = authorNames(candidate.author);
    if (expected.length && !expected.some(name => actual.includes(name))) return Infinity;
    return titleRank(target.title, candidate.title);
  }
  if (query.isbn) return 0;

  // In manually edited searches the user can supply just an author, a fragment of a
  // title, or words from both fields. Do not show a suggestion matching none of them.
  const title = compact(candidate.title);
  const author = compact(candidate.author);
  if (authorNames(candidate.author).includes(compact(query.text))) return 0;
  if (hasSeriesOrAdaptationLabel(candidate.title) && !hasSeriesOrAdaptationLabel(query.text)) return Infinity;
  const words = query.text.split(/\s+/);
  const lastWord = words.at(-1);
  if (words.length > 1 && lastWord && authorNames(candidate.author).includes(compact(lastWord))) {
    return titleRank(words.slice(0, -1).join(" "), candidate.title);
  }
  const terms = words.map(compact).filter(Boolean);
  if (!terms.length || !terms.every(term => title.includes(term) || author.includes(term))) return Infinity;
  if (title === compact(query.text)) return 0;
  return 1;
}
