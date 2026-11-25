export interface BookMetadataCandidate {
  source: "openlibrary" | "google-books";
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  publishedYear: string;
  description: string;
  coverUrl: string;
}

function safeHttpsCover(url: unknown): string {
  if (typeof url !== "string") return "";
  const trimmed = url.trim().replace(/^http:\/\//i, "https://");
  if (!/^https:\/\//i.test(trimmed)) return "";
  return trimmed;
}

async function queryOpenLibrary(query: string): Promise<BookMetadataCandidate[]> {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5`;
  const res = await fetch(url, {
    headers: { "user-agent": "diandianreading/2.0 (desktop reading companion)" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    docs?: Array<{
      title?: string;
      author_name?: string[];
      isbn?: string[];
      publisher?: string[];
      first_publish_year?: number;
      cover_i?: number;
    }>;
  };
  const docs = Array.isArray(data.docs) ? data.docs : [];
  return docs
    .filter((d) => typeof d.title === "string" && d.title.trim())
    .slice(0, 5)
    .map((d) => ({
      source: "openlibrary" as const,
      title: String(d.title ?? "").trim(),
      author: Array.isArray(d.author_name) ? d.author_name.slice(0, 3).join(" / ") : "",
      isbn: Array.isArray(d.isbn) && d.isbn[0] ? String(d.isbn[0]) : "",
      publisher: Array.isArray(d.publisher) && d.publisher[0] ? String(d.publisher[0]) : "",
      publishedYear: typeof d.first_publish_year === "number" ? String(d.first_publish_year) : "",
      description: "",
      coverUrl: typeof d.cover_i === "number" ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : "",
    }));
}

async function queryGoogleBooks(query: string): Promise<BookMetadataCandidate[]> {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`;
  const res = await fetch(url, {
    headers: { "user-agent": "diandianreading/2.0 (desktop reading companion)" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    items?: Array<{
      volumeInfo?: {
        title?: string;
        authors?: string[];
        publisher?: string;
        publishedDate?: string;
        description?: string;
        industryIdentifiers?: Array<{ type?: string; identifier?: string }>;
        imageLinks?: { thumbnail?: string; smallThumbnail?: string };
      };
    }>;
  };
  const items = Array.isArray(data.items) ? data.items : [];
  return items
    .map((item) => item.volumeInfo)
    .filter((v): v is NonNullable<typeof v> => Boolean(v && typeof v.title === "string" && v.title.trim()))
    .slice(0, 5)
    .map((v) => {
      const isbn13 = v.industryIdentifiers?.find((i) => i.type === "ISBN_13")?.identifier;
      const isbn10 = v.industryIdentifiers?.find((i) => i.type === "ISBN_10")?.identifier;
      const yearMatch = /^(\d{4})/.exec(String(v.publishedDate ?? ""));
      return {
        source: "google-books" as const,
        title: String(v.title ?? "").trim(),
        author: Array.isArray(v.authors) ? v.authors.slice(0, 3).join(" / ") : "",
        isbn: String(isbn13 ?? isbn10 ?? ""),
        publisher: String(v.publisher ?? "").trim(),
        publishedYear: yearMatch?.[1] ?? "",
        description: String(v.description ?? "").trim().slice(0, 600),
        coverUrl: safeHttpsCover(v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail),
      };
    });
}

export async function searchOnlineBookMetadata(query: string): Promise<BookMetadataCandidate[]> {
  const q = query.trim();
  if (!q) return [];

  const [gb, ol] = await Promise.allSettled([queryGoogleBooks(q), queryOpenLibrary(q)]);
  const merged: BookMetadataCandidate[] = [];
  if (gb.status === "fulfilled") merged.push(...gb.value);
  if (ol.status === "fulfilled") merged.push(...ol.value);

  // Deduplicate by normalized title + author.
  const seen = new Set<string>();
  const out: BookMetadataCandidate[] = [];
  for (const item of merged) {
    const key = `${item.title.toLowerCase()}::${item.author.toLowerCase()}::${item.isbn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 8);
}
