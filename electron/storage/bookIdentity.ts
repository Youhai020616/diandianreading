import type { DatabaseSync } from "node:sqlite";
import { canonicalIsbn } from "../isbn";

interface IdentityInput {
  title: string;
  author?: string;
  isbn?: string;
  publisher?: string;
  sourceLocator?: string;
}

interface Match {
  id: string;
  title: string;
  author: string;
  isbn: string;
  publisher: string;
  readerId: string | null;
}

function textKey(value = ""): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function authorKey(value = ""): string {
  return textKey(value)
    .replace(/^(?:\[\p{Script=Han}{1,3}\]|\(\p{Script=Han}{1,3}\))\s*/u, "")
    .replace(/\s*[·・•]\s*/g, "·");
}

function readerId(locator = ""): string {
  try {
    const url = new URL(locator);
    if (url.hostname !== "weread.qq.com") return "";
    return /^\/web\/reader\/([\w-]+)\/?$/.exec(url.pathname)?.[1] ?? "";
  } catch {
    return "";
  }
}

type IdentityKind = "title" | "edition-base" | "weread" | "isbn";

export class BookIdentityIndex {
  constructor(private readonly db: DatabaseSync) {}

  private put(id: string, kind: IdentityKind, value: string): void {
    if (value) {
      this.db.prepare("INSERT OR IGNORE INTO book_identity (book_id, kind, value) VALUES (?, ?, ?)")
        .run(id, kind, value);
    }
  }

  remember(id: string, input: IdentityInput): void {
    this.put(id, "title", textKey(input.title));
    this.put(id, "weread", readerId(input.sourceLocator));
    this.put(id, "isbn", canonicalIsbn(input.isbn ?? ""));
  }

  replaceIsbn(id: string, isbn: string): void {
    this.db.prepare("DELETE FROM book_identity WHERE book_id = ? AND kind = 'isbn'").run(id);
    this.put(id, "isbn", canonicalIsbn(isbn));
  }

  // Earlier releases overwrote the display title with the selected catalog edition.
  // A bare title inferred from an edition label requires a matching author during lookup.
  indexLegacyBook(id: string, input: IdentityInput): void {
    this.remember(id, input);
    const match = /^(.*?)\s*\(([^()]+)\)$/.exec(textKey(input.title));
    if (match && /经典|译本|版本|版$/.test(match[2]!) && !/[册卷部]|套装|选集|合订/.test(match[2]!)) {
      this.put(id, "edition-base", match[1]!.trim());
    }
  }

  private matches(kind: IdentityKind, value: string): Match[] {
    if (!value) return [];
    return this.db.prepare(`
      SELECT b.id, b.title, b.author, b.isbn, b.publisher,
             (SELECT value FROM book_identity WHERE book_id = b.id AND kind = 'weread') AS readerId
      FROM book_identity i JOIN books b ON b.id = i.book_id
      WHERE i.kind = ? AND i.value = ?
    `).all(kind, value) as unknown as Match[];
  }

  find(input: IdentityInput): string | undefined {
    const reader = readerId(input.sourceLocator);
    const isbn = canonicalIsbn(input.isbn ?? "");
    const author = authorKey(input.author);
    const publisher = textKey(input.publisher);
    const title = textKey(input.title);
    const unique = (matches: Match[]): string | undefined => {
      if (matches.length > 1) {
        const choices = matches.slice(0, 3).map(book =>
          [`《${book.title}》`, book.author, book.publisher, book.isbn].filter(Boolean).join(" · "));
        throw new Error(`《${input.title}》匹配到多个版本（${choices.join("、")}）。请在导入文本中写明版本书名和作者，或打开目标书目点「记一条划线」。`);
      }
      return matches[0]?.id;
    };

    const sameReader = this.matches("weread", reader);
    if (sameReader.length) return unique(sameReader);

    const readerCompatible = (book: Match) => !reader || !book.readerId || reader === book.readerId;
    const sameIsbn = this.matches("isbn", isbn).filter(readerCompatible);
    if (sameIsbn.length > 1 && author) {
      const byAuthor = sameIsbn.filter(book => authorKey(book.author) === author);
      if (byAuthor.length) return unique(byAuthor);
    }
    if (sameIsbn.length) return unique(sameIsbn);

    const compatible = (book: Match) =>
      readerCompatible(book)
      && (!input.isbn || !book.isbn || (isbn || textKey(input.isbn)) === (canonicalIsbn(book.isbn) || textKey(book.isbn)))
      && (!publisher || !book.publisher || textKey(book.publisher) === publisher);
    const byTitle = this.matches("title", title).filter(compatible);
    if (byTitle.length) {
      if (!author) return unique(byTitle);
      const sameAuthor = byTitle.filter(book => authorKey(book.author) === author);
      if (sameAuthor.length) return unique(sameAuthor);
      // Enrich a previously anonymous book only when it is the sole candidate.
      if (byTitle.length === 1 && !byTitle[0]!.author) return byTitle[0]!.id;
    }
    if (!author) return undefined;
    const byOldTitle = this.matches("edition-base", title)
      .filter(book => compatible(book) && authorKey(book.author) === author);
    return unique(byOldTitle);
  }
}
