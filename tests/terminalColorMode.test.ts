import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldSuppressCursorDim,
  terminalColorEnvironment,
  terminalMinimumContrastRatio,
} from "../src/lib/terminalColorMode.ts";
import { THEMES } from "../src/lib/themes.ts";

const lightTheme = THEMES["github-light"];
const darkTheme = THEMES["tokyo-night"];

test("terminal environment includes Cursor's startup theme hint", () => {
  assert.deepEqual(terminalColorEnvironment(lightTheme), {
    COLORFGBG: "0;15",
    TERM_THEME: "light",
  });
  assert.deepEqual(terminalColorEnvironment(darkTheme), {
    COLORFGBG: "15;0",
    TERM_THEME: "dark",
  });
});

test("Cursor light mode gets an AA contrast floor", () => {
  assert.equal(terminalMinimumContrastRatio(lightTheme, "cursor"), 4.5);
  assert.equal(terminalMinimumContrastRatio(darkTheme, "cursor"), 1);
  assert.equal(terminalMinimumContrastRatio(lightTheme, "claude"), 1);
  assert.equal(terminalMinimumContrastRatio(lightTheme, null), 1);
});

test("only Cursor's standalone light-mode dim command is suppressed", () => {
  assert.equal(shouldSuppressCursorDim(lightTheme, "cursor", [2]), true);
  assert.equal(shouldSuppressCursorDim(darkTheme, "cursor", [2]), false);
  assert.equal(shouldSuppressCursorDim(lightTheme, "claude", [2]), false);
  assert.equal(shouldSuppressCursorDim(lightTheme, "cursor", [2, 37]), false);
  assert.equal(shouldSuppressCursorDim(lightTheme, "cursor", [22]), false);
});
