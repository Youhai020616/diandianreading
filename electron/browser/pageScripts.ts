/**
 * Read-only DOM extraction snippet executed inside a WebContentsView.
 * Never reads document.cookie, localStorage, or password input values.
 */
export function buildReadPageScript(maxChars: number): string {
  const safeMax = Math.max(500, Math.min(40_000, Math.floor(maxChars)));
  return `(() => {
    const clean = (s) => String(s || '').replace(/\\r\\n/g, '\\n').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
    const selection = clean(window.getSelection ? window.getSelection().toString() : '');
    const title = clean(document.title);
    const url = location.href;
    const host = location.hostname || '';

    // Targeted selectors for WeRead notes / reader panels + generic article roots.
    const candidates = [
      '.readerNoteList',
      '.noteList',
      '.readerChapterContent',
      '.wr_reader_content',
      'article',
      'main',
      '[role="main"]',
    ];
    let root = null;
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && clean(el.innerText).length > 80) {
        root = el;
        break;
      }
    }
    const rawText = clean((root || document.body)?.innerText || '');
    const truncated = rawText.length > ${safeMax};
    const text = truncated ? rawText.slice(0, ${safeMax}) : rawText;

    // Detect Canvas-rendered reader pages (WeRead web reader, PDF canvas viewers, etc.)
    // and compute normalized viewport bounds for the main visible canvas so main process can OCR it locally.
    const vw = Math.max(1, window.innerWidth || 1);
    const vh = Math.max(1, window.innerHeight || 1);
    const canvases = Array.from(document.querySelectorAll('canvas'));
    let bestRect = null;
    let bestArea = 0;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const right = Math.min(vw, r.right);
      const bottom = Math.min(vh, r.bottom);
      const w = right - left;
      const h = bottom - top;
      const area = w * h;
      if (w >= 180 && h >= 140 && area > bestArea) {
        bestArea = area;
        bestRect = {
          rx: left / vw,
          ry: top / vh,
          rw: w / vw,
          rh: h / vh,
        };
      }
    }

    const likelyCanvasReader =
      canvases.length > 0
      && rawText.length < 300
      && (host.includes('weread.qq.com') || bestArea > vw * vh * 0.25);

    return {
      title,
      url,
      selection: selection.slice(0, 8000),
      text,
      textLength: rawText.length,
      truncated,
      likelyCanvasReader,
      canvasViewportRatio: bestRect,
      capturedAt: new Date().toISOString(),
    };
  })()`;
}
