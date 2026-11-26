import { afterEach, describe, expect, it, vi } from "vitest";
import { searchOnlineBookMetadata } from "../electron/router/metadataService";

const title = "克林索尔的最后夏天";
const author = "赫尔曼·黑塞";
const query = `${title} ${author}`;
type Reply = Response | Error | ((url: URL) => Response);

function mockSources({
  openLibrary = Response.json({ numFound: 0, docs: [] }),
  googleBooks = Response.json({ kind: "books#volumes", totalItems: 0 }),
  weRead = Response.json({ books: [], totalCount: 0 }),
}: { openLibrary?: Reply; googleBooks?: Reply; weRead?: Reply } = {}) {
  const replies: Record<string, Reply> = {
    "openlibrary.org": openLibrary,
    "www.googleapis.com": googleBooks,
    "weread.qq.com": weRead,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const reply = replies[url.hostname];
    if (!reply) throw new Error(`Unexpected metadata host: ${url.hostname}`);
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(url);
    return reply.clone();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("book metadata lookup", () => {
  it("returns both Chinese editions and their covers when Google Books hits its quota", async () => {
    const editions = [
      {
        bookId: "1", title, author, publisher: "民主与建设出版社",
        cover: "https://wfqqreader-1252317822.image.myqcloud.com/cover/1.jpg",
      },
      {
        bookId: "2", title, author, publisher: "江苏凤凰文艺出版社",
        cover: "https://wfqqreader-1252317822.image.myqcloud.com/cover/2.jpg",
      },
    ];
    mockSources({
      googleBooks: new Response(null, { status: 429 }),
      weRead: Response.json({ books: editions.map((bookInfo) => ({ bookInfo })), totalCount: editions.length }),
    });

    const { candidates, issues } = await searchOnlineBookMetadata(query);
    expect(issues).toEqual([{ source: "google-books", reason: "rate-limited" }]);
    expect(candidates).toHaveLength(2);
    for (const book of editions) {
      expect(candidates).toContainEqual(expect.objectContaining({
        source: "weread", title, author, publisher: book.publisher, coverUrl: book.cover,
      }));
    }
  });

  it("reports no matches without errors when all sources successfully return empty results", async () => {
    mockSources();
    expect(await searchOnlineBookMetadata(query)).toEqual({ candidates: [], issues: [] });
  });

  it("keeps a partial failure visible even when healthy sources find no candidates", async () => {
    mockSources({ googleBooks: new Response(null, { status: 429 }) });
    expect(await searchOnlineBookMetadata(query)).toEqual({
      candidates: [],
      issues: [{ source: "google-books", reason: "rate-limited" }],
    });
  });

  it("reports HTTP failures, invalid responses and timeouts under their respective sources", async () => {
    mockSources({
      googleBooks: new Response(null, { status: 429 }),
      openLibrary: new Response("invalid JSON"),
      weRead: new DOMException("request timed out", "TimeoutError"),
    });
    const { candidates, issues } = await searchOnlineBookMetadata(query);
    expect(candidates).toEqual([]);
    expect(issues).toHaveLength(3);
    expect(issues).toEqual(expect.arrayContaining([
      { source: "google-books", reason: "rate-limited" },
      { source: "openlibrary", reason: "unavailable" },
      { source: "weread", reason: "unavailable" },
    ]));
  });
});

describe("edition and title matching", () => {
  const gatsby = {
    title: "The Great Gatsby", by_statement: "F. Scott Fitzgerald", publishers: ["Scribner"],
    isbn_13: ["9780743273565"], isbn_10: ["0743273567"], publish_date: "2004", covers: [13028546],
  };
  it("resolves the exact edition for either ISBN and rejects unrelated search hits", async () => {
    mockSources({
      openLibrary: url => {
        expect(url.pathname).toBe("/isbn/9780743273565.json");
        return Response.json(gatsby);
      },
      weRead: Response.json({ books: [{ bookInfo: { title: "ASP.NET", isbn: "9780131103627" } }] }),
      googleBooks: Response.json({ items: [
        { volumeInfo: { title: "The Great Gatsby", industryIdentifiers: [{ type: "ISBN_10", identifier: "3125372402" }] } },
        { volumeInfo: { title: "The Great Gatsby", industryIdentifiers: [{ type: "ISBN_10", identifier: "0743273567" }] } },
      ] }),
    });
    for (const input of ["ISBN 978-0-7432-7356-5", "0-7432-7356-7"]) {
      const { candidates, issues } = await searchOnlineBookMetadata(input);
      expect(issues).toEqual([]);
      expect(candidates).toHaveLength(2);
      expect(candidates.every(c => c.isbn === "9780743273565")).toBe(true);
      expect(candidates[0]).toMatchObject({
        source: "openlibrary", publisher: "Scribner", publishedYear: "2004", coverUrl: expect.stringContaining("/13028546-"),
      });
    }
  });

  it("treats an unknown ISBN as no match and excludes a different edition even from the ISBN endpoint", async () => {
    mockSources({ openLibrary: new Response(null, { status: 404 }) });
    expect(await searchOnlineBookMetadata("9780743273565")).toEqual({ candidates: [], issues: [] });
    mockSources({ openLibrary: Response.json({ ...gatsby, isbn_13: [], isbn_10: ["3125372402"] }) });
    expect((await searchOnlineBookMetadata("9780743273565")).candidates).toEqual([]);
  });

  it("does not offer an unrelated typed ISBN to a book unless its stored ISBN confirms identity", async () => {
    mockSources({ openLibrary: Response.json(gatsby) });
    const different = { title: "三体", author: "刘慈欣" };
    expect((await searchOnlineBookMetadata("9780743273565", different)).candidates).toEqual([]);
    const translated = { title: "了不起的盖茨比", author: "菲茨杰拉德", isbn: "0743273567" };
    expect((await searchOnlineBookMetadata("9780743273565", translated)).candidates).toHaveLength(1);
    expect(await searchOnlineBookMetadata("9780743273566", different)).toEqual({
      candidates: [], issues: [], invalidIsbn: true,
    });
    expect(await searchOnlineBookMetadata("  ")).toEqual({ candidates: [], issues: [] });
  });

  it("searches by the title and verifies author, volume and publication type before displaying results", async () => {
    const book = { title: "三体", author: "刘慈欣" };
    mockSources({
      weRead: Response.json({ books: [
        { title: "三体全集（全三册）", author: "刘慈欣" },
        { title: "三体", author: "其他作者" },
        { title: "三体（第三部）", author: "刘慈欣" },
        { title: "三体：黑暗森林", author: "刘慈欣" },
        { title: "三体（阅读导读）", author: "刘慈欣" },
        { title: "球状闪电", author: "刘慈欣" },
        { title: "三体（纪念版）", author: "[中]刘慈欣" },
        { title: "三体", author: "刘慈欣" },
      ].map(bookInfo => ({ bookInfo })) }),
    });
    for (const typed of ["三体 刘慈欣", "三体"]) {
      const result = await searchOnlineBookMetadata(typed, book);
      expect(result.candidates.map(c => c.title)).toEqual(["三体", "三体（纪念版）"]);
    }
  });

  it("keeps good Hesse editions and does not reassign different editions' ISBNs from an Open Library work", async () => {
    const book = { title, author };
    mockSources({
      openLibrary: Response.json({ docs: [{
        title, author_name: [author], isbn: ["incorrect-work-isbn"], publisher: ["publisher of a different edition"],
        first_publish_year: 1919, cover_i: 8, editions: { docs: [{ title: title + "（果麦经典）", cover_i: 22 }] },
      }] }),
      weRead: Response.json({ books: [
        { bookInfo: { title: title + "（果麦经典）", author: "[德]赫尔曼·黑塞 著\n赵宇晴译", publisher: "天津人民出版社" } },
        { bookInfo: { title: "悉达多", author: "[德]赫尔曼·黑塞" } },
      ] }),
    });
    const { candidates } = await searchOnlineBookMetadata(query, book);
    expect(candidates).toHaveLength(2);
    expect(candidates.find(c => c.source === "openlibrary")).toMatchObject({
      title: title + "（果麦经典）", isbn: "", publisher: "", publishedYear: "", coverUrl: expect.stringContaining("/22-"),
    });
    expect(candidates.find(c => c.source === "weread")?.publisher).toBe("天津人民出版社");
  });

  it("hydrates a title search from the exact matched edition, ignoring other works' fields", async () => {
    mockSources({ openLibrary: url => {
      if (url.pathname === "/search.json") {
        expect(url.searchParams.get("title")).toBe("The Great Gatsby");
        expect(url.searchParams.get("author")).toBe("F. Scott Fitzgerald");
        return Response.json({ docs: [{
          title: "The Great Gatsby", author_name: ["F. Scott Fitzgerald"], isbn: ["3125372402"], first_publish_year: 1920,
          editions: { docs: [{ key: "/books/OL23109860M", title: "The Great Gatsby", cover_i: 13028546 }] },
        }] });
      }
      expect(url.pathname).toBe("/api/books");
      expect(url.searchParams.get("bibkeys")).toBe("OLID:OL23109860M");
      return Response.json({ "OLID:OL23109860M": {
        title: "The Great Gatsby", publishers: [{ name: "Scribner" }], publish_date: "2004",
        identifiers: { openlibrary: ["OL23109860M"], isbn_10: ["0743273567"] },
      } });
    } });
    const { candidates } = await searchOnlineBookMetadata("The Great Gatsby", { title: "The Great Gatsby", author: "F. Scott Fitzgerald" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ publisher: "Scribner", publishedYear: "2004", isbn: "9780743273565" });
  });
});
