import { useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import type { DownloadedBookFile, OpenReaderBook, PublicModelSettings, ReaderAnnotation } from "../types/desktop";
import type { ReaderPreferences, ReaderTranslationMode } from "../reader/types";
import {
  HIGHLIGHT_COLOR_IDS, HIGHLIGHT_COLORS, READER_TEXTURES, READER_THEME_IDS, READER_THEMES, isHighlightColor, isReaderThemeId,
  readerTextureImage, resolveReaderColors, type ReaderHighlightColor, type ReaderTexture, type ReaderThemeMode,
} from "../reader/themes";
import { EpubSurface, type EpubSurfaceHandle } from "../reader/EpubSurface";
import { normalizeReaderFont, readerFonts } from "../reader/fonts";
import { ReaderContents } from "./ReaderContents";
import { ReaderTranslationPanel } from "./ReaderTranslationPanel";
import { useReaderTranslation } from "./useReaderTranslation";
import { formatUserError } from "../utils/formatError";
import {
  IconArrowLeft, IconArrowRight, IconBookOpen, IconCheck, IconClose, IconCopy, IconExternalLink,
  IconLanguages, IconList, IconPanelLeft, IconPenLine, IconRefresh, IconSparkles, IconSquarePen, IconTrash,
} from "./Icons";
import "./LocalReader.css";

interface LocalReaderProps {
  file: DownloadedBookFile;
  initialLocator?: string;
  railOpen: boolean;
  onToggleRail(): void;
  modelSettings: PublicModelSettings | null;
  onOpenModelSettings(): void;
  onBack(): void;
  onAsk(quote: string, title: string): void;
  onNotesChanged(): void;
  onTitle?(title: string): void;
}

type SurfaceProps = ComponentProps<typeof EpubSurface>;
type BookInfo = Parameters<SurfaceProps["onReady"]>[0];
type Location = Parameters<SurfaceProps["onRelocate"]>[0];
type Selection = NonNullable<Parameters<SurfaceProps["onSelection"]>[0]>;
type Anchor = { x: number; y: number; bottom?: number };
type Panel = "toc" | "notes" | "appearance" | "translation";
type SelectionTranslation = { anchor: Anchor; status: "loading" | "done" | "error"; text: string };
const preferenceKey = "diandian.reader.appearance.v1";
const highlightColorKey = "diandian.reader.highlightColor";

function appIsDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

function getPreferences(): ReaderPreferences {
  const defaults: ReaderPreferences = { fontFamily: "serif", fontSize: 20, lineHeight: 1.85, columns: 1,
    theme: "sepia", mode: "auto", texture: "none" };
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || "{}") as Omit<Partial<ReaderPreferences>, "theme"> & { theme?: string };
    // Earlier versions stored a single paper choice; map it onto a palette and a fixed mode.
    const legacy = saved.theme === "paper" ? { theme: "sepia", mode: "light" } as const
      : saved.theme === "light" ? { theme: "default", mode: "light" } as const
        : saved.theme === "dark" ? { theme: "default", mode: "dark" } as const : null;
    return {
      fontFamily: normalizeReaderFont(saved.fontFamily),
      fontSize: [16, 18, 20, 22, 24, 26, 28, 30].includes(Number(saved.fontSize)) ? Number(saved.fontSize) : defaults.fontSize,
      lineHeight: [1.6, 1.85, 2.1].includes(Number(saved.lineHeight)) ? Number(saved.lineHeight) : defaults.lineHeight,
      columns: saved.columns === 2 ? 2 : 1,
      theme: legacy?.theme ?? (isReaderThemeId(saved.theme) ? saved.theme : defaults.theme),
      mode: legacy?.mode ?? (saved.mode === "light" || saved.mode === "dark" || saved.mode === "auto" ? saved.mode : defaults.mode),
      texture: saved.texture === "fine" || saved.texture === "rough" ? saved.texture : defaults.texture,
    };
  } catch {
    return defaults;
  }
}

function getHighlightColor(): ReaderHighlightColor {
  try {
    const saved = localStorage.getItem(highlightColorKey);
    if (isHighlightColor(saved)) return saved;
  } catch { /* Fall back to the default color. */ }
  return "yellow";
}

