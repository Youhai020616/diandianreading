import type { BookMetadataCandidate, BookMetadataSearchResult, BookMetadataSource } from "../../src/types/desktop";
import { canonicalIsbn } from "../isbn";
import { metadataRank, parseMetadataQuery, type MetadataQuery } from "./metadataMatching";

export type { BookMetadataCandidate } from "../../src/types/desktop";

class CatalogHttpError extends Error {
  constructor(readonly status: number) {
    super(`Catalog returned HTTP ${status}`);
  }
}

async function fetchCatalog<T>(url: URL | string, signal = AbortSignal.timeout(8_000)): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": "diandianreading/2.0 (desktop reading companion)", accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new CatalogHttpError(res.status);
  return (await res.json()) as T;
}

function safeHttpsCover(url: unknown): string {
  if (typeof url !== "string") return "";
  const trimmed = url.trim().replace(/^http:\/\//i, "https://");
  return /^https:\/\//i.test(trimmed) ? trimmed : "";
}

function openLibraryCover(id?: number): string {
  return typeof id === "number" && id > 0 ? `https://covers.openlibrary.org/b/id/${id}-M.jpg?default=false` : "";
}

interface OpenLibraryEdition {
  title?: string;
  subtitle?: string;
  by_statement?: string;
  isbn_13?: string[];
  isbn_10?: string[];
  publishers?: string[];
  publish_date?: string;
  covers?: number[];
  description?: string | { value?: string };
}

async function queryOpenLibraryIsbn(isbn: string): Promise<BookMetadataCandidate[]> {
  let edition: OpenLibraryEdition;
  try {
    edition = await fetchCatalog<OpenLibraryEdition>(`https://openlibrary.org/isbn/${isbn}.json`);
  } catch (error) {
    if (error instanceof CatalogHttpError && error.status === 404) return [];
    throw error;
  }
  if (typeof edition?.title !== "string" || !edition.title.trim()) throw new Error("Invalid Open Library edition");
  const identifiers = [...(edition.isbn_13 ?? []), ...(edition.isbn_10 ?? [])];
  if (!identifiers.some(id => typeof id === "string" && canonicalIsbn(id) === isbn)) return [];
  const description = typeof edition.description === "string" ? edition.description : edition.description?.value;
  return [{
    source: "openlibrary",
    title: [edition.title, edition.subtitle].filter(Boolean).join(": "),
    author: edition.by_statement?.trim() ?? "",
    isbn,
    publisher: edition.publishers?.filter(Boolean).join(" / ") ?? "",
    publishedYear: /\b\d{4}\b/.exec(edition.publish_date ?? "")?.[0] ?? "",
    description: (description ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 600),
    coverUrl: openLibraryCover(edition.covers?.find(id => id > 0)),
  }];
}

async function queryOpenLibrary(query: MetadataQuery): Promise<BookMetadataCandidate[]> {
  if (query.isbn) return queryOpenLibraryIsbn(query.isbn);
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("limit", "5");
  url.searchParams.set("fields", "key,title,author_name,cover_i,editions");
  if (query.book) {
    url.searchParams.set("title", query.book.title);
    if (query.book.author) url.searchParams.set("author", query.book.author);
  } else {
    url.searchParams.set("q", query.text);
  }
  type Hit = { key?: string; title?: string; cover_i?: number };
  const signal = AbortSignal.timeout(8_000);
  const data = await fetchCatalog<{
    docs?: Array<Hit & { author_name?: string[]; editions?: { docs?: Hit[] } }>;
  }>(url, signal);
  if (!Array.isArray(data?.docs)) throw new Error("Invalid Open Library response");
  const candidates: BookMetadataCandidate[] = [];
  const editions = new Map<string, BookMetadataCandidate>();
  for (const work of data.docs) {
    // Work-level ISBN, publisher and first_publish_year can each belong to a
    // different edition. Only use a matching edition's title and its own cover.
    const hit = work?.editions?.docs?.[0] ?? work;
    if (typeof hit?.title !== "string" || !hit.title.trim()) continue;
    const candidate: BookMetadataCandidate = {
      source: "openlibrary",
      title: hit.title.trim(),
      author: work.author_name?.slice(0, 3).join(" / ") ?? "",
      isbn: "", publisher: "", publishedYear: "", description: "",
      coverUrl: openLibraryCover(hit.cover_i),
    };
    candidates.push(candidate);
    const id = /^\/books\/(OL\d+M)$/.exec(hit.key ?? "")?.[1];
    if (id && Number.isFinite(metadataRank(query, candidate))) editions.set(id, candidate);
  }
  // Fetch all selected editions together. If enrichment is down, their verified
  // search titles/covers are still usable, and edition-specific fields stay empty.
  if (editions.size) await enrichOpenLibraryEditions(editions, signal);
  return candidates;
}

async function enrichOpenLibraryEditions(editions: Map<string, BookMetadataCandidate>, signal: AbortSignal): Promise<void> {
  const url = new URL("https://openlibrary.org/api/books");
  url.search = new URLSearchParams({
    bibkeys: [...editions.keys()].map(id => "OLID:" + id).join(","), jscmd: "data", format: "json",
  }).toString();
  type Edition = {
    title?: string; subtitle?: string; authors?: Array<{ name?: string }>;
    publishers?: Array<{ name?: string }>; publish_date?: string;
    identifiers?: { openlibrary?: string[]; isbn_13?: string[]; isbn_10?: string[] };
  };
  const data = await fetchCatalog<Record<string, Edition>>(url, signal).catch(() => null);
  if (!data) return;
  for (const [id, candidate] of editions) {
    const edition = data["OLID:" + id];
    const ids = edition?.identifiers;
    if (!ids?.openlibrary?.includes(id) || !edition?.title?.trim()) continue;
    const isbn = [...(ids.isbn_13 ?? []), ...(ids.isbn_10 ?? [])].map(canonicalIsbn).find(Boolean);
    candidate.isbn = isbn ?? "";
    candidate.publisher = edition.publishers?.map(p => p.name).filter(Boolean).join(" / ") ?? "";
    candidate.publishedYear = /\b\d{4}\b/.exec(edition.publish_date ?? "")?.[0] ?? "";
    candidate.title = [edition.title, edition.subtitle].filter(Boolean).join(": ");
    candidate.author = edition.authors?.map(a => a.name).filter(Boolean).join(" / ") || candidate.author;
  }
}

async function queryGoogleBooks(query: MetadataQuery): Promise<BookMetadataCandidate[]> {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  let keywords = query.text;
  if (query.isbn) keywords = `isbn:${query.isbn}`;
  else if (query.book) {
    const title = query.book.title.replace(/"/g, " ");
    const author = query.book.author.replace(/"/g, " ");
    keywords = `intitle:"${title}"` + (author ? ` inauthor:"${author}"` : "");
  }
  url.searchParams.set("q", keywords);
  url.searchParams.set("maxResults", "5");
  const data = await fetchCatalog<{
    totalItems?: number;
    items?: Array<{
      volumeInfo?: {
        title?: string;
        subtitle?: string;
        authors?: string[];
        publisher?: string;
        publishedDate?: string;
        description?: string;
        industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
        imageLinks?: { thumbnail?: string; smallThumbnail?: string };
      };
    }>;
  }>(url);
  if (data?.totalItems === 0 && data.items === undefined) return [];
  if (!Array.isArray(data?.items)) throw new Error("Invalid Google Books response");
  const candidates: BookMetadataCandidate[] = [];
  for (const item of data.items) {
    const book = item?.volumeInfo;
    if (typeof book?.title !== "string" || !book.title.trim()) continue;
    const identifiers = (book.industryIdentifiers ?? [])
      .filter(i => i.type === "ISBN_13" || i.type === "ISBN_10")
      .map(i => canonicalIsbn(i.identifier ?? "")).filter(Boolean);
    if (query.isbn && !identifiers.includes(query.isbn)) continue;
    candidates.push({
      source: "google-books",
      title: [book.title.trim(), book.subtitle?.trim()].filter(Boolean).join(": "),
      author: book.authors?.slice(0, 3).join(" / ") ?? "",
      isbn: query.isbn || identifiers[0] || "",
      publisher: book.publisher?.trim() ?? "",
      publishedYear: /^(\d{4})/.exec(book.publishedDate ?? "")?.[1] ?? "",
      description: book.description?.trim().slice(0, 600) ?? "",
      coverUrl: safeHttpsCover(book.imageLinks?.thumbnail ?? book.imageLinks?.smallThumbnail),
    });
  }
  return candidates;
}

async function queryWeRead(query: MetadataQuery): Promise<BookMetadataCandidate[]> {
  const url = new URL("https://weread.qq.com/web/search/global");
  url.searchParams.set("keyword", query.book?.title || query.text);
  url.searchParams.set("count", "8");
  const data = await fetchCatalog<{
    books?: Array<{
      bookInfo?: {
        title?: string;
        author?: string;
        isbn?: string;
        publisher?: string;
        publishTime?: string;
        intro?: string;
        cover?: string;
      };
    }>;
  }>(url);
  if (!Array.isArray(data?.books)) throw new Error("Invalid WeRead response");
  const candidates: BookMetadataCandidate[] = [];
  for (const entry of data.books.slice(0, 8)) {
    const book = entry?.bookInfo;
    if (typeof book?.title !== "string" || !book.title.trim()) continue;
    candidates.push({
      source: "weread",
      title: book.title.trim(),
      author: String(book.author ?? "").trim(),
      isbn: canonicalIsbn(String(book.isbn ?? "")),
      publisher: String(book.publisher ?? "").trim(),
      publishedYear: /^(\d{4})/.exec(String(book.publishTime ?? ""))?.[1] ?? "",
      description: String(book.intro ?? "").trim().slice(0, 600),
      coverUrl: safeHttpsCover(book.cover),
    });
  }
  return candidates;
}

const catalogs: Record<BookMetadataSource, (query: MetadataQuery) => Promise<BookMetadataCandidate[]>> = {
  "google-books": queryGoogleBooks,
  openlibrary: queryOpenLibrary,
  weread: queryWeRead,
};

export async function searchOnlineBookMetadata(
  input: string, book?: { title: string; author: string; isbn?: string },
): Promise<BookMetadataSearchResult> {
  const result: BookMetadataSearchResult = { candidates: [], issues: [] };
  const query = parseMetadataQuery(input, book);
  if (!query) return input.trim() ? { ...result, invalidIsbn: true } : result;

  const sources: BookMetadataSource[] = query.isbn ? ["openlibrary", "google-books", "weread"]
    : /\p{Script=Han}/u.test(input) ? ["weread", "google-books", "openlibrary"] : ["google-books", "openlibrary", "weread"];
  const responses = await Promise.allSettled(sources.map(source => catalogs[source](query)));
  const ranked: Array<{ candidate: BookMetadataCandidate; score: number; position: number }> = [];
  responses.forEach((response, index) => {
    if (response.status === "rejected") {
      const limited = response.reason instanceof CatalogHttpError && response.reason.status === 429;
      result.issues.push({ source: sources[index]!, reason: limited ? "rate-limited" : "unavailable" });
      return;
    }
    response.value.forEach((candidate, position) => {
      const score = metadataRank(query, candidate);
      if (Number.isFinite(score)) ranked.push({ candidate, score, position });
    });
  });
  // For equally relevant matches retain the provider rankings, interleaving the lists.
  ranked.sort((a, b) => a.score - b.score || a.position - b.position);
  const seen = new Set<string>();
  for (const { candidate } of ranked) {
    const key = JSON.stringify([candidate.title.toLowerCase(), candidate.author.toLowerCase(), candidate.isbn,
      candidate.publisher.toLowerCase(), candidate.publishedYear, candidate.coverUrl]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.candidates.push(candidate);
    if (result.candidates.length === 8) break;
  }
  return result;
}
