import { useCallback, useRef, useState } from "react";

/** Within this many pixels of the end counts as being at the end. */
const END_SLACK = 1;
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End", " "]);

function distanceFromEnd(node: HTMLElement) {
  return node.scrollHeight - node.scrollTop - node.clientHeight;
}

/** One pixel short of the very end, as use-stick-to-bottom does; asking WebKit
 *  for the exact maximum or more was the worst case in the Mac app. */
function scrollToEnd(node: HTMLElement) {
  node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - END_SLACK);
}

/** Whether a wheel up at `target` moves something nested (a code block, a tool's output) rather than the chat. */
function nestedScrollsUp(target: EventTarget | null, scroller: HTMLElement) {
  for (let el = target instanceof Element ? target : null; el && el !== scroller; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollTop > 0) return true;
  }
  return false;
}

/**
 * Keeps a scrolling chat at its newest output. Only the user stops it, by
 * scrolling up with the wheel, keys, or scrollbar, or by moving focus to
 * something out of view; they resume it by scrolling back down to the end, or
 * with `followNow` (sending, the jump button).
 *
 * The scroll position alone can't tell us the user left: WebKit also moves it
 * up on its own, mostly when DOM near the end is torn down and rebuilt (which
 * is why replies render as stable blocks), and in the trackpad's bounce. So
 * while following, any such move is undone.
 */
export function useFollowOutput() {
  const followingRef = useRef(true);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);

  const setMode = useCallback((next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setFollowing(next);
  }, []);

  const followNow = useCallback(() => {
    setMode(true);
    const node = nodeRef.current;
    if (node) scrollToEnd(node);
  }, [setMode]);

  const stopFollowing = useCallback(() => setMode(false), [setMode]);

  const scrollerRef = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
    if (!node) return;
    // Called from the resize observer and scroll events, both before paint, so a
    // frame is never drawn away from the end.
    const pin = () => {
      if (followingRef.current && distanceFromEnd(node) > END_SLACK) scrollToEnd(node);
    };
    const leave = () => {
      if (followingRef.current && node.scrollHeight > node.clientHeight) setMode(false);
    };
    // The way the user last moved, so reaching the end resumes only on the way down.
    let headingDown = false;
    let draggingScrollbar = false;
    let lastTop = node.scrollTop;

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      headingDown = event.deltaY > 0;
      if (!headingDown && !nestedScrollsUp(event.target, node)) leave();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const unfocused = target === document.body || target === document.documentElement;
      if (unfocused ? node.getClientRects().length === 0 : !(target instanceof Node && node.contains(target))) return;
      if (UP_KEYS.has(event.key)) { headingDown = false; leave(); }
      else if (DOWN_KEYS.has(event.key)) headingDown = true;
    };
    // Tabbing to something out of view scrolls to it; that's the user's doing too.
    const onFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || event.target === node) return;
      const view = node.getBoundingClientRect();
      const box = event.target.getBoundingClientRect();
      if (box.top < view.top || box.bottom > view.bottom) leave();
    };
    // Only a scrollbar press lands on the scroller itself rather than a message.
    const onPointerDown = (event: PointerEvent) => { draggingScrollbar = event.target === node; };
    const onPointerUp = () => { draggingScrollbar = false; };
    const onScroll = () => {
      const top = node.scrollTop;
      if (draggingScrollbar && top !== lastTop) {
        headingDown = top > lastTop;
        if (!headingDown) leave();
      }
      lastTop = top;
      if (followingRef.current) pin();
      else if (headingDown && distanceFromEnd(node) <= END_SLACK) setMode(true);
    };
    const observer = new ResizeObserver(pin);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("focusin", onFocusIn);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      nodeRef.current = null;
    };
  }, [setMode]);

  return { scrollerRef, following, followNow, stopFollowing };
}
