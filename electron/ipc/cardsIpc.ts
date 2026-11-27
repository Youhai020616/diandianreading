import fs from "node:fs";
import path from "node:path";
import { clipboard, ClipboardItem, dialog } from "electron";
import { CARD_TEMPLATES, renderReadingCardHtml, type ReadingCardPayload } from "../cards/cardTemplates";
import { splitTextIntoCarouselSlides, type CarouselDeckPayload } from "../cards/carouselTemplates";
import {
  extractConceptVisualFromDraft,
  renderConceptVisualHtml,
  type ConceptVisualPayload,
} from "../cards/conceptVisualTemplates";
import type { MonthlyPosterPayload } from "../cards/posterTemplates";
import { listDownloadedBooks } from "../router/downloadedBooks";
import { searchOnlineBookMetadata } from "../router/metadataService";
import { fileNameTitle, isSameBookTitle, normalizeBookTitleKey } from "../cards/bookTitleMatch";
import { state, ipc } from "../appState";

export function registerCardsIpc(): void {
  // ---------- Sandboxed Offline Reading Card Baker ----------

  ipc.handle("cards:templates", () => CARD_TEMPLATES);

  ipc.handle("cards:preview-html", (_win, payload: ReadingCardPayload) => ({
    html: renderReadingCardHtml(payload),
  }));

  ipc.handle("cards:bake-copy-png", async (_win, payload: ReadingCardPayload) => {
    if (!state.cardBaker) throw new Error("卡片渲染服务未就绪");
    const baked = await state.cardBaker.bakeCardToPng(payload);
    await clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([new Uint8Array(baked.png)], { type: "image/png" }),
      }),
    ]);
    return {
      copied: true,
      width: baked.width,
      height: baked.height,
      bytes: baked.png.length,
    };
  });

  ipc.handle("cards:bake-save-png", async (win, payload: ReadingCardPayload) => {
    if (!state.cardBaker) throw new Error("卡片渲染服务未就绪");
    const baked = await state.cardBaker.bakeCardToPng(payload);
    const safeName = (payload.bookTitle || "reading-card")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .trim()
      .slice(0, 48);
    const saveRes = await dialog.showSaveDialog(win, {
      title: "保存高清书摘卡片 (PNG)",
      defaultPath: `${safeName || "reading-card"}-${payload.templateId}.png`,
      filters: [{ name: "PNG 图像", extensions: ["png"] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { canceled: true as const };
    }
    fs.writeFileSync(saveRes.filePath, baked.png);
    return {
      canceled: false as const,
      filePath: saveRes.filePath,
      width: baked.width,
      height: baked.height,
      bytes: baked.png.length,
    };
  });

  ipc.handle(
    "cards:split-carousel",
    (
      _win,
      input: { title: string; bookTitle: string; author?: string; content: string; maxBodySlides?: number },
    ) => splitTextIntoCarouselSlides(input),
  );

  ipc.handle(
    "cards:bake-copy-carousel-slide",
    async (_win, input: { deck: CarouselDeckPayload; slideIndex: number }) => {
      if (!state.cardBaker) throw new Error("卡片渲染服务未就绪");
      const baked = await state.cardBaker.bakeCarouselSlideToPng(input.deck, input.slideIndex);
      await clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([new Uint8Array(baked.png)], { type: "image/png" }),
        }),
      ]);
      return { copied: true, width: baked.width, height: baked.height, bytes: baked.png.length };
    },
  );

  ipc.handle("cards:bake-export-carousel-folder", async (win, deck: CarouselDeckPayload) => {
    if (!state.cardBaker) throw new Error("卡片渲染服务未就绪");
    if (!Array.isArray(deck.slides) || deck.slides.length === 0) {
      throw new Error("套卡内容为空");
    }
    const pick = await dialog.showOpenDialog(win, {
      title: "选择小红书多页套卡 PNG 批量导出目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (pick.canceled || !pick.filePaths[0]) {
      return { canceled: true as const };
    }
    const safeTitle = (deck.bookTitle || deck.slides[0]?.heading || "reading-deck")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .trim()
      .slice(0, 36);
    const outDir = path.join(pick.filePaths[0], `${safeTitle || "reading-deck"}-套卡`);
    fs.mkdirSync(outDir, { recursive: true });

    const files: string[] = [];
    for (let idx = 0; idx < deck.slides.length; idx++) {
      const slide = deck.slides[idx]!;
      const baked = await state.cardBaker.bakeCarouselSlideToPng(deck, idx);
      const label = slide.kind === "cover" ? "封面" : slide.kind === "outro" ? "尾页" : `正文${idx}`;
      const fileName = `${String(idx + 1).padStart(2, "0")}-${label}.png`;
      const fullPath = path.join(outDir, fileName);
      fs.writeFileSync(fullPath, baked.png);
      files.push(fileName);
    }
    return { canceled: false as const, folderPath: outDir, files };
  });

  ipc.handle("cards:bake-copy-poster", async (_win, payload: MonthlyPosterPayload) => {
    if (!state.cardBaker) throw new Error("卡片渲染服务未就绪");
    const baked = await state.cardBaker.bakePosterToPng(payload);
    await clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([new Uint8Array(baked.png)], { type: "image/png" }),
      }),
    ]);
    return { copied: true, width: baked.width, height: baked.height, bytes: baked.png.length };
  });

  ipc.handle("cards:bake-save-poster", async (win, payload: MonthlyPosterPayload) => {
    if (!state.cardBaker) throw new Error("卡片渲染服务未就绪");
    const baked = await state.cardBaker.bakePosterToPng(payload);
    const safeMonth = (payload.monthLabel || "monthly").replace(/[^0-9a-zA-Z_-]+/g, "-");
    const saveRes = await dialog.showSaveDialog(win, {
      title: "保存高清阅读月报海报 (PNG)",
      defaultPath: `diandian-reading-poster-${safeMonth}.png`,
      filters: [{ name: "PNG 图像", extensions: ["png"] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { canceled: true as const };
    }
    fs.writeFileSync(saveRes.filePath, baked.png);
    return {
      canceled: false as const,
      filePath: saveRes.filePath,
      width: baked.width,
      height: baked.height,
      bytes: baked.png.length,
    };
  });

  ipc.handle(
    "cards:extract-concept",
    async (_win, input: { title: string; content: string; bookId?: string; bookTitle?: string }) => {
      const extracted = extractConceptVisualFromDraft(
        String(input?.title ?? ""),
        String(input?.content ?? ""),
        input?.bookTitle,
      );

      // The extractor already prefers a real explicit book title and drops site names such as
      // "微信读书"; a draft without a book has bookTitle "" which must not shadow 《…》 mentions.
      let resolvedBookTitle = extracted.bookTitle ?? "";
      let resolvedAuthor = "";
      let coverDataUrl: string | null = null;

      try {
        const db = state.knowledgeDb;
        if (db) {
          let matchedBook = typeof input?.bookId === "string" && input.bookId ? db.getBook(input.bookId) : null;
          if (!matchedBook && resolvedBookTitle) {
            const target = resolvedBookTitle;
            const allBooks = db.listBooks("");
            matchedBook =
              allBooks.find((b) => normalizeBookTitleKey(b.title) === normalizeBookTitleKey(target))
              ?? allBooks.find((b) => isSameBookTitle(b.title, target))
              ?? null;
          }
          if (matchedBook) {
            resolvedBookTitle = matchedBook.title || resolvedBookTitle;
            resolvedAuthor = matchedBook.author || "";
            if (matchedBook.coverUrl && state.bookCovers) {
              coverDataUrl = await state.bookCovers.get(matchedBook.coverUrl, true).catch(() => null);
            }
          }
        }

        // Check local downloaded ebooks for an embedded EPUB/PDF cover if still missing
        if (!coverDataUrl && resolvedBookTitle && state.zlibService && state.downloadedCovers) {
          const target = resolvedBookTitle;
          const files = await listDownloadedBooks(state.zlibService.getDownloadDir()).catch(() => []);
          const hit = files.find((f) => isSameBookTitle(fileNameTitle(f.fileName), target));
          if (hit) {
            coverDataUrl = await state.downloadedCovers.preview(hit.filePath).catch(() => null);
          }
        }

        // Fast bounded online cover lookup (<= 2.2s); only a candidate with the same title counts.
        if (!coverDataUrl && resolvedBookTitle && state.bookCovers) {
          const covers = state.bookCovers;
          const target = resolvedBookTitle;
          const knownAuthor = resolvedAuthor;
          const online = await Promise.race([
            (async () => {
              const { candidates } = await searchOnlineBookMetadata(target, { title: target, author: knownAuthor });
              const cand = candidates.find((c) => Boolean(c.coverUrl) && isSameBookTitle(c.title, target));
              if (!cand) return null;
              return { cover: await covers.get(cand.coverUrl, true), author: cand.author };
            })(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_200)),
          ]).catch(() => null);
          if (online?.cover) {
            coverDataUrl = online.cover;
            if (!resolvedAuthor && online.author) resolvedAuthor = online.author;
          }
        }
      } catch {
        // Non-fatal: typographic clothbound hardcover cover renders automatically when coverDataUrl is absent.
      }

      return {
        ...extracted,
        ...(resolvedBookTitle ? { bookTitle: resolvedBookTitle } : {}),
        ...(resolvedAuthor ? { author: resolvedAuthor } : {}),
        ...(coverDataUrl ? { coverDataUrl } : {}),
      };
    },
  );

  ipc.handle("cards:preview-concept-html", (_win, payload: ConceptVisualPayload) => ({
    html: renderConceptVisualHtml(payload),
  }));

  ipc.handle("cards:bake-copy-concept", async (_win, payload: ConceptVisualPayload) => {
    if (!state.cardBaker) throw new Error("视觉渲染服务未就绪");
    const baked = await state.cardBaker.bakeConceptVisualToPng(payload);
    await clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([new Uint8Array(baked.png)], { type: "image/png" }),
      }),
    ]);
    return { copied: true, width: baked.width, height: baked.height, bytes: baked.png.length };
  });

  ipc.handle("cards:bake-save-concept", async (win, payload: ConceptVisualPayload) => {
    if (!state.cardBaker) throw new Error("视觉渲染服务未就绪");
    const baked = await state.cardBaker.bakeConceptVisualToPng(payload);
    const safeName = (payload.title || "visual").replace(/[^0-9a-zA-Z\u4e00-\u9fff_-]+/g, "-").slice(0, 28);
    const saveRes = await dialog.showSaveDialog(win, {
      title: "保存高清概念图 / 思维导图 (PNG)",
      defaultPath: `diandian-${payload.layout}-${safeName}.png`,
      filters: [{ name: "PNG 图像", extensions: ["png"] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { canceled: true as const };
    }
    fs.writeFileSync(saveRes.filePath, baked.png);
    return {
      canceled: false as const,
      filePath: saveRes.filePath,
      width: baked.width,
      height: baked.height,
      bytes: baked.png.length,
    };
  });
}
