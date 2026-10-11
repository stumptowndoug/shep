import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 250;
/** After a tooltip hides, the next one within this window shows immediately. */
const WARM_WINDOW_MS = 500;
const GAP = 6;
const MARGIN = 8;

interface Tip {
  text: string;
  anchor: DOMRect;
  /** Set once the tooltip has rendered and been measured. */
  position: { left: number; top: number } | null;
}

/**
 * Replaces the webview's native `title` tooltips, which wait about a second,
 * with a fast styled one. While an element is hovered its `title` moves to
 * `data-tooltip` so the native tooltip never appears; it is restored on leave.
 */
export default function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer: number | undefined;
    let lastHiddenAt = 0;

    const release = () => {
      window.clearTimeout(timer);
      if (target) {
        const text = target.dataset.tooltip;
        if (text != null && !target.hasAttribute("title")) target.setAttribute("title", text);
        if (target.dataset.tooltipLabel != null) {
          target.removeAttribute("aria-label");
          delete target.dataset.tooltipLabel;
        }
        delete target.dataset.tooltip;
        target = null;
        lastHiddenAt = Date.now();
      }
      setTip(null);
    };

    const handleOver = (event: PointerEvent) => {
      const el = (event.target as Element | null)?.closest<HTMLElement>("[title], [data-tooltip]");
      if (el === target) return;
      release();
      const text = el?.getAttribute("title") ?? el?.dataset.tooltip;
      if (!el || !text?.trim()) return;
      target = el;
      el.dataset.tooltip = text;
      el.removeAttribute("title");
      // An icon-only control may get its accessible name from title; keep it.
      if (!el.hasAttribute("aria-label") && !el.textContent?.trim()) {
        el.setAttribute("aria-label", text);
        el.dataset.tooltipLabel = "";
      }
      const show = () => {
        if (target !== el || !el.isConnected) return;
        setTip({ text, anchor: el.getBoundingClientRect(), position: null });
      };
      if (Date.now() - lastHiddenAt < WARM_WINDOW_MS) show();
      else timer = window.setTimeout(show, SHOW_DELAY_MS);
    };

    const handleOut = (event: PointerEvent) => {
      if (!target) return;
      const next = event.relatedTarget as Node | null;
      if (next && target.contains(next)) return;
      release();
    };

    document.addEventListener("pointerover", handleOver);
    document.addEventListener("pointerout", handleOut);
    document.addEventListener("pointerdown", release, true);
    document.addEventListener("keydown", release, true);
    document.addEventListener("scroll", release, true);
    window.addEventListener("blur", release);
    return () => {
      release();
      document.removeEventListener("pointerover", handleOver);
      document.removeEventListener("pointerout", handleOut);
      document.removeEventListener("pointerdown", release, true);
      document.removeEventListener("keydown", release, true);
      document.removeEventListener("scroll", release, true);
      window.removeEventListener("blur", release);
    };
  }, []);

  // Measure once rendered: below the anchor, flipped above when there is no
  // room, and kept inside the window horizontally.
  const measureRef = (el: HTMLDivElement | null) => {
    if (!el || !tip || tip.position) return;
    const { width, height } = el.getBoundingClientRect();
    const { anchor } = tip;
    const below = anchor.bottom + GAP;
    const top = below + height + MARGIN <= window.innerHeight ? below : Math.max(MARGIN, anchor.top - GAP - height);
    const centered = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.min(Math.max(MARGIN, centered), window.innerWidth - width - MARGIN);
    setTip({ ...tip, position: { left, top } });
  };

  if (!tip) return null;

  return createPortal(
    <div
      ref={measureRef}
      className="app-tooltip"
      role="tooltip"
      style={tip.position ?? { left: -9999, top: -9999, visibility: "hidden" }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
