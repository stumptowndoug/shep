/**
 * Separator-agnostic basename: the last non-empty segment of a path.
 * Handles both `/Users/x/repo` and `C:\Users\x\repo`.
 */
export function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}
