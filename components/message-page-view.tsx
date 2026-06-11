"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import html2canvas from "html2canvas";
import { useI18n } from "./i18n";

type PageKind = "report" | "answer" | "listheavy";

type Section = {
  title: string;
  body: string;
};

function classifyPageKind(text: string): PageKind {
  const hasH2 = /^##\s/m.test(text);
  const hasH3 = /^###\s/m.test(text);
  const lineCount = text.trim().split("\n").length;
  const isShort = text.trim().length < 350 && lineCount < 8;
  const hasList = /^\s*(\d+\.|[-*])\s/m.test(text);

  if (hasH2) return "report";
  if (isShort) return "answer";
  if (hasList && !hasH3) return "listheavy";
  return "report";
}

function splitSections(text: string): { intro: string; sections: Section[] } {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return { intro: "", sections: [] };

  const matches = Array.from(normalized.matchAll(/^##\s+(.+)$/gm));
  if (matches.length === 0) {
    return { intro: normalized, sections: [] };
  }

  const intro = normalized.slice(0, matches[0].index).trim();
  const sections = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? normalized.length) : normalized.length;
    return {
      title: match[1].trim(),
      body: normalized.slice(start, end).trim(),
    };
  });

  return { intro, sections };
}

function looksLikeRunnableHtml(value: string, language = "") {
  const lang = language.toLowerCase().trim();
  if (lang === "html" || lang === "svg") return true;
  return /<(html|body|main|section|article|div|table|svg|canvas|script|style)\b/i.test(value);
}

// Width the iframe is rendered at — this matches what the user sees when
// they open the exported .html file in a normal browser tab. The whole iframe
// element is then CSS-scaled DOWN in the parent React tree to fit the chat
// column, so the user gets an exact visual replica of the export, just smaller.
const PREVIEW_NATURAL_WIDTH = 1280;

function resizeScript(frameId: string) {
  // Inside the iframe we do NOTHING to the layout. The iframe is sized at
  // PREVIEW_NATURAL_WIDTH from the parent, so the page lays out exactly like
  // it would when you double-click the exported .html. We only need to:
  //   1. Wait for fonts + images so text/image dimensions don't shift.
  //   2. Report the natural content height via body.scrollHeight.
  //   3. Re-report whenever the content actually changes.
  //
  // No body width locking, no CSS transform on body, no min-height overrides,
  // no scrollHeight-vs-children juggling — none of that. The iframe is a
  // plain viewport; trust the browser.
  return `<script>
  (function () {
    var frameId = ${JSON.stringify(frameId)};
    var lastReported = 0;
    var pending = false;

    function measure() {
      var body = document.body;
      var html = document.documentElement;
      if (!body) return 0;
      return Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.scrollHeight,
        html.offsetHeight
      );
    }

    function report() {
      pending = false;
      var h = measure();
      if (h === lastReported) return;
      lastReported = h;
      parent.postMessage({
        type: "synapse-html-preview-resize",
        id: frameId,
        height: h,
      }, "*");
    }

    function schedule() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(report);
    }

    function waitForAssets() {
      var tasks = [];
      if (document.fonts && document.fonts.ready) {
        tasks.push(document.fonts.ready.catch(function(){}));
      }
      var imgs = Array.prototype.slice.call(document.images || []);
      imgs.forEach(function (img) {
        if (img.complete && img.naturalWidth > 0) return;
        tasks.push(new Promise(function (resolve) {
          var done = false;
          var finish = function () { if (!done) { done = true; resolve(); } };
          img.addEventListener('load', finish, { once: true });
          img.addEventListener('error', finish, { once: true });
          setTimeout(finish, 4000);  // safety: never hang on one image
        }));
      });
      return Promise.all(tasks);
    }

    function init() {
      // Fast first estimate so the iframe doesn't start at 0px.
      report();
      // Re-report once fonts + images have settled (final layout is stable).
      waitForAssets().then(report);
      // React to any future content change.
      if (window.ResizeObserver) {
        new ResizeObserver(schedule).observe(document.body);
      }
      if (window.MutationObserver) {
        new MutationObserver(schedule).observe(document.body, {
          childList: true, subtree: true, characterData: true, attributes: true,
        });
      }
    }

    if (document.readyState === 'complete') {
      init();
    } else {
      window.addEventListener('load', init, { once: true });
    }
  })();
</script>`;
}

