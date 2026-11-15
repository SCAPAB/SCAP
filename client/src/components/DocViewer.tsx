import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface Highlight {
  page: number | null;
  value: string | number | null;
  quote: string | null;
}

const digits = (s: string) => s.replace(/\D/g, '');
const norm = (s: string) => s.toLowerCase().replace(/[\s  :.,;()–-]+/g, '');

/** Avgör om en textbit i PDF:en motsvarar fältets värde/citat. */
function matches(str: string, h: Highlight): boolean {
  const t = str.trim();
  if (t.length < 2) return false;
  if (typeof h.value === 'number' && isFinite(h.value)) {
    const d = digits(t);
    if (d.length < 2) return false;
    const v = Math.abs(h.value);
    const targets = [v.toFixed(2), v.toFixed(4), String(Math.round(v)), v.toFixed(0)].map(digits);
    if (targets.includes(d)) return true;
    // Tal utan decimaler i dokumentet (t.ex. "12 500")
    return Number.isInteger(v) && d === String(v);
  }
  const nt = norm(t);
  if (nt.length < 3) return false;
  if (h.value != null) {
    const nv = norm(String(h.value));
    if (nv.length >= 3 && (nt.includes(nv) || (nv.includes(nt) && nt.length >= 6))) return true;
  }
  if (h.quote) {
    const nq = norm(h.quote);
    if (nq.length >= 6 && (nq.includes(nt) && nt.length >= 6)) return true;
  }
  return false;
}

/** Visar PDF (eller bild) och markerar var i dokumentet ett värde hämtades. */
export default function DocViewer({ url, mime, highlight }: { url: string; mime: string; highlight: Highlight | null }) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [boxes, setBoxes] = useState<{ x: number; y: number; w: number; h: number }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const isPdf = mime === 'application/pdf';

  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    const task = pdfjs.getDocument({ url, withCredentials: true });
    task.promise.then((d) => !cancelled && setDoc(d)).catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url, isPdf]);

  // Hoppa till sidan för markerat fält
  useEffect(() => {
    if (highlight?.page && doc && highlight.page >= 1 && highlight.page <= doc.numPages) setPage(highlight.page);
  }, [highlight, doc]);

  useEffect(() => {
    if (!doc || !canvas.current || !wrap.current) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    (async () => {
      const p = await doc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const width = wrap.current!.clientWidth - 26; // padding
      const scale = (width / base.width) * zoom;
      const vp = p.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const c = canvas.current!;
      c.width = Math.floor(vp.width * ratio);
      c.height = Math.floor(vp.height * ratio);
      c.style.width = `${vp.width}px`;
      c.style.height = `${vp.height}px`;
      renderTask = p.render({ canvas: c, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      await renderTask.promise.catch(() => undefined);
      if (cancelled) return;
      setSize({ w: vp.width, h: vp.height });
      if (!highlight || (highlight.page && highlight.page !== page)) {
        setBoxes([]);
        return;
      }
      const tc = await p.getTextContent();
      const found: { x: number; y: number; w: number; h: number }[] = [];
      for (const it of tc.items) {
        if (!('str' in it) || !matches(it.str, highlight)) continue;
        const tx = pdfjs.Util.transform(vp.transform, it.transform);
        const fh = Math.hypot(tx[2], tx[3]);
        found.push({ x: tx[4] - 3, y: tx[5] - fh - 2, w: it.width * scale + 6, h: fh + 5 });
      }
      if (!cancelled) setBoxes(found);
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, page, highlight, zoom]);

  if (!isPdf) {
    return <div className="docview" ref={wrap}><img src={url} alt="Dokument" style={{ width: '100%' }} /></div>;
  }
  return (
    <div className="docview-outer">
      <div className="docview-bar">
        <button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Föregående sida">‹</button>
        <span className="small">Sida {page} av {doc?.numPages ?? '…'}</span>
        <button className="btn small" disabled={!doc || page >= doc.numPages} onClick={() => setPage(page + 1)} aria-label="Nästa sida">›</button>
        <span className="spacer" />
        <button className="btn small" onClick={() => setZoom(Math.max(0.6, zoom - 0.2))} aria-label="Zooma ut">−</button>
        <span className="small">{Math.round(zoom * 100)} %</span>
        <button className="btn small" onClick={() => setZoom(Math.min(3, zoom + 0.2))} aria-label="Zooma in">+</button>
        <a className="btn small" href={url} target="_blank" rel="noreferrer">Öppna original</a>
      </div>
      {error && <div className="alert error">Kunde inte visa dokumentet: {error}</div>}
      <div className="docview" ref={wrap}>
        <div style={{ position: 'relative', width: size.w || undefined, margin: '0 auto' }}>
          <canvas ref={canvas} />
          {boxes.map((b, i) => (
            <div key={i} className="hl-box" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />
          ))}
        </div>
      </div>
      {highlight && (
        <div className="docview-foot small">
          {boxes.length ? <><span className="hl-dot" /> Markerat i dokumentet{highlight.page ? ` (sida ${highlight.page})` : ''}</> : highlight.quote ? <>Källa{highlight.page ? ` sida ${highlight.page}` : ''}: <q>{highlight.quote}</q></> : <span className="muted">Värdet kunde inte lokaliseras i dokumentet</span>}
        </div>
      )}
    </div>
  );
}
