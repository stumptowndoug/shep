import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeChanges } from "../src/lib/gitChangeSummary.ts";
import type { ChangedFile } from "../src/lib/types.ts";

const file = (path: string, area = "unstaged"): ChangedFile => ({ path, area, status: "M", old_path: null });

test("counts a file with staged and unstaged edits once and prefers its working copy", () => {
  const staged = file("app.ts", "staged");
  const unstaged = file("app.ts");
  for (const files of [[staged, unstaged], [unstaged, staged]]) {
    const summary = summarizeChanges(files, [{ path: "app.ts", additions: 10, deletions: 4 }]);
    assert.deepEqual(summary, { files: [unstaged], additions: 10, deletions: 4 });
  }
});

test("includes untracked files and opens the largest change first", () => {
  const edited = file("app.ts");
  const added = file("new.ts", "untracked");
  assert.deepEqual(summarizeChanges([edited, added], [
    { path: edited.path, additions: 3, deletions: 2 },
    { path: added.path, additions: 18, deletions: 0 },
  ]), { files: [added, edited], additions: 21, deletions: 2 });
});

test("binary-only changes remain reviewable despite having no line changes", () => {
  const binary = file("logo.png");
  assert.deepEqual(summarizeChanges([binary], [{ path: binary.path, additions: 0, deletions: 0 }]), {
    files: [binary], additions: 0, deletions: 0,
  });
});

test("totals include rename stats even when Git formats the path differently", () => {
  const renamed = { ...file("src/new.ts", "staged"), status: "R", old_path: "src/old.ts" };
  const summary = summarizeChanges([renamed], [{ path: "src/{old.ts => new.ts}", additions: 7, deletions: 1 }]);
  assert.deepEqual(summary, { files: [renamed], additions: 7, deletions: 1 });
});

test("a clean project has no summary files", () => {
  assert.deepEqual(summarizeChanges([], []), { files: [], additions: 0, deletions: 0 });
});