function layoutNormalizationScript() {
  return `<script>
  (function () {
    function px(value) {
      if (!value) return 0;
      var n = parseFloat(String(value));
      return Number.isFinite(n) ? n : 0;
    }

    function relaxWidth(el, viewport) {
      if (!(el instanceof HTMLElement)) return;
      var style = getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      var maxWidth = px(style.maxWidth);
      var width = px(style.width);
      var isNarrow = rect.width > 0 && rect.width < viewport * 0.72;
      var hasNarrowCap = (maxWidth > 0 && maxWidth < viewport * 0.72) || (width > 0 && width < viewport * 0.72);
      if (!isNarrow && !hasNarrowCap) return;

      el.style.setProperty('width', '100%', 'important');
      el.style.setProperty('max-width', 'none', 'important');
      el.style.setProperty('min-width', '0', 'important');
      if (style.marginLeft === 'auto' || style.marginRight === 'auto') {
        el.style.setProperty('margin-left', '0', 'important');
        el.style.setProperty('margin-right', '0', 'important');
      }
    }

    function normalize() {
      var body = document.body;
      if (!body) return;
      var viewport = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      if (!viewport) return;

      body.style.setProperty('display', 'block', 'important');
      body.style.setProperty('width', '100%', 'important');
      body.style.setProperty('max-width', 'none', 'important');
      body.style.setProperty('min-width', '0', 'important');
      body.style.setProperty('padding', '24px', 'important');
      body.style.setProperty('margin', '0', 'important');
      body.style.setProperty('overflow-x', 'hidden', 'important');
      body.style.setProperty('align-items', 'stretch', 'important');
      body.style.setProperty('justify-content', 'flex-start', 'important');

      var topLevel = Array.prototype.filter.call(body.children, function (el) {
        return el instanceof HTMLElement && getComputedStyle(el).display !== 'none';
      });
      topLevel.forEach(function (el) { relaxWidth(el, viewport); });

      Array.prototype.forEach.call(body.querySelectorAll('*'), function (el) {
        if (!(el instanceof HTMLElement)) return;
        var style = getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'absolute') return;
        relaxWidth(el, viewport);
      });
    }

    window.addEventListener('load', function () {
      normalize();
      setTimeout(normalize, 60);
      setTimeout(normalize, 300);
      setTimeout(normalize, 900);
    });
  })();
</script>`;
}

