import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReaderTranslationService } from "../electron/router/readerTranslation";
import { KnowledgeDatabase } from "../electron/storage/database";
import type { ModelSettings } from "../electron/security/secretStore";

let temp: string;
let db: KnowledgeDatabase;
let settings: ModelSettings;
let fetchModel = vi.fn<typeof fetch>();
let service: ReaderTranslationService;

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "diandian-translation-"));
  db = new KnowledgeDatabase(path.join(temp, "state.sqlite"));
  settings = { provider: "openai-compatible", model: "test-model", baseUrl: "https://translator.invalid/custom/v1/", apiKey: "test-secret" };
  fetchModel = vi.fn<typeof fetch>();
  service = new ReaderTranslationService(db, () => settings, fetchModel);
});
afterEach(async () => {
  db.close();
  await fs.rm(temp, { recursive: true });
});

const chapter = { target: "en" as const, texts: ["小教堂", "信任自己是一个开始。"] };
function reply(translations: Array<{ id: number; text: string }>) {
  return Response.json({ choices: [{ message: { content: JSON.stringify({ translations }) } }] });
}

it("sends only missing texts to the configured model once, and maps reordered IDs and duplicates back to the page", async () => {
  fetchModel.mockResolvedValueOnce(reply([{ id: 1, text: "Trusting yourself is a beginning." }, { id: 0, text: "Chapel" }]));
  const expanded = { ...chapter, texts: [...chapter.texts, "小教堂"] };
  const result = ["Chapel", "Trusting yourself is a beginning.", "Chapel"];
  const first = service.translate(1, expanded);
  const overlap = service.translate(1, chapter);
  await expect(first).resolves.toEqual(result);
  await expect(overlap).resolves.toEqual(result.slice(0, 2));
  expect(fetchModel).toHaveBeenCalledTimes(1);
  const [url, init] = fetchModel.mock.calls[0]!;
  expect(String(url)).toBe("https://translator.invalid/custom/v1/chat/completions");
  expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer test-secret" } });
  const sent = JSON.parse(String(init?.body));
  expect(sent.model).toBe("test-model");
  expect(sent.messages).toHaveLength(2);
  expect(sent.messages[0].content).toContain("English");
  expect(JSON.parse(sent.messages[1].content)).toEqual(chapter.texts.map((text, id) => ({ id, text })));

  fetchModel.mockResolvedValueOnce(reply([{ id: 0, text: "Forest" }]));
  await expect(service.translate(1, { target: "en", texts: ["小教堂", "森林"] })).resolves.toEqual(["Chapel", "Forest"]);
  const followup = JSON.parse(String(fetchModel.mock.calls[1]![1]?.body));
  expect(JSON.parse(followup.messages[1].content)).toEqual([{ id: 0, text: "森林" }]);
});

it("can read partial and full offline translations after relaunch, isolated by language, source, provider and model", async () => {
  fetchModel.mockResolvedValueOnce(reply([{ id: 0, text: "小教堂" }]));
  const input = { target: "zh" as const, texts: ["Chapel"] };
  await service.translate(1, input);
  expect(JSON.parse(String(fetchModel.mock.calls[0]![1]?.body)).messages[0].content).toContain("Simplified Chinese");
  db.close();
  db = new KnowledgeDatabase(path.join(temp, "state.sqlite"));
  service = new ReaderTranslationService(db, () => settings, fetchModel);
  settings.apiKey = "";
  const partial = { ...input, texts: ["Chapel", "Town"] };
  await expect(service.translate(1, input)).resolves.toEqual(["小教堂"]);
  await expect(service.translate(1, partial)).rejects.toThrow("API Key");
  expect(service.readCached(partial)).toEqual(["小教堂", null]);
  expect(service.readCached({ ...input, target: "en" })).toEqual([null]);
  settings.model = "other-model";
  expect(service.readCached(input)).toEqual([null]);
  settings.model = "test-model";
  settings.baseUrl = "https://other.invalid";
  expect(service.readCached(input)).toEqual([null]);
  expect(fetchModel).toHaveBeenCalledTimes(1);
});

