import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractConceptVisualFromDraft,
  renderConceptVisualHtml,
} from "../electron/cards/conceptVisualTemplates";
import { reconstructOcrParagraphs } from "../electron/browser/canvasOcr";
import { KindleSettingsStore } from "../electron/router/kindleSmtpService";
import { fetchAvailableModels, parseOpenAiModelsPayload } from "../electron/security/modelCatalog";
import { KnowledgeDatabase } from "../electron/storage/database";
import { buildHeuristicStyleSuggestions } from "../electron/twin/styleDistiller";
import { TwinStore } from "../electron/twin/twinStore";
import { cleanQuoteDraftTitle, prepareDraftFromAssistantReply } from "../src/lib/draftCleanup";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Crawled-project v2 upgrades (FTS5 trigram, STYLE distiller, Concept Visuals, Notebooks)", () => {
  it("indexes Chinese highlights with FTS5 trigram and surfaces related quotes while drafting", () => {
    const dir = makeTempDir("diandian-fts-");
    const db = new KnowledgeDatabase(path.join(dir, "knowledge.db"));
    try {
      const b1 = db.findOrCreateBook({ title: "认知觉醒", author: "周岭" });
      const b2 = db.findOrCreateBook({ title: "纳瓦尔宝典", author: "埃里克" });

      db.addHighlight({
        bookId: b1.id,
        quote: "只有当知识能够帮助你做世界决策的时候，它才是你的知识。",
        note: "元认知与真实反馈闭环",
      });
      db.addHighlight({
        bookId: b2.id,
        quote: "复利不仅发生在财富积累里，也发生在长期人际信任与深度阅读中。",
        note: "长期主义杠杆",
      });

      // FTS5 trigram substring match without spaces
      const searchHits = db.searchAllHighlights("世界决策", 10);
      expect(searchHits).toHaveLength(1);
      expect(searchHits[0]?.bookTitle).toBe("认知觉醒");

      // Related highlights while writing a draft about 长期主义 / 财富复利
      const related = db.findRelatedHighlights(
        "今天写一篇关于长期主义与财富复利的思考，为什么深度阅读同样带来复利？",
        3,
      );
      expect(related.length).toBeGreaterThanOrEqual(1);
      expect(related[0]?.bookTitle).toBe("纳瓦尔宝典");
      expect(related[0]?.matchedTerms.length).toBeGreaterThan(0);

      // Should skip highlights already verbatim pasted in the draft
      const skipped = db.findRelatedHighlights(
        "复利不仅发生在财富积累里，也发生在长期人际信任与深度阅读中。",
        3,
      );
      expect(skipped.some((h) => h.bookTitle === "纳瓦尔宝典")).toBe(false);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distills writing habits from AI vs Human diff and appends to STYLE.md non-destructively", () => {
    const dir = makeTempDir("diandian-twin-");
    try {
      const twin = new TwinStore(dir);
      const before = twin.read();

      const aiDraft =
        "总而言之，值得注意的是这是一本发人深省的书。首先我们应该理解作者的框架，其次我们需要在日常生活中不断践行，最后由此可见阅读非常重要。";
      const humanEdit =
        "我合上书后最大的触动，是发现自己以前把「努力」当成了逃避思考的借口。上周我试着砍掉一半计划，反而推进更快。";

      const suggestions = buildHeuristicStyleSuggestions(aiDraft, humanEdit, "");
      expect(suggestions.length).toBeGreaterThanOrEqual(2);

      const { state, addedCount } = twin.appendLearnedStyleRules(suggestions.map((s) => s.rule));
      expect(addedCount).toBe(suggestions.length);
      expect(state.styleMd).toContain("我的写作与表达风格（STYLE）");
      expect(state.styleMd).toContain("## 从人工改稿自动沉淀的习惯");
      expect(state.sha256).not.toBe(before.sha256);

      // Re-appending same rules must deduplicate cleanly
      const second = twin.appendLearnedStyleRules(suggestions.map((s) => s.rule));
      expect(second.addedCount).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts draft structure and renders safe Mindmap SVG & Infographic HTML", () => {
    const draft = [
      "## 一、为什么越自律越焦虑",
      "- 意志力是消耗品，环境设计才是杠杆",
      "- 把手机放客厅比立十个 Flag 管用",
      "",
      "## 二、阅读的复利来自输出",
      "> 没有经过自己转述的知识，只是借来的装饰品。",
      "- 写下反驳作者的两句话",
    ].join("\n");

    const extracted = extractConceptVisualFromDraft("反脆弱阅读法", draft, "认知觉醒");
    expect(extracted.branches.length).toBe(2);
    expect(extracted.callout).toContain("没有经过自己转述的知识");

    const mmHtml = renderConceptVisualHtml({ ...extracted, layout: "mindmap", theme: "cloud-blue" });
    expect(mmHtml).toContain("<svg");
    expect(mmHtml).toContain("MINDMAP");
    expect(mmHtml).toContain("反脆弱阅读法");

    const infoHtml = renderConceptVisualHtml({ ...extracted, layout: "infographic", theme: "nocturne-ink" });
    expect(infoHtml).toContain("FRAMEWORK");
    expect(infoHtml).toContain("01");

    // Bare numeral headings ("### 一 / ### 二") should distill real punchy headings instead of bare "一 / 二"
    const bareDraft = [
      "### 一",
      "> 同一条理由可以导致上涨或下跌，听起来是否可笑？这与投资的艺术属性有关。",
      "这句话表面在讲市场不讲逻辑，实际取消的是「找对理由」这件事的价值。",
      "",
      "### 二",
      "这个反常识案例比任何估值理论都好用。一个理由被所有人同时持有的时候，它就不再是理由。",
    ].join("\n");
    const distilled = extractConceptVisualFromDraft("《一个投资家的20年》· 相信", bareDraft);
    expect(distilled.branches[0]?.heading).not.toBe("一");
    expect(distilled.branches[0]?.heading).toContain("找对理由");
    expect(distilled.branches[1]?.heading).not.toBe("二");
    const coverHtml = renderConceptVisualHtml({ ...distilled, layout: "cover", theme: "editorial-paper" });
    expect(coverHtml).toContain("READING NOTES");
    expect(coverHtml).toContain("一个投资家的20年");
  });

  it("creates, populates, and manages Surf-style Topic Notebooks in SQLite", () => {
    const dir = makeTempDir("diandian-nb-");
    const db = new KnowledgeDatabase(path.join(dir, "knowledge.db"));
    try {
      const book = db.findOrCreateBook({ title: "反脆弱", author: "塔勒布" });
      const nb = db.createNotebook({ name: "长期主义研究", icon: "✦" });
      expect(nb.items).toHaveLength(0);

      const withBook = db.addNotebookItem(nb.id, {
        itemKind: "book",
        itemRef: book.id,
        title: book.title,
        meta: "塔勒布",
      });
      const withWeb = db.addNotebookItem(nb.id, {
        itemKind: "web",
        itemRef: "https://book.douban.com/subject/25815239/",
        title: "豆瓣书评",
      });
      expect(withBook.items).toHaveLength(1);
      expect(withWeb.items).toHaveLength(2);

      // Deleting the book cleans up its notebook link cleanly
      db.deleteBook(book.id);
      const afterBookDel = db.listNotebooks().find((n) => n.id === nb.id);
      expect(afterBookDel?.items).toHaveLength(1);
      expect(afterBookDel?.items[0]?.itemKind).toBe("web");

      db.deleteNotebook(nb.id);
      expect(db.listNotebooks()).toHaveLength(0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("encrypts Kindle SMTP credentials via safeStorage and rejects header injection", () => {
    const dir = makeTempDir("diandian-kindle-");
    const mockSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (v: string) => Buffer.from(`enc:${v}`, "utf8"),
      decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
    };
    const store = new KindleSettingsStore(dir, mockSafeStorage);
    try {
      expect(store.readPublic().configured).toBe(false);

      const saved = store.save({
        to: "reader@kindle.com",
        from: "me@qq.com",
        smtpHost: "smtp.qq.com",
        smtpPort: 465,
        smtpSecurity: "tls",
        password: "secret-auth-code-16",
      });
      expect(saved.configured).toBe(true);
      expect(saved.hasPassword).toBe(true);
      expect((saved as unknown as Record<string, unknown>).password).toBeUndefined();

      // Verify disk file does NOT contain raw plaintext password
      const onDisk = fs.readFileSync(path.join(dir, "config", "kindle-settings.json"), "utf8");
      expect(onDisk).not.toContain("secret-auth-code-16");
      expect(store.readRaw().password).toBe("secret-auth-code-16");

      // Header injection attempt must be rejected
      expect(() =>
        store.save({
          to: "reader@kindle.com\r\nBcc: evil@example.com",
          from: "me@qq.com",
          smtpHost: "smtp.qq.com",
          smtpPort: 465,
          smtpSecurity: "tls",
        }),
      ).toThrow();

      const cleared = store.clear();
      expect(cleared.configured).toBe(false);
      expect(cleared.hasPassword).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists, resumes, lists, and deletes Agent chat history sessions in SQLite", () => {
    const dir = makeTempDir("diandian-chat-");
    const db = new KnowledgeDatabase(path.join(dir, "knowledge.db"));
    try {
      const saved = db.upsertChatSession({
        id: "chat_1",
        title: "《认知觉醒》跨书碰撞",
        harnessSessionId: "dsh_sess_abc",
        messages: [
          { id: "m1", role: "user", text: "帮我对比《认知觉醒》和《悉达多》", contexts: ["《认知觉醒》"] },
          {
            id: "m2",
            role: "assistant",
            text: "两本书都谈到消除内在模糊的重要性。",
            reasoning: "检索历史划线...",
            tools: [{ name: "library_search_highlights", status: "done" }],
          },
        ],
      });
      expect(saved.id).toBe("chat_1");
      expect(saved.harnessSessionId).toBe("dsh_sess_abc");
      expect(saved.messageCount).toBe(2);

      // Updating without harnessSessionId preserves existing harnessSessionId
      db.upsertChatSession({
        id: "chat_1",
        title: "《认知觉醒》跨书碰撞",
        messages: [
          { id: "m1", role: "user", text: "帮我对比《认知觉醒》和《悉达多》", contexts: ["《认知觉醒》"] },
          { id: "m2", role: "assistant", text: "两本书都谈到消除内在模糊的重要性。" },
          { id: "m3", role: "user", text: "继续展开讲讲" },
        ],
      });

      const detail = db.getChatSession("chat_1");
      expect(detail?.harnessSessionId).toBe("dsh_sess_abc");
      expect(detail?.messages).toHaveLength(3);
      expect(detail?.messages[0]?.contexts).toEqual(["《认知觉醒》"]);

      db.deleteChatSession("chat_1");
      expect(db.listChatSessions()).toHaveLength(0);
      expect(db.getChatSession("chat_1")).toBeNull();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers chat-compatible models from OpenAI-compatible /models API with curated sorting and graceful fallback", async () => {
    const parsed = parseOpenAiModelsPayload({
      data: [
        { id: "text-embedding-3-small" },
        { id: "whisper-1" },
        { id: "deepseek-reasoner" },
        { id: "deepseek-chat" },
        { id: "deepseek-custom-beta" },
      ],
    });
    expect(parsed).toEqual(["deepseek-reasoner", "deepseek-chat", "deepseek-custom-beta"]);

    const mockOkFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "deepseek-reasoner" },
            { id: "deepseek-chat" },
            { id: "text-embedding-v1" },
          ],
        }),
      }) as Response) as typeof fetch;

    const live = await fetchAvailableModels(
      {
        provider: "deepseek",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
      },
      mockOkFetch,
    );
    expect(live.source).toBe("api");
    expect(live.providerLabel).toBe("DeepSeek");
    expect(live.models.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(live.models[0]?.tag).toBe("推荐");
    expect(live.models[1]?.tag).toBe("推理");

    // Graceful preset fallback if endpoint rejects /models
    const mockFailFetch = (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch;
    const fallback = await fetchAvailableModels(
      {
        provider: "deepseek",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
      },
      mockFailFetch,
    );
    expect(fallback.source).toBe("preset");
    expect(fallback.models.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(fallback.error).toBeTruthy();
  });

  it("reconstructs clean Chinese paragraphs from Apple Vision bounding-box observations", () => {
    const text = reconstructOcrParagraphs([
      { text: "推荐序", x: 0.1, y: 0.8, w: 0.12, h: 0.032 },
      { text: "前不久听说，业内最近出了《人类简史》这么一本奇书。", x: 0.1, y: 0.72, w: 0.75, h: 0.022 },
      { text: "此书在2012年以希伯来文出版，很快就被翻译成近30种文字。", x: 0.1, y: 0.69, w: 0.75, h: 0.022 },
      { text: "而这一看，我就立刻着道了，几乎一口气读完。", x: 0.1, y: 0.62, w: 0.72, h: 0.022 },
    ]);
    expect(text).toBe(
      "推荐序\n\n前不久听说，业内最近出了《人类简史》这么一本奇书。此书在2012年以希伯来文出版，很快就被翻译成近30种文字。\n\n而这一看，我就立刻着道了，几乎一口气读完。",
    );
  });

  it("cleans AI chat chatter, normalizes headings, and derives concise draft titles on Save as Draft", () => {
    const rawReply = [
      "三条已经记进书库了（新建书目「一个投资家的20年（第2版）」，章节都归到「相信·2008年8月20日」）。右边这一屏很短，所以我只提炼这屏上真正出现过的话。",
      "",
      "**一**",
      "",
      "> 同一条理由可以导致上涨或下跌，听起来是否可笑？这与投资的艺术属性有关。",
      "",
      "这句话表面在讲市场不讲逻辑，实际取消的是「找对理由」这件事的价值。",
      "",
      "**二**",
      "",
      "> 但是众人期待已久的奥运股市行情却没有来。",
      "",
      "一个理由被所有人同时持有的时候，它就不再是理由，而是仓位。",
      "",
      "要是你想把这段抽象画的类比读完，在右边往下滚一屏再叫我，我接着补第三条的思考。需要的话我可以把它们串成一张卡片文案或者一段随笔草稿存进创作工作台。",
    ].join("\n");

    const prepared = prepareDraftFromAssistantReply(rawReply);
    expect(prepared.title).toBe("《一个投资家的20年》· 相信");
    expect(prepared.bookTitle).toBe("一个投资家的20年（第2版）");
    expect(prepared.kind).toBe("note");
    expect(prepared.content).not.toContain("三条已经记进书库了");
    expect(prepared.content).not.toContain("往下滚一屏再叫我");
    expect(prepared.content).toContain("### 一");
    expect(prepared.content).toContain("### 二");

    // Generic site names must never become "读《微信读书》有感"
    expect(cleanQuoteDraftTitle("微信读书", "一个理由被所有人同时持有的时候，它就不再是理由。")).toBe(
      "一个理由被所有人同时持有的时候",
    );
  });
});
