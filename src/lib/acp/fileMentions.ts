// `@path` file mentions in chat prompts: finding the one being typed, ranking
// project files for it, and sending mentions as ACP resource links.

/** The `@query` being typed at the caret, if any: `start` is the index of the `@`. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Gaps between `query`'s characters in `text`, or null when it isn't a subsequence. */
function subsequenceGaps(text: string, query: string): number | null {
  let from = 0;
  let gaps = 0;
  for (const char of query) {
    const at = text.indexOf(char, from);
    if (at < 0) return null;
    if (at > from) gaps += 1;
    from = at + 1;
  }
  return gaps;
}

/** Lower is better; null when `query` doesn't match `path` at all. */
function score(path: string, query: string): number | null {
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1 + name.length / 100;
  if (name.includes(query)) return 2 + name.length / 100;
  if (lower.includes(query)) return 3 + lower.length / 1000;
  // Loose: "chtv" finds ChatView.tsx. Within the name first, fewer gaps first.
  const inName = subsequenceGaps(name, query);
  if (inName !== null) return 4 + inName / 10 + name.length / 1000;
  const inPath = subsequenceGaps(lower, query);
  return inPath === null ? null : 5 + inPath / 10 + lower.length / 10_000;
}

/** Best files for a mention query: name matches before path matches, shorter first. */
export function rankFiles(files: readonly string[], query: string, limit = 8): string[] {
  const needle = query.toLowerCase();
  if (!needle) return files.filter(file => !file.includes("/")).slice(0, limit);
  const scored: [number, string][] = [];
  for (const file of files) {
    const value = score(file, needle);
    if (value !== null) scored.push([value, file]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, limit).map(([, file]) => file);
}

export type PromptBlock = { type: "text"; text: string } | { type: "resource_link"; uri: string; name: string };

/** Split prompt text at mentions of known project files into text and resource
 * links, in order, the way editors send them. Other `@words` stay text. */
export function promptBlocks(text: string, files: ReadonlySet<string>, repoPath: string): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  let last = 0;
  for (const match of text.matchAll(/(^|\s)@(\S+)/g)) {
    // Trailing punctuation ("see @a.ts.") isn't part of the path.
    const path = match[2].replace(/[.,;:!?)\]]+$/, "");
    if (!files.has(path)) continue;
    const at = match.index + match[1].length;
    if (at > last) blocks.push({ type: "text", text: text.slice(last, at) });
    const root = repoPath.replace(/\/+$/, "");
    blocks.push({ type: "resource_link", uri: `file://${encodeURI(`${root}/${path}`)}`, name: basename(path) });
    last = at + 1 + path.length;
  }
  if (last < text.length || blocks.length === 0) blocks.push({ type: "text", text: text.slice(last) });
  return blocks;
}