function asHtmlDocument(source: string, language = "", frameId: string) {
  const trimmed = source.trim();
  const body = language.toLowerCase().trim() === "svg"
    ? `<main class="svg-wrap">${trimmed}</main>`
    : trimmed;

  if (/<!doctype html>|<html[\s>]/i.test(body)) {
    const script = resizeScript(frameId);
    if (/<\/body>/i.test(body)) return body.replace(/<\/body>/i, `${script}</body>`);
    return `${body}${script}`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      color: #1f2937;
      background: #fffdfa;
      font: 14px/1.65 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    h1, h2, h3 { margin: 0 0 12px; line-height: 1.2; }
    p { margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { border: 1px solid #eadfd1; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #f7f0e7; }
    svg, canvas { max-width: 100%; height: auto; }
    .svg-wrap { display: grid; place-items: center; min-height: 160px; }
  </style>
</head>
<body>
${body}
${resizeScript(frameId)}
</body>
</html>`;
}

function buildExportDocument(inner: string, title = "Synapse Page") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      color: #1f2937;
      background: #fffdfa;
      font: 14px/1.65 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body > * { max-width: 980px; margin: 0 auto; }
  </style>
</head>
<body>
${inner}
</body>
</html>`;
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function HtmlPreview({ source, language }: { source: string; language?: string }) {
  // Content height as measured INSIDE the iframe (at PREVIEW_NATURAL_WIDTH).
  const [contentHeight, setContentHeight] = useState(400);
  // Width of the container in the parent layout (the chat column).
  const [containerWidth, setContainerWidth] = useState(PREVIEW_NATURAL_WIDTH);
  const containerRef = useRef<HTMLDivElement>(null);
  const frameId = useMemo(() => `html-preview-${Math.random().toString(36).slice(2)}`, []);
  const srcDoc = useMemo(() => asHtmlDocument(source, language, frameId), [source, language, frameId]);

  // Observe the container's available width so we know how much to scale.
  // useLayoutEffect (not useEffect) so the first measurement happens BEFORE
  // paint — otherwise the iframe briefly shows at full natural width before
  // shrinking, causing a visible flash on mount.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => {
      const w = node.clientWidth;
      if (w > 0) setContainerWidth(w);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Receive content-height updates from the iframe.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "synapse-html-preview-resize") return;
      if (event.data.id !== frameId) return;
      const next = Number(event.data.height);
      if (Number.isFinite(next) && next > 0) setContentHeight(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameId]);

  // Scale the whole iframe element to fit the container width. We never
  // scale UP — if the container is wider than natural width, just show it
  // at 1:1 instead of stretching pixels.
  const scale = Math.min(1, containerWidth / PREVIEW_NATURAL_WIDTH);
  const scaledHeight = Math.ceil(contentHeight * scale);

  return (
    <div
      ref={containerRef}
      className="synapse-page-embed"
      style={{
        width: "100%",
        height: scaledHeight,
        overflow: "hidden",
        position: "relative",
        background: "#fff",
      }}
    >
      <iframe
        id={frameId}
        title="HTML preview"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-forms allow-modals"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: PREVIEW_NATURAL_WIDTH,
          height: contentHeight,
          border: 0,
          background: "#fff",
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />
    </div>
  );
}

function detectCallout(text: string): { tone: "info" | "warning"; body: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const infoMatch = trimmed.match(/^(note|tip|insight|说明|提示)[:：]\s*([\s\S]+)/i);
  if (infoMatch) return { tone: "info", body: infoMatch[2].trim() };
  const warnMatch = trimmed.match(/^(warning|caution|risk|注意|风险)[:：]\s*([\s\S]+)/i);
  if (warnMatch) return { tone: "warning", body: warnMatch[2].trim() };
  return null;
}

function PageMarkdown({ text, kind }: { text: string; kind: PageKind }) {
  return (
    <div className={`synapse-page-markdown synapse-page-${kind}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1>{children}</h1>,
          h2: ({ children }) => <h2>{children}</h2>,
          h3: ({ children }) => <h3>{children}</h3>,
          p: ({ children }) => <p>{children}</p>,
          blockquote: ({ children }) => <blockquote>{children}</blockquote>,
          ul: ({ children }) => <ul className="synapse-rich-list">{children}</ul>,
          ol: ({ children }) => <ol className="synapse-rich-ol">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          table: ({ children }) => (
            <section className="synapse-rich-table">
              <table>{children}</table>
            </section>
          ),
          code: ({ inline, className, children, ...props }: any) => {
            const content = String(children ?? "").replace(/\n$/, "");
            const language = /language-(\w+)/.exec(className || "")?.[1] ?? "";

            if (!inline && looksLikeRunnableHtml(content, language)) {
              return <HtmlPreview source={content} language={language} />;
            }

            return inline
              ? <code {...props}>{children}</code>
              : <pre className="synapse-code-block"><code {...props} className={className}>{children}</code></pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function SectionBody({ body, kind }: { body: string; kind: PageKind }) {
  const trimmed = body.trim();
  const callout = detectCallout(trimmed);

  if (callout) {
    return (
      <div className={`synapse-callout synapse-callout-${callout.tone}`}>
        <PageMarkdown text={callout.body} kind={kind} />
      </div>
    );
  }

  return <PageMarkdown text={trimmed} kind={kind} />;
}

export function MessagePageView({ text, htmlArtifact }: { text: string; htmlArtifact?: string | null }) {
  const { t } = useI18n();
  const kind = useMemo(() => classifyPageKind(text), [text]);
  const { intro, sections } = useMemo(() => splitSections(text), [text]);
  const articleExportRef = useRef<HTMLElement | null>(null);
  const htmlExportRef = useRef<HTMLDivElement | null>(null);

  function downloadHtml(filenameBase: string, html: string) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filenameBase || "synapse-page"}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function getFilenameBase() {
    return (
      text
        .split("\n")
        .find((line) => line.trim().length > 0)
        ?.replace(/[^\p{L}\p{N}\-_ ]+/gu, "")
        .trim()
        .slice(0, 48)
        .replace(/\s+/g, "-")
        .toLowerCase() || "synapse-page"
    );
  }

  function handleExport() {
    const filenameBase = getFilenameBase();

    if (htmlArtifact?.trim()) {
      const exported = /<!doctype html>|<html[\s>]/i.test(htmlArtifact)
        ? htmlArtifact
        : buildExportDocument(htmlArtifact, filenameBase);
      downloadHtml(filenameBase, exported);
      return;
    }

    const node = articleExportRef.current ?? htmlExportRef.current;
    if (node) {
      const exported = buildExportDocument(node.outerHTML, filenameBase);
      downloadHtml(filenameBase, exported);
    }
  }

  async function handleExportPng() {
    const filenameBase = getFilenameBase();

    // Build the full HTML string (same content as Export HTML does).
    let htmlStr: string;
    if (htmlArtifact?.trim()) {
      htmlStr = /<!doctype html>|<html[\s>]/i.test(htmlArtifact)
        ? htmlArtifact
        : buildExportDocument(htmlArtifact, filenameBase);
    } else {
      const node = articleExportRef.current;
      if (!node) return;
      htmlStr = buildExportDocument(node.outerHTML, filenameBase);
    }

    // Load the HTML via a blob: URL instead of srcdoc. Srcdoc iframes have
    // an opaque `about:srcdoc` origin which html2canvas treats as
    // cross-origin in many browsers — resulting in a blank/white capture.
    // A blob URL inherits the parent's origin and renders cleanly.
    const blob = new Blob([htmlStr], { type: "text/html;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);

    // Render in an off-screen, non-sandboxed iframe at the same natural width
    // we use for in-app preview, so the captured PNG looks identical to what
    // the user sees on the Page tab.
    const iframe = document.createElement("iframe");
    iframe.style.cssText =
      `position:fixed;left:-99999px;top:0;width:${PREVIEW_NATURAL_WIDTH}px;height:200px;border:0;visibility:hidden;`;
    iframe.src = blobUrl;
    document.body.appendChild(iframe);

    try {
      // Wait for the iframe document to fully load.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        iframe.addEventListener("load", finish, { once: true });
        setTimeout(finish, 5000);  // hard cap
      });

      const idoc = iframe.contentDocument;
      const iwin = iframe.contentWindow as Window | null;
      if (!idoc || !idoc.body || !iwin) throw new Error("iframe document not accessible");

      // Wait for web fonts inside the iframe (text metrics depend on this).
      const idocAny = idoc as Document & { fonts?: FontFaceSet };
      if (idocAny.fonts && idocAny.fonts.ready) {
        try { await idocAny.fonts.ready; } catch { /* ignore */ }
      }
      // Wait for all <img> inside iframe to finish.
      const imgs = Array.from(idoc.images || []);
      await Promise.all(imgs.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          img.addEventListener("load", finish, { once: true });
          img.addEventListener("error", finish, { once: true });
          setTimeout(finish, 4000);
        });
      }));

      // Stable measurement after assets are loaded.
      const ihtml = idoc.documentElement;
      const w = Math.max(ihtml.scrollWidth, idoc.body.scrollWidth, PREVIEW_NATURAL_WIDTH);
      const h = Math.max(ihtml.scrollHeight, idoc.body.scrollHeight, 200);

      // Resize the iframe so html2canvas can walk the full content.
      iframe.style.width = w + "px";
      iframe.style.height = h + "px";
      // One paint frame to let layout settle at the new size.
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      const canvas = await html2canvas(idoc.body, {
        backgroundColor: "#ffffff",
        width: w,
        height: h,
        windowWidth: w,
        windowHeight: h,
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
      });

      const dataUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${filenameBase}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      console.warn("[export-png]", err);
    } finally {
      URL.revokeObjectURL(blobUrl);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }
  }

  if (htmlArtifact?.trim()) {
    return (
      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
          <button
            type="button"
            onClick={handleExportPng}
            title={t.chat.exportPngTitle}
            style={exportButtonStyle}
          >
            {t.chat.exportPng}
          </button>
          <button
            type="button"
            onClick={handleExport}
            title={t.chat.exportHtmlTitle}
            style={exportButtonStyle}
          >
            {t.chat.exportHtml}
          </button>
        </div>
        <div ref={htmlExportRef}>
          <HtmlPreview source={htmlArtifact} language="html" />
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button
          type="button"
          onClick={handleExportPng}
          title={t.chat.exportPngTitle}
          style={exportButtonStyle}
        >
          {t.chat.exportPng}
        </button>
        <button
          type="button"
          onClick={handleExport}
          title={t.chat.exportHtmlTitle}
          style={exportButtonStyle}
        >
          {t.chat.exportHtml}
        </button>
      </div>
    <article ref={articleExportRef} className={`synapse-page-shell synapse-page-shell-${kind}`}>
      <div className="synapse-page-banner" />

      {intro && (
        <section className="synapse-page-lead">
          <SectionBody body={intro} kind={kind} />
        </section>
      )}

      {sections.length > 0 ? (
        <div className="synapse-page-sections">
          {sections.map((section, index) => (
            <section key={`${section.title}-${index}`} className="synapse-page-section">
              <header className="synapse-page-section-header">
                <span className="synapse-page-section-index">{String(index + 1).padStart(2, "0")}</span>
                <h2>{section.title}</h2>
              </header>
              <SectionBody body={section.body} kind={kind} />
            </section>
          ))}
        </div>
      ) : (
        !intro && <SectionBody body={text} kind={kind} />
      )}
    </article>
    </div>
  );
}

const exportButtonStyle = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "6px 10px",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1.2,
  fontFamily: "inherit",
};
