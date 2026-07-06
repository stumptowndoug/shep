import type { CSSProperties } from "react";
import type { ShepTheme } from "../../lib/themes";
import { hexLuminance } from "../../lib/themes";
import { shikiThemeFor } from "../../lib/shikiHighlighter";

export const CODE_VIEW_FONT_STACK = "\"SF Mono\", \"Fira Code\", \"Cascadia Code\", \"Consolas\", monospace";
export const CODE_VIEW_FONT_SIZE = "12px";
export const CODE_VIEW_LINE_HEIGHT = "18px";
export const CODE_VIEW_LINE_PADDING_X = "14px";
export const CODE_VIEW_FILE_LINE_PADDING_LEFT = "6px";
export const CODE_VIEW_FILE_LINE_PADDING_RIGHT = "12px";
export const CODE_VIEW_LINE_NUMBER_WIDTH = "2.5em";
export const CODE_VIEW_LINE_NUMBER_GAP = "8px";
export const CODE_VIEW_BLOCK_PADDING = "8px";
export const CODE_VIEW_DIFF_GUTTER_PADDING_RIGHT = "8px";
export const CODE_VIEW_DIFF_PREFIX_WIDTH = "1ch";
export const CODE_VIEW_DIFF_PREFIX_OFFSET = "6px";

export function getCodeViewCSSVariables(): CSSProperties {
  return {
    "--code-view-font-family": CODE_VIEW_FONT_STACK,
    "--code-view-font-size": CODE_VIEW_FONT_SIZE,
    "--code-view-line-height": CODE_VIEW_LINE_HEIGHT,
    "--code-view-line-padding-x": CODE_VIEW_LINE_PADDING_X,
    "--code-view-file-line-padding-left": CODE_VIEW_FILE_LINE_PADDING_LEFT,
    "--code-view-file-line-padding-right": CODE_VIEW_FILE_LINE_PADDING_RIGHT,
    "--code-view-line-number-width": CODE_VIEW_LINE_NUMBER_WIDTH,
    "--code-view-line-number-gap": CODE_VIEW_LINE_NUMBER_GAP,
    "--code-view-block-padding": CODE_VIEW_BLOCK_PADDING,
    "--code-view-diff-gutter-padding-right": CODE_VIEW_DIFF_GUTTER_PADDING_RIGHT,
    "--code-view-diff-prefix-width": CODE_VIEW_DIFF_PREFIX_WIDTH,
    "--code-view-diff-prefix-offset": CODE_VIEW_DIFF_PREFIX_OFFSET,
  } as CSSProperties;
}

export function getDiffViewOptions(theme: ShepTheme) {
  const themeType: "light" | "dark" = hexLuminance(theme.appBg) > 0.3 ? "light" : "dark";
  return {
    theme: shikiThemeFor(theme),
    themeType,
    diffStyle: "unified" as const,
    diffIndicators: "classic" as const,
    lineDiffType: "word-alt" as const,
    hunkSeparators: "line-info-basic" as const,
    disableFileHeader: true,
    overflow: "scroll" as const,
    unsafeCSS: `
      :host {
        display: block;
        min-height: 100%;
        color: var(--text-primary);
        background: transparent;
        --diffs-bg: transparent;
        --diffs-bg-buffer-override: transparent;
        --diffs-bg-hover-override: color-mix(in srgb, var(--overlay) 4%, transparent);
        --diffs-bg-context-override: transparent;
        --diffs-bg-context-number-override: color-mix(
          in srgb,
          var(--overlay) 4%,
          transparent
        );
        --diffs-bg-separator-override: color-mix(
          in srgb,
          var(--overlay) 6%,
          transparent
        );
        --diffs-fg-number-override: color-mix(in srgb, var(--text-muted) 92%, transparent);
        --diffs-fg-number-addition-override: color-mix(
          in srgb,
          var(--diff-add) 78%,
          var(--text-primary)
        );
        --diffs-fg-number-deletion-override: color-mix(
          in srgb,
          var(--diff-del) 78%,
          var(--text-primary)
        );
        --diffs-addition-color-override: var(--diff-add);
        --diffs-deletion-color-override: var(--diff-del);
        --diffs-modified-color-override: var(--diff-hunk);
        --diffs-bg-addition-override: color-mix(
          in srgb,
          var(--diff-add) var(--color-opacity-diff),
          transparent
        );
        --diffs-bg-addition-number-override: color-mix(
          in srgb,
          var(--diff-add) 14%,
          transparent
        );
        --diffs-bg-addition-hover-override: color-mix(
          in srgb,
          var(--diff-add) 14%,
          transparent
        );
        --diffs-bg-addition-emphasis-override: color-mix(
          in srgb,
          var(--diff-add) 18%,
          transparent
        );
        --diffs-bg-deletion-override: color-mix(
          in srgb,
          var(--diff-del) var(--color-opacity-diff),
          transparent
        );
        --diffs-bg-deletion-number-override: color-mix(
          in srgb,
          var(--diff-del) 14%,
          transparent
        );
        --diffs-bg-deletion-hover-override: color-mix(
          in srgb,
          var(--diff-del) 14%,
          transparent
        );
        --diffs-bg-deletion-emphasis-override: color-mix(
          in srgb,
          var(--diff-del) 18%,
          transparent
        );
        --diffs-font-family: var(--code-view-font-family);
        --diffs-header-font-family: var(--code-view-font-family);
        --diffs-font-size: var(--code-view-font-size);
        --diffs-line-height: var(--code-view-line-height);
        --diffs-gap-block: var(--code-view-block-padding);
        --diffs-gap-inline: 0px;
        --diffs-gap-style: 0px solid transparent;
        --diffs-min-number-column-width: var(--code-view-line-number-width);
      }
      pre,
      code {
        font-family: var(--code-view-font-family);
      }
      [data-code] {
        padding-top: var(--code-view-block-padding);
      }
      [data-line],
      [data-column-number],
      [data-no-newline] {
        font-size: var(--code-view-font-size);
        line-height: var(--code-view-line-height);
        padding-inline: 0;
      }
      [data-column-number] {
        width: calc(
          var(--code-view-line-number-width) + var(--code-view-diff-gutter-padding-right)
        );
        padding-left: 0;
        padding-right: var(--code-view-diff-gutter-padding-right);
        font-variant-numeric: tabular-nums;
      }
      [data-line-number-content] {
        width: var(--code-view-line-number-width);
        min-width: var(--code-view-line-number-width);
      }
      [data-line],
      [data-no-newline] {
        padding-inline-end: var(--code-view-file-line-padding-right);
        padding-inline-start: var(--code-view-file-line-padding-left);
      }
      [data-indicators='classic'] [data-line],
      [data-indicators='classic'] [data-no-newline] {
        padding-inline-start: calc(
          var(--code-view-diff-prefix-offset) + var(--code-view-diff-prefix-width)
        );
      }
      [data-indicators='classic'] [data-line-type='change-addition'][data-line]::before,
      [data-indicators='classic'] [data-line-type='change-addition'][data-no-newline]::before,
      [data-indicators='classic'] [data-line-type='change-deletion'][data-line]::before,
      [data-indicators='classic'] [data-line-type='change-deletion'][data-no-newline]::before {
        left: var(--code-view-diff-prefix-offset);
        width: var(--code-view-diff-prefix-width);
      }
      [data-error-wrapper] {
        background: transparent;
      }
    `,
  };
}
