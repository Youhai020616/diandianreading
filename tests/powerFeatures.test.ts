import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSelectionToolbarScript } from "../electron/browser/selectionOverlay";
import { formatDraftForXiaohongshu } from "../src/lib/xhsFormat";
import {
  renderCarouselSlideHtml,
  splitTextIntoCarouselSlides,
} from "../electron/cards/carouselTemplates";
import { renderMonthlyPosterHtml } from "../electron/cards/posterTemplates";
import {
  mergeWeReadBookmarksAndReviews,
  parseWeReadNotebooksResponse,
} from "../electron/importers/wereadSyncService";
import { KnowledgeDatabase } from "../electron/storage/database";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WeRead sync parser & merger", () => {
  it("parses WeRead notebook shelf sorted by recent sortTime", () => {
    const books = parseWeReadNotebooksResponse({
      books: [
        {
          bookId: "1001",
          sort: 1700000100,
          noteCount: 12,
          reviewCount: 3,
          book: {
            title: "置身事内",
            author: "兰小欢",
            cover: "http://cdn.weread.qq.com/cover.jpg",
            publisher: "上海人民出版社",
            publishTime: "2021-08-01",
            isbn: "9787208171336",
          },
        },
        {
          bookId: "1002",
          sort: 1700000500,
          noteCount: 5,
          reviewCount: 1,
          book: { title: "反脆弱", author: "塔勒布" },
        },
      ],
    });

    expect(books).toHaveLength(2);
    expect(books[0]?.bookId).toBe("1002");
    expect(books[1]?.coverUrl).toBe("https://cdn.weread.qq.com/cover.jpg");
    expect(books[1]?.publishedYear).toBe("2021");
  });

  it("merges WeRead chapters, highlights and matching personal reviews cleanly", () => {
    const entries = mergeWeReadBookmarksAndReviews(
      {
        chapters: [{ chapterUid: 3, title: "第三章 地方政府债务" }],
        updated: [
          {
            chapterUid: 3,
            markText: "事权划分的三大原则：外部性、信息复杂性和激励相容。",
            createTime: 1710000000,
          },
        ],
      },
      {
        reviews: [
          {
            review: {
              abstract: "事权划分的三大原则：外部性、信息复杂性和激励相容。",
              content: "组织管理也完全适用这个框架",
              chapterTitle: "第三章 地方政府债务",
              createTime: 1710000100,
            },
          },
          {
            review: {
              abstract: "",
              content: "整本书写得非常克制通透",
              createTime: 1710000200,
            },
          },
        ],
      },
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.chapter).toBe("第三章 地方政府债务");
    expect(entries[0]?.note).toBe("组织管理也完全适用这个框架");
    expect(entries[1]?.quote).toBe("整本书写得非常克制通透");
  });
});

describe("Carousel deck & Monthly reading poster", () => {
  it("splits long markdown draft into cover + body slides + outro and escapes XSS", () => {
    const slides = splitTextIntoCarouselSlides({
      title: "读《思考，快与慢》",
      bookTitle: "思考，快与慢",
      author: "卡尼曼",
      content: "## 观点一\n\n第一段思考内容。\n\n## 观点二\n\n<script>alert(1)</script> 第二段思考。",
    });

    expect(slides[0]?.kind).toBe("cover");
    expect(slides[slides.length - 1]?.kind).toBe("outro");
    expect(slides.length).toBeGreaterThanOrEqual(4);

    const html = renderCarouselSlideHtml(
      {
        templateId: "editorial-paper",
        bookTitle: "思考，快与慢",
        author: "卡尼曼",
        tag: "读书套卡",
        slides,
      },
      2,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders monthly reading poster safely with stats and escaped quotes", () => {
    const html = renderMonthlyPosterHtml({
      themeId: "nocturne-ink",
      monthLabel: "2026 · 11",
      headline: "我的 11 月阅读月报",
      booksCount: 4,
      highlightsCount: 38,
      draftsCount: 5,
      books: [{ title: "置身事内", author: "兰小欢" }],
      quotes: [{ quote: "<img src=x onerror=alert(1)> 真金句", bookTitle: "置身事内" }],
      keywords: ["系统思考", "长期主义"],
    });
    expect(html).not.toContain("<img ");
    expect(html).toContain("38");
    expect(html).toContain("系统思考");
  });
});

describe("DB recall, reading stats & browser selection overlay", () => {
  it("returns random recall highlights and monthly stats from SQLite", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diandian-stats-"));
    tempDirs.push(dir);
    const db = new KnowledgeDatabase(path.join(dir, "db.sqlite3"));
    try {
      const b1 = db.findOrCreateBook({ title: "原则", author: "达利欧", tags: ["决策", "系统"] });
      db.addHighlight({ bookId: b1.id, quote: "痛苦 + 反思 = 进步", note: "极简公式" });
      db.createDraft({
        bookId: b1.id,
        title: "读《原则》",
        kind: "review",
        authorKind: "human",
        content: "我的真实复盘",
      });

      const recall = db.getRandomRecallHighlight();
      expect(recall?.bookTitle).toBe("原则");
      expect(recall?.note).toBe("极简公式");

      const stats = db.getReadingStats();
      expect(stats.totalBooks).toBe(1);
      expect(stats.totalHighlights).toBe(1);
      expect(stats.totalDrafts).toBe(1);
      expect(stats.suggestedKeywords).toContain("决策");
    } finally {
      db.close();
    }
  });

  it("embeds secret per-tab nonce in closed Shadow-DOM selection toolbar script", () => {
    const script = buildSelectionToolbarScript("nonce-abc-123");
    expect(script).toContain("attachShadow({ mode: \"closed\" })");
    expect(script).toContain("nonce-abc-123");
    expect(script).toContain("存书库");
    expect(script).toContain("问小金毛");
    expect(script).toContain("写草稿");
  });

  it("formats drafts into Xiaohongshu native long-form semantic HTML + plain text", () => {
    const res = formatDraftForXiaohongshu(
      "读完《原则》的 3 个反思",
      [
        "## 一、痛苦 + 反思 = 进步",
        "",
        "> 真正让你成长的不是经历本身，而是复盘。",
        "",
        "1. 记录每一次**关键决策**",
        "2. 定期回头核对假设",
      ].join("\n"),
    );

    expect(res.html).toContain("<h1>读完《原则》的 3 个反思</h1>");
    expect(res.html).toContain("<h2>一、痛苦 + 反思 = 进步</h2>");
    expect(res.html).toContain("<blockquote><p>真正让你成长的不是经历本身，而是复盘。</p></blockquote>");
    expect(res.html).toContain("<ol><li>记录每一次<strong>关键决策</strong></li><li>定期回头核对假设</li></ol>");
    expect(res.plainText).toContain("1. 记录每一次关键决策");
  });
});
