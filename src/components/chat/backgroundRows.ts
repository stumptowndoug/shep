/**
 * Which rows of running background work (commands, delegated agents) are on
 * screen, for the jump shortcut above the composer. Rows register with a ref
 * callback; an IntersectionObserver on the viewport sees the chat's own scroll
 * clipping too.
 */
export type RowRef = (node: HTMLElement | null) => (() => void) | undefined;

export function createRowTracker(onChange: (visible: ReadonlySet<string>) => void) {
  const visible = new Set<string>();
  const nodes = new Map<string, HTMLElement>();
  const keys = new WeakMap<Element, string>();
  const refs = new Map<string, RowRef>();
  let observer: IntersectionObserver | null = null;
  let pending: string | null = null;

  const publish = () => onChange(new Set(visible));
  const getObserver = () => observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const key = keys.get(entry.target);
      if (!key) continue;
      if (entry.isIntersecting) visible.add(key);
      else visible.delete(key);
    }
    publish();
  });
  const reveal = (node: HTMLElement) => node.scrollIntoView({ block: "center", behavior: "smooth" });

  return {
    /** A stable ref callback for the row `key`, so re-renders don't re-register it. */
    track(key: string) {
      let ref = refs.get(key);
      if (!ref) {
        ref = (node: HTMLElement | null) => {
          if (!node) return undefined;
          nodes.set(key, node);
          keys.set(node, key);
          getObserver().observe(node);
          // A jump to a row that wasn't rendered yet lands once it is.
          if (pending === key) {
            pending = null;
            window.requestAnimationFrame(() => reveal(node));
          }
          return () => {
            getObserver().unobserve(node);
            if (nodes.get(key) === node) nodes.delete(key);
            if (visible.delete(key)) publish();
          };
        };
        refs.set(key, ref);
      }
      return ref;
    },
    /** Scroll to the row now, or as soon as it renders. */
    jump(key: string) {
      const node = nodes.get(key);
      if (node) reveal(node);
      else pending = key;
    },
  };
}
