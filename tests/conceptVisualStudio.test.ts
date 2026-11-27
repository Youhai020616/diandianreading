import { describe, expect, it } from "vitest";
import { fileNameTitle, isSameBookTitle } from "../electron/cards/bookTitleMatch";
import { isAllowedCardSandboxUrl } from "../electron/cards/cardBaker";
import {
  extractConceptVisualFromDraft,
  renderConceptVisualHtml,
} from "../electron/cards/conceptVisualTemplates";

describe("Xiaohongshu 3D Book Cover & 4-Archetype Visual Studio", () => {
  const TINY_PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  it("renders 3D book cover, clothbound fallback, versus contrast card, sketchnote grid, and broadsheet safely", () => {
    const draft = [
      "> 同一条理由可以导致上涨或下跌，听起来是否可笑？这与投资的艺术属性有关。",
      "### 一",
      "多数人沉迷在事后给价格找因果链，以为抓住理由就能预测下一次。",
      "### 二",
      "当一个利好被所有人同时持有的时候，它就不再是理由，而是拥挤的仓位。",
      "### 三",
      "看盘先问自己一句：我是不是先有了仓位结论，再去市场里挑顺眼的理由？",
    ].join("\n");

    const extracted = extractConceptVisualFromDraft("《一个投资家的20年》· 相信", draft);
    expect(extracted.bookTitle).toBe("一个投资家的20年");
    expect(extracted.branches.length).toBe(3);

    // 1. Cover with real base64 cover image
    const coverWithImg = renderConceptVisualHtml({
      ...extracted,
      author: "杨天南",
      coverDataUrl: TINY_PNG_DATA_URL,
      layout: "cover",
      theme: "editorial-paper",
    });
    expect(coverWithImg).toContain("READING NOTES");
    expect(coverWithImg).toContain(`src="${TINY_PNG_DATA_URL}"`);
    expect(coverWithImg).toContain("book-3d is-hero");

    // 2. Rejects remote HTTP or javascript URLs in coverDataUrl, falling back to clothbound hardcover
    const coverFallback = renderConceptVisualHtml({
      ...extracted,
      coverDataUrl: "https://evil.example.com/tracker.png",
      layout: "cover",
      theme: "botanical-mist",
    });
    expect(coverFallback).not.toContain("evil.example.com");
    expect(coverFallback).toContain("book-cloth-face");

    // 3. Versus cognitive shift card
    const versusHtml = renderConceptVisualHtml({
      ...extracted,
      layout: "versus",
      theme: "memo-grid",
    });
    expect(versusHtml).toContain("COGNITIVE SHIFT");
    expect(versusHtml).toContain("VS · 认知重构");

    // 4. Sketchnote mindmap & Broadsheet infographic
    const sketchHtml = renderConceptVisualHtml({
      ...extracted,
      layout: "mindmap",
      theme: "cloud-blue",
    });
    expect(sketchHtml).toContain("MINDMAP");
    expect(sketchHtml).toContain("sketch-card");

    const broadsheetHtml = renderConceptVisualHtml({
      ...extracted,
      coverDataUrl: TINY_PNG_DATA_URL,
      layout: "infographic",
      theme: "nocturne-ink",
    });
    expect(broadsheetHtml).toContain("FRAMEWORK");
    expect(broadsheetHtml).toContain("broadsheet-row");

    // 5. CardBaker sandbox URL filter permits htmlcard:// and raster base64 covers while blocking network/SVG/file URLs
    expect(isAllowedCardSandboxUrl("htmlcard://document/123")).toBe(true);
    expect(isAllowedCardSandboxUrl(TINY_PNG_DATA_URL)).toBe(true);
    expect(isAllowedCardSandboxUrl("https://cdn.weread.qq.com/cover.jpg")).toBe(false);
    expect(isAllowedCardSandboxUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedCardSandboxUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(false);
  });
});

describe("concept visual book matching", () => {
  it("matches the same book across subtitles and file-name suffixes, not mere substrings", () => {
    expect(isSameBookTitle("认知觉醒", "认知觉醒：开启自我改变的原动力")).toBe(true);
    expect(isSameBookTitle("《认知觉醒》", "认知觉醒")).toBe(true);
    expect(isSameBookTitle("认知觉醒", fileNameTitle("认知觉醒 (周岭) (z-library.sk).epub"))).toBe(true);
    expect(isSameBookTitle("Thinking, Fast and Slow", "thinking fast and slow")).toBe(true);
    expect(isSameBookTitle("认知觉醒", "认知")).toBe(false);
    expect(isSameBookTitle("三体", "三体Ⅱ：黑暗森林")).toBe(false);
    expect(isSameBookTitle("哈利·波特与魔法石", "哈利·波特与密室")).toBe(false);
    expect(isSameBookTitle("", "认知觉醒")).toBe(false);
  });

  it("ignores site names and empty explicit book titles when detecting the book", () => {
    const draft = "### 一\n《穷查理宝典》里反复出现的逆向思考。";
    expect(extractConceptVisualFromDraft("逆向思考", draft, "").bookTitle).toBe("穷查理宝典");
    expect(extractConceptVisualFromDraft("逆向思考", draft, "微信读书").bookTitle).toBe("穷查理宝典");
    expect(extractConceptVisualFromDraft("逆向思考", draft, "小红书创作服务平台").bookTitle).toBe("穷查理宝典");
    expect(extractConceptVisualFromDraft("逆向思考", draft, "《原则》").bookTitle).toBe("原则");
  });
});