/** Chinese selections translate to English; everything else to Chinese. */
function translationTarget(text: string): "en" | "zh" {
  const cjk = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  return cjk * 2 >= text.replace(/\s/g, "").length ? "en" : "zh";
}

export function LocalReader(props: LocalReaderProps) {
  const [attempt, setAttempt] = useState(0);
  const { file } = props;
  const key = JSON.stringify([file.filePath, file.sizeBytes, file.modifiedAt, attempt]);
  return <ReaderSession key={key} {...props} onRetry={() => setAttempt(n => n + 1)} />;
}

function ReaderSession({
  file, initialLocator, railOpen, onToggleRail, onBack, onAsk, onNotesChanged, onTitle, onRetry,
  modelSettings, onOpenModelSettings,
}: LocalReaderProps & { onRetry(): void }) {
  const [appearance, setAppearance] = useState(getPreferences);
  const [appDark, setAppDark] = useState(appIsDark);
  const [settingsTab, setSettingsTab] = useState<"layout" | "theme">("layout");
  const [highlightColor, setHighlightColor] = useState(getHighlightColor);
  const [selectionTranslation, setSelectionTranslation] = useState<SelectionTranslation | null>(null);
  const colors = useMemo(() => resolveReaderColors(appearance.theme, appearance.mode, appDark), [appearance.theme, appearance.mode, appDark]);
  const surfaceAppearance = useMemo(() => ({ ...appearance, colors }), [appearance, colors]);
  const bilingual = useReaderTranslation();
  const [direction, setDirection] = useState<Exclude<ReaderTranslationMode, "off">>(() => {
    try {
      const saved = localStorage.getItem("diandian.reader.translationDirection");
      if (saved === "en" || saved === "zh") return saved;
    } catch { /* Fall back to language detection. */ }
    return "auto";
  });
  const { reset: resetTranslation } = bilingual;
  const lastModel = useRef(modelSettings);
  useEffect(() => {
    if (bilingual.provider === "model" && lastModel.current !== modelSettings) resetTranslation();
    lastModel.current = modelSettings;
  }, [modelSettings, bilingual.provider, resetTranslation]);
  const [book, setBook] = useState<OpenReaderBook | null>(null);
  const [info, setInfo] = useState<BookInfo | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const [annotations, setAnnotations] = useState<ReaderAnnotation[]>([]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<{ target: Selection; text: string; editing: boolean } | null>(null);
  const [footnote, setFootnote] = useState<{ text: string; anchor?: Anchor } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const root = useRef<HTMLElement>(null);
  const surface = useRef<EpubSurfaceHandle>(null);
  const appearanceButton = useRef<HTMLButtonElement>(null);
  const translationButton = useRef<HTMLButtonElement>(null);
  const opening = useRef<Promise<OpenReaderBook> | null>(null);
  const initialTarget = useRef(initialLocator);
  const lastJump = useRef(initialLocator);
  const lastLocation = useRef("");
  const mounted = useRef(false);
  const savingRef = useRef(false);
  const highlights = useMemo(() => annotations.map(mark => ({ locator: mark.cfi, isHighlighted: mark.isHighlighted, color: mark.color })), [annotations]);
  const selectedAnnotation = selection && annotations.find(item => item.cfi === selection.locator);
  const title = info?.title || file.fileName.replace(/\.epub$/i, "");
  const railAction = railOpen ? "收起左侧栏" : "展开左侧栏";
  // Slider position while dragging, and the requested position until the reader reports arriving there.
  const [scrub, setScrub] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const progressInput = useRef<HTMLInputElement>(null);
  const shownFraction = scrub ?? (location ? Math.min(1, Math.max(0, location.fraction)) : 0);
  const shownPercent = Math.round(shownFraction * 100);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    opening.current ??= window.diandian.reader.open(file.filePath);
    void opening.current.then(result => {
      if (!active) return;
      lastLocation.current = result.location;
      setBook(result);
      setAnnotations(result.annotations);
    }).catch(cause => {
      if (active) setError(formatUserError(cause, "打开电子书失败"));
    });
    return () => { active = false; mounted.current = false; };
  }, [file.filePath]);

  useEffect(() => {
    // "Follow the app" mode tracks the workspace day/night switch while a book is open.
    const observer = new MutationObserver(() => setAppDark(appIsDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (info?.title) onTitle?.(info.title);
  }, [info?.title, onTitle]);

  useEffect(() => {
    if (!info || !initialLocator || initialLocator === lastJump.current) return;
    lastJump.current = initialLocator;
    surface.current?.goTo(initialLocator);
  }, [info, initialLocator]);

  useEffect(() => {
    const input = progressInput.current;
    if (!input) return;
    // "change" fires once the thumb is released or a key step is committed; "input" only previews.
    const commit = () => {
      setDragging(false);
      const fraction = Number(input.value) / 1000;
      setScrub(fraction);
      surface.current?.goToFraction(fraction);
    };
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, [info, error]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function closeSelection() {
    surface.current?.clearSelection();
    setSelection(null);
  }

  function closeOverlay() {
    if (panel === "appearance") appearanceButton.current?.focus({ preventScroll: true });
    if (panel === "translation") translationButton.current?.focus({ preventScroll: true });
    setPanel(null);
    setFootnote(null);
    setDraft(null);
    setSelectionTranslation(null);
    closeSelection();
  }

  function togglePanel(next: Panel) {
    closeSelection();
    setDraft(null);
    setFootnote(null);
    setSelectionTranslation(null);
    setPanel(current => current === next ? null : next);
  }

  function changeAppearance(update: Partial<ReaderPreferences>) {
    const next = { ...appearance, ...update };
    setAppearance(next);
    try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Still apply the choice for this session. */ }
  }

  function relocate(next: Location) {
    if (!mounted.current) return;
    setLocation(next);
    if (!dragging) setScrub(null);
    if (!book || !next.locator || lastLocation.current === next.locator) return;
    lastLocation.current = next.locator;
    // Send each new position immediately. Closing a book can also tear down the renderer.
    void window.diandian.reader.saveLocation(book.documentId, next.locator).catch(() => {
      if (mounted.current && lastLocation.current === next.locator) {
        lastLocation.current = "";
        setNotice("未能保存这次阅读位置");
      }
    });
  }

  function goTo(locator: string) {
    closeOverlay();
    surface.current?.goTo(locator);
  }

  async function writeAnnotation(write: () => Promise<void>, failureMessage: string) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await write();
      onNotesChanged();
    } catch (cause) {
      if (mounted.current) setNotice(formatUserError(cause, failureMessage));
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  function saveAnnotation(target: Selection, note?: string, color?: ReaderHighlightColor) {
    if (!book) return;
    const existing = annotations.find(item => item.cfi === target.locator);
    const recolor = Boolean(color && existing?.isHighlighted && existing.color !== color);
    if (color) {
      setHighlightColor(color);
      try { localStorage.setItem(highlightColorKey, color); } catch { /* Keep the choice for this session. */ }
    }
    return writeAnnotation(async () => {
      const entry = await window.diandian.reader.addAnnotation({
        documentId: book.documentId, title, author: info?.author, chapter: target.chapter,
        quote: target.quote, cfi: target.locator, note,
        // A new mark takes the last used color; an existing one keeps its color unless a swatch was picked.
        color: color ?? (existing ? undefined : highlightColor),
      });
      if (!mounted.current) return;
      setAnnotations(current => [...current.filter(item => item.id !== entry.id), entry]);
      closeOverlay();
      setNotice(note ? "想法已存入阅读笔记" : recolor ? `已改为${HIGHLIGHT_COLORS[entry.color].label}划线` : "划线已存入阅读笔记");
    }, "保存划线失败");
  }

  async function copySelection(target: Selection) {
    try {
      await navigator.clipboard.writeText(target.quote);
      setNotice("已复制");
    } catch {
      setNotice("复制失败，请使用 ⌘C");
    }
    closeSelection();
  }

  async function translationProvider() {
    if (bilingual.mode !== "off") return bilingual.provider;
    const settings = await window.diandian.reader.getTranslationSettings();
    // Without a DeepL key, fall back to the configured model rather than failing.
    return settings.provider === "deepl" && !settings.hasDeepLKey && modelSettings?.hasApiKey ? "model" as const : settings.provider;
  }

  async function translateSelection(target: Selection) {
    const text = target.quote.trim();
    const anchor: Anchor = { x: target.x, y: target.bottom ?? target.y };
    closeSelection();
    if (text.length > 3000) {
      setSelectionTranslation({ anchor, status: "error", text: "选中的文字太长，请分段翻译。" });
      return;
    }
    const request = { anchor, status: "loading" as const, text: "" };
    setSelectionTranslation(request);
    const settle = (next: SelectionTranslation) => {
      if (mounted.current) setSelectionTranslation(current => current === request ? next : current);
    };
    try {
      const provider = await translationProvider();
      const [translated] = await window.diandian.reader.translate({
        provider, target: translationTarget(text), texts: [text], requestId: crypto.randomUUID(),
      });
      settle({ anchor, status: "done", text: translated ?? "" });
    } catch (cause) {
      settle({ anchor, status: "error", text: formatUserError(cause, "暂时无法翻译") });
    }
  }

  function removeAnnotation(item: ReaderAnnotation) {
    if (!book) return;
    return writeAnnotation(async () => {
      const remaining = await window.diandian.reader.removeAnnotation(book.documentId, item.id);
      if (!mounted.current) return;
      setAnnotations(current => remaining
        ? current.map(mark => mark.id === item.id ? remaining : mark)
        : current.filter(mark => mark.id !== item.id));
      closeSelection();
      setNotice(remaining ? "已取消划线，想法已保留" : "已取消划线");
    }, "取消划线失败");
  }

  function startNote(target: Selection) {
    const text = selectedAnnotation?.note || "";
    setDraft({ target, text, editing: Boolean(text) });
    setSelection(null);
    setFootnote(null);
    setPanel(null);
  }

  function selectionPosition(target: Selection): CSSProperties {
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return {};
    // Prefer above the selection; flip below it when the toolbar would cover the header.
    const toolbarHeight = 90;
    const above = target.y - bounds.top - toolbarHeight - 8;
    const below = (target.bottom ?? target.y) - bounds.top + 10;
    const top = above >= 56 ? above : Math.min(below, bounds.height - toolbarHeight - 8);
    return { ...popoverPosition(target), "--lr-top": `${Math.max(56, top)}px` } as CSSProperties;
  }

  function popoverPosition(anchor?: Anchor): CSSProperties {
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds || !anchor) return {};
    return {
      "--lr-x": `${anchor.x - bounds.left}px`,
      "--lr-y": `${anchor.y - bounds.top}px`,
    } as CSSProperties;
  }

  const closeButton = (label: string) => <button type="button" className="lr-icon" aria-label={label} onClick={closeOverlay}><IconClose size={16} /></button>;

  const readerStyle = {
    "--lr-paper": colors.paper, "--lr-ink": colors.ink, "--lr-muted": colors.muted, "--lr-line": colors.line,
    "--lr-panel": colors.panel, "--lr-soft": colors.soft, "--lr-active": colors.accent,
    "--lr-texture": readerTextureImage(appearance.texture, colors.dark) ?? "none",
    colorScheme: colors.dark ? "dark" : "light",
  } as CSSProperties;

  return <section ref={root} className="local-reader" style={readerStyle} data-reader-dark={colors.dark || undefined} aria-label="本地电子书阅读器"
    onKeyDown={event => {
      if (event.key === "Escape") { closeOverlay(); return; }
      if (panel || draft || footnote || event.altKey || event.ctrlKey || event.metaKey ||
          (event.target as HTMLElement).closest("textarea, input, select")) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); surface.current?.prev(); }
      if (event.key === "ArrowRight") { event.preventDefault(); surface.current?.next(); }
    }}>
    <header className="lr-bar">
      <div className="lr-bar-group">
        <button type="button" className="lr-tool" aria-label={railAction} title={railAction}
          aria-expanded={railOpen} onClick={onToggleRail}>
          <IconPanelLeft size={17} />
        </button>
        <button type="button" className="lr-tool" aria-label="返回书库" title="返回本地书库" onClick={onBack}>
          <IconArrowLeft size={17} /><span>书库</span>
        </button>
        <span className="lr-divider" aria-hidden="true" />
        <button type="button" className="lr-tool" aria-label="目录" title="目录" disabled={!info || !!error}
          aria-expanded={panel === "toc"} onClick={() => togglePanel("toc")}>
          <IconList size={17} /><span>目录</span>
        </button>
      </div>
      <h1 title={title}>{title}</h1>
      <div className="lr-bar-group">
        <button ref={translationButton} type="button" className="lr-tool lr-translate-tool" title="中英对照" aria-label="中英对照" disabled={!info || !!error}
          data-active={bilingual.mode !== "off"} aria-expanded={panel === "translation"} onClick={() => togglePanel("translation")}>
          <IconLanguages size={17} /><span>双语</span></button>
        <button type="button" className="lr-tool" title="本书笔记" aria-label="本书笔记" disabled={!info || !!error}
          aria-expanded={panel === "notes"} onClick={() => togglePanel("notes")}><IconSquarePen size={16} /><span>笔记</span></button>
        <button ref={appearanceButton} type="button" className="lr-tool lr-aa" title="阅读设置" aria-label="阅读设置" disabled={!info || !!error}
          aria-expanded={panel === "appearance"} onClick={() => togglePanel("appearance")}>Aa</button>
      </div>
    </header>

    <div className="lr-page" aria-busy={!info && !error}>
      {book && !error && <EpubSurface ref={surface} bytes={book.bytes}
        initialLocator={initialTarget.current || book.location || null} appearance={surfaceAppearance} highlights={highlights}
        translation={bilingual.mode} translationRevision={bilingual.revision} onTranslate={bilingual.translate} onTranslationError={bilingual.setIssue}
        onReady={setInfo} onRelocate={relocate} onSelection={setSelection}
        onFootnote={(text, anchor) => { setSelection(null); setPanel(null); setFootnote({ text, anchor }); }}
        onError={setError} onEscape={closeOverlay} />}
      {!info && !error && <div className="lr-state" role="status"><IconBookOpen size={25} /><span>正在打开电子书…</span></div>}
      {error && <div className="lr-state" role="alert"><IconBookOpen size={27} /><strong>无法打开这本书</strong>
        <p>{error}</p><div className="lr-state-actions">
          <button type="button" className="lr-secondary" onClick={onRetry}><IconRefresh size={15} />重试</button>
          <button type="button" className="lr-secondary" onClick={() => {
            void window.diandian.router.openDownloadedBook(file.filePath).catch(cause => setNotice(formatUserError(cause, "打开电子书失败")));
          }}><IconExternalLink size={15} />用系统阅读器打开</button>
        </div>
      </div>}
    </div>

    {info && !error && bilingual.mode !== "off" && bilingual.working > 0 && !bilingual.issue &&
      <div className="lr-translating" role="status" aria-label="正在翻译本页"><span className="lr-dots"><i /><i /><i /></span></div>}
    {info && !error && bilingual.mode !== "off" && bilingual.issue && <div className="lr-translation-issue" role="status">
      <span>{bilingual.issue}</span>
      <button type="button" onClick={bilingual.reset}>重试翻译</button>
      <button type="button" onClick={() => { closeSelection(); setFootnote(null); setDraft(null); setPanel("translation"); }}>翻译设置</button>
    </div>}
    {info && !error && <footer className="lr-footer">
      <button type="button" className="lr-turn" aria-label="上一页" title="上一页（← 或向上滚动）" onClick={() => surface.current?.prev()}>
        <IconArrowLeft size={16} />
      </button>
      <div className="lr-footer-info">
        <span className="lr-chapter" title={location?.chapter}>{location?.chapter || title}</span>
        {location?.sectionPage && <span className="lr-section-page" title="本章页码">
          {location.sectionPage.current} / {location.sectionPage.total}
        </span>}
      </div>
      <div className="lr-progress" data-dragging={dragging || undefined}
        style={{ "--lr-p": shownFraction } as CSSProperties}>
        <input ref={progressInput} type="range" min={0} max={1000} step={1} value={Math.round(shownFraction * 1000)}
          aria-label="全书进度，拖动可跳转" aria-valuetext={`${shownPercent}%`}
          onPointerDown={() => setDragging(true)} onPointerUp={() => setDragging(false)} onBlur={() => setDragging(false)}
          onChange={event => setScrub(Number(event.target.value) / 1000)} />
        {dragging && scrub !== null && <output className="lr-progress-bubble">{shownPercent}%</output>}
      </div>
      <span className="lr-percent" aria-hidden="true">{shownPercent}%</span>
      <button type="button" className="lr-turn" aria-label="下一页" title="下一页（→ 或向下滚动）" onClick={() => surface.current?.next()}>
        <IconArrowRight size={16} />
      </button>
    </footer>}

    {(panel || draft || footnote || selectionTranslation) && <div className={`lr-scrim ${draft ? "tinted" : ""}`} aria-hidden="true" onClick={draft ? undefined : closeOverlay} />}
    {(panel === "toc" || panel === "notes") && <aside className="lr-drawer" aria-label={panel === "toc" ? "本书目录" : "本书笔记列表"}>
      <header className="lr-panel-heading"><h2>{panel === "toc" ? "目录" : "本书笔记"}</h2>{closeButton("关闭侧栏")}</header>
      <div className="lr-panel-body">
        {panel === "toc" && info && <ReaderContents key={bilingual.revision} toc={info.toc} chapter={location?.chapter}
          mode={bilingual.mode} translate={bilingual.translate} onNavigate={goTo} />}
        {panel === "notes" && (annotations.length ? annotations.map(item =>
          <div className="lr-note-row" key={item.id} data-highlighted={item.isHighlighted}
            style={{ "--lr-mark": HIGHLIGHT_COLORS[item.color].hex } as CSSProperties}>
            <button type="button" className="lr-note-item" onClick={() => goTo(item.cfi)} title="跳到原文">
              {item.chapter && <small>{item.chapter}</small>}<q>{item.quote}</q>{item.note && <span>{item.note}</span>}
            </button>
            {item.isHighlighted && <button type="button" className="lr-unmark" disabled={saving}
              onClick={() => void removeAnnotation(item)}>取消划线</button>}
          </div>) : <p className="lr-muted">选中正文，再点「划线」或「写想法」，即可在这里回看。</p>)}
      </div>
    </aside>}

    {panel === "translation" && <ReaderTranslationPanel
      canTranslate={info?.canTranslate !== false} enabled={bilingual.mode !== "off"} activeProvider={bilingual.provider}
      direction={direction} model={modelSettings} onOpenModelSettings={onOpenModelSettings} onClose={closeOverlay}
      onEnable={(provider, nextDirection) => {
        setDirection(nextDirection);
        try { localStorage.setItem("diandian.reader.translationDirection", nextDirection); } catch { /* Keep the session choice. */ }
        bilingual.changeMode(nextDirection, provider);
        closeOverlay();
      }}
      onDisable={() => { bilingual.changeMode("off"); closeOverlay(); }} />}

    {panel === "appearance" && <aside className="lr-settings lr-appearance" aria-label="阅读设置">
      <header className="lr-panel-heading">
        <div className="lr-settings-tabs" role="tablist" aria-label="阅读设置分类">
          {(["layout", "theme"] as const).map(tab => <button type="button" role="tab" key={tab}
            aria-selected={settingsTab === tab} onClick={() => setSettingsTab(tab)}>{tab === "layout" ? "排版" : "主题"}</button>)}
        </div>
        {closeButton("关闭阅读设置")}
      </header>
      {settingsTab === "layout" && (info?.layout === "fixed" ? <p className="lr-font-fixed">这本书采用固定版式，字体和排版由原书决定。</p> : <>
        <fieldset className="lr-font-picker">
          <legend>正文字体</legend>
          <div className="lr-font-options">
            {(["serif", "sans", "kai", "publisher"] as const).map(family => {
              const font = readerFonts[family];
              const selected = appearance.fontFamily === family;
              return <label className="lr-font-option" key={family}>
                <input type="radio" name="reader-font" value={family} checked={selected} autoFocus={selected}
                  onChange={() => changeAppearance({ fontFamily: family })} />
                <span aria-hidden="true" className="lr-font-specimen" style={{ fontFamily: font.stack }}>
                  {family === "publisher" ? <IconBookOpen size={21} /> : "阅 Aa"}
                </span>
                <span>{font.label}</span>
                {selected && <IconCheck size={11} className="lr-font-check" />}
              </label>;
            })}
          </div>
        </fieldset>
        <div className="lr-setting-row"><span>字号</span><div className="lr-steppers">
          <button type="button" aria-label="减小字号" disabled={appearance.fontSize <= 16} onClick={() => changeAppearance({ fontSize: appearance.fontSize - 2 })}>−</button>
          <output>{appearance.fontSize}</output>
          <button type="button" aria-label="增大字号" disabled={appearance.fontSize >= 30} onClick={() => changeAppearance({ fontSize: appearance.fontSize + 2 })}>＋</button>
        </div></div>
        <div className="lr-setting-row"><span>行距</span><div className="lr-segments">
          {([1.6, 1.85, 2.1] as const).map((value, i) => <button type="button" key={value}
            aria-pressed={appearance.lineHeight === value} onClick={() => changeAppearance({ lineHeight: value })}>{["紧凑", "适中", "宽松"][i]}</button>)}
        </div></div>
        <div className="lr-setting-row"><span>版式</span><div className="lr-segments">
          {([1, 2] as const).map(value => <button type="button" key={value}
            aria-pressed={appearance.columns === value} onClick={() => changeAppearance({ columns: value })}>{value === 1 ? "单栏" : "双栏"}</button>)}
        </div></div>
      </>)}
      {settingsTab === "theme" && <>
        <div className="lr-setting-row"><span>日夜模式</span><div className="lr-segments">
          {(["auto", "light", "dark"] as const satisfies readonly ReaderThemeMode[]).map(mode => <button type="button" key={mode}
            aria-pressed={appearance.mode === mode} title={mode === "auto" ? "跟随工作台的日间 / 夜间切换" : undefined}
            onClick={() => changeAppearance({ mode })}>{{ auto: "跟随应用", light: "日间", dark: "夜间" }[mode]}</button>)}
        </div></div>
        <div className="lr-theme-grid" role="radiogroup" aria-label="主题色">
          {READER_THEME_IDS.map(id => {
            const swatch = resolveReaderColors(id, appearance.mode, appDark);
            return <button type="button" role="radio" key={id} aria-checked={appearance.theme === id}
              className="lr-theme-card" style={{ background: swatch.paper, color: swatch.ink }}
              onClick={() => changeAppearance({ theme: id })}>
              <strong>Aa</strong><span>{READER_THEMES[id].label}</span>
            </button>;
          })}
        </div>
        <div className="lr-setting-row lr-texture-row"><span>纸张质感</span><div className="lr-texture-options" role="radiogroup" aria-label="纸张质感">
          {(Object.keys(READER_TEXTURES) as ReaderTexture[]).map(texture => <button type="button" role="radio" key={texture}
            aria-checked={appearance.texture === texture} onClick={() => changeAppearance({ texture })}
            style={{ background: `${colors.paper} ${readerTextureImage(texture, colors.dark) ?? ""}`, color: colors.ink }}>
            {READER_TEXTURES[texture]}
          </button>)}
        </div></div>
      </>}
    </aside>}

    {selection && !panel && !draft && !footnote && !selectionTranslation && <div role="toolbar" aria-label="选中文字"
      className="lr-selection" style={selectionPosition(selection)} onMouseDown={event => event.preventDefault()}>
      <div className="lr-selection-actions">
        {selectedAnnotation?.isHighlighted
          ? <button type="button" disabled={saving} onClick={() => void removeAnnotation(selectedAnnotation)}><IconTrash size={16} /><span>取消划线</span></button>
          : <button type="button" disabled={saving} onClick={() => void saveAnnotation(selection)}><IconPenLine size={16} /><span>划线</span></button>}
        <button type="button" disabled={saving} onClick={() => startNote(selection)}>
          <IconSquarePen size={16} /><span>{selectedAnnotation?.note ? "编辑想法" : "写想法"}</span>
        </button>
        <button type="button" onClick={() => void copySelection(selection)}><IconCopy size={16} /><span>复制</span></button>
        <button type="button" onClick={() => void translateSelection(selection)}><IconLanguages size={16} /><span>翻译</span></button>
        <button type="button" onClick={() => { onAsk(selection.quote, title); closeOverlay(); }}><IconSparkles size={16} /><span>问点点</span></button>
      </div>
      <div className="lr-selection-colors" role="radiogroup" aria-label="划线颜色">
        {HIGHLIGHT_COLOR_IDS.map(color => {
          const marked = selectedAnnotation?.isHighlighted === true;
          const { label, hex } = HIGHLIGHT_COLORS[color];
          return <button type="button" role="radio" key={color} disabled={saving}
            aria-checked={marked && selectedAnnotation.color === color}
            data-default={!marked && color === highlightColor || undefined}
            aria-label={marked ? `改为${label}` : `用${label}划线`} title={marked ? `改为${label}` : `用${label}划线`}
            style={{ "--lr-swatch": hex } as CSSProperties} onClick={() => void saveAnnotation(selection, undefined, color)}>
            {marked && selectedAnnotation.color === color && <IconCheck size={11} />}
          </button>;
        })}
      </div>
    </div>}

    {selectionTranslation && <aside className="lr-footnote lr-selection-translation" role="dialog" aria-label="译文"
      style={popoverPosition(selectionTranslation.anchor)}>
      <header className="lr-panel-heading"><h2>译文</h2>{closeButton("关闭译文")}</header>
      {selectionTranslation.status === "loading" && <span className="lr-dots" role="status" aria-label="正在翻译"><i /><i /><i /></span>}
      {selectionTranslation.status === "done" && <>
        <p>{selectionTranslation.text}</p>
        <button type="button" className="lr-link-button" onClick={() => {
          void navigator.clipboard.writeText(selectionTranslation.text).then(() => setNotice("已复制译文"), () => setNotice("复制失败"));
        }}><IconCopy size={13} />复制译文</button>
      </>}
      {selectionTranslation.status === "error" && <>
        <p className="lr-translation-error">{selectionTranslation.text}</p>
        <button type="button" className="lr-link-button" onClick={() => { closeOverlay(); setPanel("translation"); }}>翻译设置</button>
      </>}
    </aside>}

    {footnote && <aside className="lr-footnote" role="dialog" aria-label="脚注" style={popoverPosition(footnote.anchor)}>
      <header className="lr-panel-heading"><h2>脚注</h2>{closeButton("关闭脚注")}</header>
      <p>{footnote.text}</p>
    </aside>}

    {draft && <form className="lr-note-editor" role="dialog" aria-label={draft.editing ? "编辑想法" : "写想法"} onSubmit={event => {
      event.preventDefault();
      if (draft.text.trim()) void saveAnnotation(draft.target, draft.text.trim());
    }}>
      <header className="lr-panel-heading"><h2>{draft.editing ? "编辑想法" : "写想法"}</h2>{closeButton("关闭想法编辑")}</header>
      <blockquote>{draft.target.quote}</blockquote>
      <textarea aria-label="你的想法" autoFocus placeholder="写下你的想法…" value={draft.text}
        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit(); }}
        onChange={event => setDraft({ ...draft, text: event.target.value })} />
      <button type="submit" className="lr-save" disabled={saving || !draft.text.trim()}>保存想法</button>
    </form>}
    {notice && <div role="status" className="lr-notice">{notice}</div>}
  </section>;
}