it("accepts a compatible local model without authorization and tolerates a fenced JSON reply", async () => {
  settings.baseUrl = "http://localhost:11434/v1";
  settings.apiKey = "";
  const content = '```json\n{"translations":[{"id":0,"text":"字"}]}\n```';
  fetchModel.mockResolvedValue(Response.json({ choices: [{ message: { content } }] }));
  await expect(service.translate(1, { target: "zh", texts: ["Word"] })).resolves.toEqual(["字"]);
  expect(fetchModel.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
});

it("rejects missing and duplicate mappings without caching even the first item", async () => {
  fetchModel.mockResolvedValueOnce(reply([{ id: 0, text: "A" }, { id: 0, text: "B" }]));
  await expect(service.translate(1, chapter)).rejects.toThrow("格式不完整");
  expect(service.readCached(chapter)).toEqual([null, null]);
  fetchModel.mockResolvedValueOnce(reply([{ id: 0, text: "A" }]));
  await expect(service.translate(1, chapter)).rejects.toThrow("格式不完整");
  expect(service.readCached(chapter)).toEqual([null, null]);
});

it("rejects an oversized or invalid batch before fetching and reports provider errors without including response content", async () => {
  await expect(service.translate(1, { target: "en", texts: Array(13).fill("a") })).rejects.toThrow("12");
  await expect(service.translate(1, { target: "en", texts: ["字".repeat(9001)] })).rejects.toThrow("过长");
  await expect(service.translate(1, { target: "en", texts: [" "] })).rejects.toThrow("不能为空");
  expect(fetchModel).not.toHaveBeenCalled();
  fetchModel.mockResolvedValueOnce(new Response("echo test-secret 小教堂", { status: 429, headers: { "Retry-After": "20" } }));
  const rateError = await service.translate(1, chapter).catch((error: Error) => error.message);
  expect(rateError).toContain("过于频繁");
  expect(rateError).not.toMatch(/test-secret|小教堂/);
  await expect(service.translate(1, chapter)).rejects.toThrow("过于频繁");
  expect(fetchModel).toHaveBeenCalledTimes(1);
  settings.model = "another-model";
  fetchModel.mockRejectedValueOnce(new Error("echo test-secret 小教堂"));
  await expect(service.translate(1, chapter)).rejects.toThrow(/^无法连接翻译服务/);
});

it("cancels active requests by owner and prevents canceled queued requests from being sent or cached", async () => {
  fetchModel.mockImplementationOnce(async (_url, init) => {
    const signal = init!.signal!;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const active = service.translate(5, { ...chapter, requestId: "active" });
  const queued = service.translate(8, { ...chapter, requestId: "queued" });
  await vi.waitFor(() => expect(fetchModel).toHaveBeenCalledTimes(1));
  service.cancel(8, "active"); // A different window cannot interrupt the active reader.
  expect(fetchModel.mock.calls[0]![1]?.signal?.aborted).toBe(false);
  service.cancelWindow(8);
  await expect(queued).rejects.toThrow("已取消");
  service.cancel(5, "active");
  await expect(active).rejects.toThrow("已取消");
  expect(fetchModel.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  fetchModel.mockResolvedValueOnce(reply([{ id: 0, text: "New" }]));
  await expect(service.translate(5, { target: "en", texts: ["新"] })).resolves.toEqual(["New"]);
  expect(fetchModel).toHaveBeenCalledTimes(2);
  expect(service.readCached(chapter)).toEqual([null, null]);
});

const deepLChapter = { ...chapter, provider: "deepl" as const };
function deepLReply(...texts: string[]) {
  return Response.json({ translations: texts.map(text => ({ detected_source_language: "ZH", text })) });
}

it("sends a single ordered DeepL Free batch and isolates cached results from the model and target language", async () => {
  let key = "example-free-key:fx";
  service = new ReaderTranslationService(db, () => settings, fetchModel, () => key);
  fetchModel.mockResolvedValueOnce(deepLReply("Chapel", "Trust is a beginning."));
  const duplicate = { ...deepLChapter, texts: [chapter.texts[0]!, ...chapter.texts] };
  await expect(service.translate(1, duplicate)).resolves.toEqual(["Chapel", "Chapel", "Trust is a beginning."]);
  const [url, init] = fetchModel.mock.calls[0]!;
  expect(String(url)).toBe("https://api-free.deepl.com/v2/translate");
  expect(init).toMatchObject({
    method: "POST", redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: "DeepL-Auth-Key example-free-key:fx" },
  });
  expect(JSON.parse(String(init?.body))).toEqual({ text: chapter.texts, target_lang: "EN-US" });
  expect(service.readCached({ ...deepLChapter, target: "zh" })).toEqual([null, null]);
  expect(service.readCached({ ...chapter, provider: "model" })).toEqual([null, null]);

  key = "";
  settings.baseUrl = "invalid model url";
  const noNetwork = vi.fn<typeof fetch>();
  const restarted = new ReaderTranslationService(db, () => settings, noNetwork, () => key);
  await expect(restarted.translate(2, deepLChapter)).resolves.toEqual(["Chapel", "Trust is a beginning."]);
  const partial = { ...deepLChapter, texts: [chapter.texts[0]!, "新段落"] };
  expect(restarted.readCached(partial)).toEqual(["Chapel", null]);
  await expect(restarted.translate(2, partial)).rejects.toThrow(/DeepL API Key/);
  expect(noNetwork).not.toHaveBeenCalled();
});

it("uses the DeepL Pro host and Simplified Chinese target without reading the user's model settings", async () => {
  const getModel = vi.fn(() => settings);
  service = new ReaderTranslationService(db, getModel, fetchModel, () => "pro-key");
  fetchModel.mockResolvedValueOnce(deepLReply("草地", "树林"));
  const input = { provider: "deepl" as const, target: "zh" as const, texts: ["Meadow", "Trees"] };
  await expect(service.translate(1, input)).resolves.toEqual(["草地", "树林"]);
  expect(getModel).not.toHaveBeenCalled();
  const [url, init] = fetchModel.mock.calls[0]!;
  expect(String(url)).toBe("https://api.deepl.com/v2/translate");
  expect(JSON.parse(String(init?.body))).toEqual({ text: input.texts, target_lang: "ZH-HANS" });
  expect(init?.headers).toMatchObject({ Authorization: "DeepL-Auth-Key pro-key" });
});

it("reports DeepL authorization, quota, rate-limit and reply errors without exposing keys or sending a fallback request", async () => {
  let key = "secret-free-key:fx";
  service = new ReaderTranslationService(db, () => settings, fetchModel, () => key);
  for (const [status, error] of [[403, "API Key"], [456, "额度已用完"], [429, "过于频繁"]] as const) {
    fetchModel.mockResolvedValueOnce(new Response("echo: secret-free-key:fx 小教堂", { status }));
    const result = await service.translate(1, deepLChapter).catch((cause: Error) => cause.message);
    expect(result).toContain(error);
    expect(result).not.toMatch(/secret-free-key|小教堂/);
  }
  await expect(service.translate(1, deepLChapter)).rejects.toThrow("过于频繁");
  expect(fetchModel).toHaveBeenCalledTimes(3);
  key = "replacement-key";
  for (const malformed of [deepLReply("only one"), deepLReply("one", " "), new Response("secret-free-key")]) {
    fetchModel.mockResolvedValueOnce(malformed);
    await expect(service.translate(1, deepLChapter)).rejects.toThrow("DeepL 返回的译文不完整");
    expect(service.readCached(deepLChapter)).toEqual([null, null]);
  }
  await expect(service.translate(1, { ...deepLChapter, provider: "unknown" as "deepl" })).rejects.toThrow("翻译服务");
  expect(fetchModel).toHaveBeenCalledTimes(6);
});

it("keeps translations out of the settings table and evicts the least recently read beyond the cache limit", async () => {
  fetchModel.mockResolvedValueOnce(reply([{ id: 0, text: "Chapel" }]));
  await service.translate(1, { target: "en", texts: ["小教堂"] });
  const file = path.join(temp, "state.sqlite");
  db.close();
  // Move the saved translation back to where earlier builds stored it.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(file);
  const saved = raw.prepare("SELECT cache_key, translation FROM reader_translation_cache").all();
  expect(saved).toHaveLength(1);
  raw.prepare("DELETE FROM reader_translation_cache").run();
  raw.prepare("INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)")
    .run(String(saved[0]!.cache_key), String(saved[0]!.translation), new Date().toISOString());
  raw.close();

  db = new KnowledgeDatabase(file, { translationCacheLimit: 2 });
  service = new ReaderTranslationService(db, () => settings, fetchModel);
  expect(service.readCached({ target: "en", texts: ["小教堂"] })).toEqual(["Chapel"]);
  expect(db.getSetting(String(saved[0]!.cache_key))).toBeNull();

  fetchModel.mockResolvedValueOnce(reply([{ id: 0, text: "Forest" }]));
  await service.translate(1, { target: "en", texts: ["森林"] });
  await new Promise(resolve => setTimeout(resolve, 5));
  // Reading the first paragraph again makes the second the oldest entry.
  expect(service.readCached({ target: "en", texts: ["小教堂"] })).toEqual(["Chapel"]);
  await new Promise(resolve => setTimeout(resolve, 5));
  fetchModel.mockResolvedValueOnce(reply([{ id: 0, text: "River" }]));
  await service.translate(1, { target: "en", texts: ["河流"] });
  expect(service.readCached({ target: "en", texts: ["小教堂", "森林", "河流"] })).toEqual(["Chapel", null, "River"]);
});
