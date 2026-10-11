export interface ShepTheme {
  id: string;
  name: string;
  isTransparent: boolean;

  // Body background
  bgRadial1: string;
  bgRadial2: string;
  bgRadial3: string;
  bgLinearFrom: string;
  bgLinearMid: string;
  bgLinearTo: string;

  // Glass tints
  frameTint: string;
  /** Sidebar ground. Set by `withLayeredSurfaces`; absent on raw theme definitions. */
  sidebarBg?: string;
  /** Things you act on: primary buttons, links, focus, selection. */
  accent?: string;
  panelTint: string;
  glassBorder: string;
  glassPanelStrong: string;
  glassBorderStrong: string;

  // Status indicators
  statusRunning: string;
  statusStopped: string;
  statusCrashed: string;
  statusAttention: string;

  // Core UI colors
  appBg: string;
  appFg: string;

  // Terminal ANSI palette
  termForeground: string;
  termCursor: string;
  termSelection: string;
  termBlack: string;
  termRed: string;
  termGreen: string;
  termYellow: string;
  termBlue: string;
  termMagenta: string;
  termCyan: string;
  termWhite: string;
  termBrightBlack: string;
  termBrightRed: string;
  termBrightGreen: string;
  termBrightYellow: string;
  termBrightBlue: string;
  termBrightMagenta: string;
  termBrightCyan: string;
  termBrightWhite: string;
}

/* ── Tokyo Night ───────────────────────────────────────── */
const tokyoNight: ShepTheme = {
  id: "tokyo-night",
  name: "Tokyo Night",
  isTransparent: false,

  bgRadial1: "rgba(122, 162, 247, 0.10)",
  bgRadial2: "rgba(187, 154, 247, 0.06)",
  bgRadial3: "rgba(125, 207, 255, 0.06)",
  bgLinearFrom: "#13141c",
  bgLinearMid: "#16171f",
  bgLinearTo: "#13141c",

  frameTint: "#1a1b26",
  panelTint: "rgba(26, 27, 38, 0.60)",
  glassBorder: "rgba(169, 177, 214, 0.12)",
  glassPanelStrong: "rgba(22, 22, 30, 0.78)",
  glassBorderStrong: "rgba(169, 177, 214, 0.18)",

  statusRunning: "#7aa2f7",
  statusStopped: "#414868",
  statusCrashed: "#f7768e",
  statusAttention: "#e0af68",

  appBg: "#1a1b26",
  appFg: "#c0caf5",

  termForeground: "#c0caf5",
  termCursor: "#c0caf5",
  termSelection: "#283457",
  termBlack: "#15161e",
  termRed: "#f7768e",
  termGreen: "#9ece6a",
  termYellow: "#e0af68",
  termBlue: "#7aa2f7",
  termMagenta: "#bb9af7",
  termCyan: "#7dcfff",
  termWhite: "#a9b1d6",
  termBrightBlack: "#414868",
  termBrightRed: "#f7768e",
  termBrightGreen: "#9ece6a",
  termBrightYellow: "#e0af68",
  termBrightBlue: "#7aa2f7",
  termBrightMagenta: "#bb9af7",
  termBrightCyan: "#7dcfff",
  termBrightWhite: "#c0caf5",
};

/* ── Dracula ───────────────────────────────────────────── */
const dracula: ShepTheme = {
  id: "dracula",
  name: "Dracula",
  isTransparent: false,

  bgRadial1: "rgba(189, 147, 249, 0.08)",
  bgRadial2: "rgba(255, 121, 198, 0.05)",
  bgRadial3: "rgba(139, 233, 253, 0.05)",
  bgLinearFrom: "#1d1e28",
  bgLinearMid: "#282a36",
  bgLinearTo: "#1d1e28",

  frameTint: "#282a36",
  panelTint: "rgba(40, 42, 54, 0.60)",
  glassBorder: "rgba(98, 114, 164, 0.14)",
  glassPanelStrong: "rgba(33, 34, 44, 0.78)",
  glassBorderStrong: "rgba(98, 114, 164, 0.20)",

  statusRunning: "#8be9fd",
  statusStopped: "#6272a4",
  statusCrashed: "#ff5555",
  statusAttention: "#f1fa8c",

  appBg: "#282a36",
  appFg: "#f8f8f2",

  termForeground: "#f8f8f2",
  termCursor: "#f8f8f2",
  termSelection: "#44475a",
  termBlack: "#21222c",
  termRed: "#ff5555",
  termGreen: "#50fa7b",
  termYellow: "#f1fa8c",
  termBlue: "#bd93f9",
  termMagenta: "#ff79c6",
  termCyan: "#8be9fd",
  termWhite: "#f8f8f2",
  termBrightBlack: "#6272a4",
  termBrightRed: "#ff6e6e",
  termBrightGreen: "#69ff94",
  termBrightYellow: "#ffffa5",
  termBrightBlue: "#d6acff",
  termBrightMagenta: "#ff92df",
  termBrightCyan: "#a4ffff",
  termBrightWhite: "#ffffff",
};

/* ── Catppuccin Mocha ──────────────────────────────────── */
const catppuccin: ShepTheme = {
  id: "catppuccin",
  name: "Catppuccin Mocha",
  isTransparent: false,

  bgRadial1: "rgba(137, 180, 250, 0.08)",
  bgRadial2: "rgba(245, 194, 231, 0.05)",
  bgRadial3: "rgba(148, 226, 213, 0.05)",

  bgLinearFrom: "#181825",
  bgLinearMid: "#1e1e2e",
  bgLinearTo: "#181825",

  frameTint: "#1e1e2e",
  panelTint: "rgba(30, 30, 46, 0.60)",
  glassBorder: "rgba(166, 173, 200, 0.12)",
  glassPanelStrong: "rgba(30, 30, 46, 0.78)",
  glassBorderStrong: "rgba(166, 173, 200, 0.18)",

  statusRunning: "#89b4fa",
  statusStopped: "#585b70",
  statusCrashed: "#f38ba8",
  statusAttention: "#f9e2af",

  appBg: "#1e1e2e",
  appFg: "#cdd6f4",

  termForeground: "#cdd6f4",
  termCursor: "#f5e0dc",
  termSelection: "#353748",
  termBlack: "#45475a",
  termRed: "#f38ba8",
  termGreen: "#a6e3a1",
  termYellow: "#f9e2af",
  termBlue: "#89b4fa",
  termMagenta: "#f5c2e7",
  termCyan: "#94e2d5",
  termWhite: "#a6adc8",
  termBrightBlack: "#585b70",
  termBrightRed: "#f37799",
  termBrightGreen: "#89d88b",
  termBrightYellow: "#ebd391",
  termBrightBlue: "#74a8fc",
  termBrightMagenta: "#f2aede",
  termBrightCyan: "#6bd7ca",
  termBrightWhite: "#bac2de",
};

/* ── Catppuccin Glass (Transparent) ───────────────────── */
const catppuccinGlass: ShepTheme = {
  id: "catppuccin-glass",
  name: "Catppuccin Glass",
  isTransparent: true,

  bgRadial1: "rgba(137, 180, 250, 0.08)",
  bgRadial2: "rgba(245, 194, 231, 0.05)",
  bgRadial3: "rgba(148, 226, 213, 0.05)",
  bgLinearFrom: "rgba(30, 30, 46, 0.30)",
  bgLinearMid: "rgba(30, 30, 46, 0.22)",
  bgLinearTo: "rgba(30, 30, 46, 0.30)",

  frameTint: "rgba(30, 30, 46, 0.10)",
  panelTint: "rgba(30, 30, 46, 0.14)",
  glassBorder: "rgba(166, 173, 200, 0.12)",
  glassPanelStrong: "rgba(30, 30, 46, 0.40)",
  glassBorderStrong: "rgba(166, 173, 200, 0.16)",

  statusRunning: "#89b4fa",
  statusStopped: "#585b70",
  statusCrashed: "#f38ba8",
  statusAttention: "#f9e2af",

  appBg: "#1e1e2e",
  appFg: "#cdd6f4",

  termForeground: "#cdd6f4",
  termCursor: "#f5e0dc",
  termSelection: "#3537484d",
  termBlack: "#45475a",
  termRed: "#f38ba8",
  termGreen: "#a6e3a1",
  termYellow: "#f9e2af",
  termBlue: "#89b4fa",
  termMagenta: "#f5c2e7",
  termCyan: "#94e2d5",
  termWhite: "#a6adc8",
  termBrightBlack: "#585b70",
  termBrightRed: "#f37799",
  termBrightGreen: "#89d88b",
  termBrightYellow: "#ebd391",
  termBrightBlue: "#74a8fc",
  termBrightMagenta: "#f2aede",
  termBrightCyan: "#6bd7ca",
  termBrightWhite: "#bac2de",
};

/* ── Nightfox Glass (Transparent) ────────────────────── */
const nightfoxGlass: ShepTheme = {
  id: "nightfox-glass",
  name: "Nightfox Glass",
  isTransparent: true,

  bgRadial1: "rgba(113, 156, 214, 0.08)",
  bgRadial2: "rgba(157, 121, 214, 0.06)",
  bgRadial3: "rgba(99, 205, 207, 0.05)",
  bgLinearFrom: "rgba(25, 35, 48, 0.30)",
  bgLinearMid: "rgba(25, 35, 48, 0.22)",
  bgLinearTo: "rgba(25, 35, 48, 0.30)",

  frameTint: "rgba(25, 35, 48, 0.10)",
  panelTint: "rgba(25, 35, 48, 0.14)",
  glassBorder: "rgba(205, 206, 207, 0.12)",
  glassPanelStrong: "rgba(25, 35, 48, 0.40)",
  glassBorderStrong: "rgba(205, 206, 207, 0.16)",

  statusRunning: "#719cd6",
  statusStopped: "#575860",
  statusCrashed: "#c94f6d",
  statusAttention: "#dbc074",

  appBg: "#192330",
  appFg: "#cdcecf",

  termForeground: "#cdcecf",
  termCursor: "#cdcecf",
  termSelection: "#2b3b514d",
  termBlack: "#393b44",
  termRed: "#c94f6d",
  termGreen: "#81b29a",
  termYellow: "#dbc074",
  termBlue: "#719cd6",
  termMagenta: "#9d79d6",
  termCyan: "#63cdcf",
  termWhite: "#dfdfe0",
  termBrightBlack: "#575860",
  termBrightRed: "#d16983",
  termBrightGreen: "#8ebaa4",
  termBrightYellow: "#e0c989",
  termBrightBlue: "#86abdc",
  termBrightMagenta: "#baa1e2",
  termBrightCyan: "#7ad5d6",
  termBrightWhite: "#e4e4e5",
};

/* ── Tokyo Glass (Transparent) ───────────────────────── */
const tokyoGlass: ShepTheme = {
  id: "tokyo-glass",
  name: "Tokyo Glass",
  isTransparent: true,

  bgRadial1: "rgba(122, 162, 247, 0.10)",
  bgRadial2: "rgba(187, 154, 247, 0.06)",
  bgRadial3: "rgba(125, 207, 255, 0.06)",
  bgLinearFrom: "rgba(26, 27, 38, 0.30)",
  bgLinearMid: "rgba(26, 27, 38, 0.22)",
  bgLinearTo: "rgba(26, 27, 38, 0.30)",

  frameTint: "rgba(26, 27, 38, 0.10)",
  panelTint: "rgba(26, 27, 38, 0.14)",
  glassBorder: "rgba(169, 177, 214, 0.12)",
  glassPanelStrong: "rgba(26, 27, 38, 0.40)",
  glassBorderStrong: "rgba(169, 177, 214, 0.16)",

  statusRunning: "#7aa2f7",
  statusStopped: "#414868",
  statusCrashed: "#f7768e",
  statusAttention: "#e0af68",

  appBg: "#1a1b26",
  appFg: "#c0caf5",

  termForeground: "#c0caf5",
  termCursor: "#c0caf5",
  termSelection: "#2834574d",
  termBlack: "#15161e",
  termRed: "#f7768e",
  termGreen: "#9ece6a",
  termYellow: "#e0af68",
  termBlue: "#7aa2f7",
  termMagenta: "#bb9af7",
  termCyan: "#7dcfff",
  termWhite: "#a9b1d6",
  termBrightBlack: "#414868",
  termBrightRed: "#f7768e",
  termBrightGreen: "#9ece6a",
  termBrightYellow: "#e0af68",
  termBrightBlue: "#7aa2f7",
  termBrightMagenta: "#bb9af7",
  termBrightCyan: "#7dcfff",
  termBrightWhite: "#c0caf5",
};

/* ── Carbonfox Dark ───────────────────────────────────── */
const carbonfox: ShepTheme = {
  id: "carbonfox",
  name: "Carbonfox",
  isTransparent: false,

  bgRadial1: "rgba(120, 169, 255, 0.08)",
  bgRadial2: "rgba(190, 149, 255, 0.06)",
  bgRadial3: "rgba(51, 177, 255, 0.05)",

  bgLinearFrom: "#0e0e0e",
  bgLinearMid: "#161616",
  bgLinearTo: "#0e0e0e",

  frameTint: "#161616",
  panelTint: "rgba(22, 22, 22, 0.60)",
  glassBorder: "rgba(242, 244, 248, 0.12)",
  glassPanelStrong: "rgba(22, 22, 22, 0.78)",
  glassBorderStrong: "rgba(242, 244, 248, 0.18)",

  statusRunning: "#78a9ff",
  statusStopped: "#484848",
  statusCrashed: "#ee5396",
  statusAttention: "#ffe97b",

  appBg: "#161616",
  appFg: "#f2f4f8",

  termForeground: "#f2f4f8",
  termCursor: "#f2f4f8",
  termSelection: "#2a2a2a",
  termBlack: "#282828",
  termRed: "#ee5396",
  termGreen: "#25be6a",
  termYellow: "#08bdba",
  termBlue: "#78a9ff",
  termMagenta: "#be95ff",
  termCyan: "#33b1ff",
  termWhite: "#dfdfe0",
  termBrightBlack: "#484848",
  termBrightRed: "#f16da6",
  termBrightGreen: "#46c880",
  termBrightYellow: "#2dc7c4",
  termBrightBlue: "#8cb6ff",
  termBrightMagenta: "#c8a5ff",
  termBrightCyan: "#52bdff",
  termBrightWhite: "#e4e4e5",
};

/* ── Jellybeans Dark ──────────────────────────────────── */
const jellybeans: ShepTheme = {
  id: "jellybeans",
  name: "Jellybeans",
  isTransparent: false,

  bgRadial1: "rgba(151, 190, 220, 0.08)",
  bgRadial2: "rgba(225, 192, 250, 0.06)",
  bgRadial3: "rgba(0, 152, 142, 0.05)",

  bgLinearFrom: "#0a0a0a",
  bgLinearMid: "#121212",
  bgLinearTo: "#0a0a0a",

  frameTint: "#121212",
  panelTint: "rgba(18, 18, 18, 0.60)",
  glassBorder: "rgba(222, 222, 222, 0.12)",
  glassPanelStrong: "rgba(18, 18, 18, 0.78)",
  glassBorderStrong: "rgba(222, 222, 222, 0.18)",

  statusRunning: "#97bedc",
  statusStopped: "#929292",
  statusCrashed: "#e27373",
  statusAttention: "#ffba7b",

  appBg: "#121212",
  appFg: "#dedede",

  termForeground: "#dedede",
  termCursor: "#ffa560",
  termSelection: "#474e91",
  termBlack: "#929292",
  termRed: "#e27373",
  termGreen: "#94b979",
  termYellow: "#ffba7b",
  termBlue: "#97bedc",
  termMagenta: "#e1c0fa",
  termCyan: "#00988e",
  termWhite: "#dedede",
  termBrightBlack: "#bdbdbd",
  termBrightRed: "#ffa1a1",
  termBrightGreen: "#bddeab",
  termBrightYellow: "#ffdca0",
  termBrightBlue: "#b1d8f6",
  termBrightMagenta: "#fbdaff",
  termBrightCyan: "#1ab2a8",
  termBrightWhite: "#ffffff",
};

/* ── Kanagawa Dark ───────────────────────────────────── */
const kanagawa: ShepTheme = {
  id: "kanagawa",
  name: "Kanagawa",
  isTransparent: false,

  bgRadial1: "rgba(126, 156, 216, 0.10)",
  bgRadial2: "rgba(149, 127, 184, 0.06)",
  bgRadial3: "rgba(122, 168, 159, 0.06)",

  bgLinearFrom: "#181820",
  bgLinearMid: "#1f1f28",
  bgLinearTo: "#181820",

  frameTint: "#1f1f28",
  panelTint: "rgba(31, 31, 40, 0.60)",
  glassBorder: "rgba(220, 215, 186, 0.12)",
  glassPanelStrong: "rgba(31, 31, 40, 0.78)",
  glassBorderStrong: "rgba(220, 215, 186, 0.18)",

  statusRunning: "#7e9cd8",
  statusStopped: "#727169",
  statusCrashed: "#e82424",
  statusAttention: "#e6c384",

  appBg: "#1f1f28",
  appFg: "#dcd7ba",

  termForeground: "#dcd7ba",
  termCursor: "#dcd7ba",
  termSelection: "#2d4f67",
  termBlack: "#16161d",
  termRed: "#c34043",
  termGreen: "#76946a",
  termYellow: "#c0a36e",
  termBlue: "#7e9cd8",
  termMagenta: "#957fb8",
  termCyan: "#6a9589",
  termWhite: "#c8c093",
  termBrightBlack: "#727169",
  termBrightRed: "#e82424",
  termBrightGreen: "#98bb6c",
  termBrightYellow: "#e6c384",
  termBrightBlue: "#7fb4ca",
  termBrightMagenta: "#938aa9",
  termBrightCyan: "#7aa89f",
  termBrightWhite: "#dcd7ba",
};

/* ── Nightfox Dark ────────────────────────────────────── */
const nightfoxDark: ShepTheme = {
  id: "nightfox-dark",
  name: "Nightfox",
  isTransparent: false,

  bgRadial1: "rgba(113, 156, 214, 0.08)",
  bgRadial2: "rgba(157, 121, 214, 0.06)",
  bgRadial3: "rgba(99, 205, 207, 0.05)",

  bgLinearFrom: "#111a25",
  bgLinearMid: "#192330",
  bgLinearTo: "#111a25",

  frameTint: "#192330",
  panelTint: "rgba(25, 35, 48, 0.60)",
  glassBorder: "rgba(205, 206, 207, 0.12)",
  glassPanelStrong: "rgba(25, 35, 48, 0.78)",
  glassBorderStrong: "rgba(205, 206, 207, 0.18)",

  statusRunning: "#719cd6",
  statusStopped: "#575860",
  statusCrashed: "#c94f6d",
  statusAttention: "#dbc074",

  appBg: "#192330",
  appFg: "#cdcecf",

  termForeground: "#cdcecf",
  termCursor: "#cdcecf",
  termSelection: "#2b3b51",
  termBlack: "#393b44",
  termRed: "#c94f6d",
  termGreen: "#81b29a",
  termYellow: "#dbc074",
  termBlue: "#719cd6",
  termMagenta: "#9d79d6",
  termCyan: "#63cdcf",
  termWhite: "#dfdfe0",
  termBrightBlack: "#575860",
  termBrightRed: "#d16983",
  termBrightGreen: "#8ebaa4",
  termBrightYellow: "#e0c989",
  termBrightBlue: "#86abdc",
  termBrightMagenta: "#baa1e2",
  termBrightCyan: "#7ad5d6",
  termBrightWhite: "#e4e4e5",
};

/* ── Solarized Light ──────────────────────────────────── */
const solarized: ShepTheme = {
  id: "solarized",
  name: "Solarized",
  isTransparent: false,

  bgRadial1: "rgba(38, 139, 210, 0.08)",
  bgRadial2: "rgba(211, 54, 130, 0.05)",
  bgRadial3: "rgba(42, 161, 152, 0.05)",

  bgLinearFrom: "#f3edd9",
  bgLinearMid: "#fdf6e3",
  bgLinearTo: "#f3edd9",

  frameTint: "#fdf6e3",
  panelTint: "rgba(253, 246, 227, 0.60)",
  glassBorder: "rgba(101, 123, 131, 0.25)",
  glassPanelStrong: "rgba(253, 246, 227, 0.78)",
  glassBorderStrong: "rgba(101, 123, 131, 0.35)",

  statusRunning: "#268bd2",
  statusStopped: "#586e75",
  statusCrashed: "#dc322f",
  statusAttention: "#b58900",

  appBg: "#fdf6e3",
  appFg: "#657b83",

  termForeground: "#657b83",
  termCursor: "#657b83",
  termSelection: "#eee8d5",
  termBlack: "#073642",
  termRed: "#dc322f",
  termGreen: "#859900",
  termYellow: "#b58900",
  termBlue: "#268bd2",
  termMagenta: "#d33682",
  termCyan: "#2aa198",
  termWhite: "#eee8d5",
  termBrightBlack: "#002b36",
  termBrightRed: "#cb4b16",
  termBrightGreen: "#586e75",
  termBrightYellow: "#657b83",
  termBrightBlue: "#839496",
  termBrightMagenta: "#6c71c4",
  termBrightCyan: "#93a1a1",
  termBrightWhite: "#fdf6e3",
};

/* ── Tokyo Day ────────────────────────────────────────── */
const tokyoDay: ShepTheme = {
  id: "tokyo-day",
  name: "Tokyo Day",
  isTransparent: false,

  bgRadial1: "rgba(46, 125, 233, 0.08)",
  bgRadial2: "rgba(152, 84, 241, 0.05)",
  bgRadial3: "rgba(0, 113, 151, 0.05)",

  bgLinearFrom: "#d8d9de",
  bgLinearMid: "#e1e2e7",
  bgLinearTo: "#d8d9de",

  frameTint: "#e1e2e7",
  panelTint: "rgba(225, 226, 231, 0.60)",
  glassBorder: "rgba(55, 96, 191, 0.25)",
  glassPanelStrong: "rgba(225, 226, 231, 0.78)",
  glassBorderStrong: "rgba(55, 96, 191, 0.35)",

  statusRunning: "#2e7de9",
  statusStopped: "#a1a6c5",
  statusCrashed: "#f52a65",
  statusAttention: "#8c6c3e",

  appBg: "#e1e2e7",
  appFg: "#3760bf",

  termForeground: "#3760bf",
  termCursor: "#3760bf",
  termSelection: "#b7c1e3",
  termBlack: "#b4b5b9",
  termRed: "#f52a65",
  termGreen: "#587539",
  termYellow: "#8c6c3e",
  termBlue: "#2e7de9",
  termMagenta: "#9854f1",
  termCyan: "#007197",
  termWhite: "#6172b0",
  termBrightBlack: "#a1a6c5",
  termBrightRed: "#f52a65",
  termBrightGreen: "#587539",
  termBrightYellow: "#8c6c3e",
  termBrightBlue: "#2e7de9",
  termBrightMagenta: "#9854f1",
  termBrightCyan: "#007197",
  termBrightWhite: "#3760bf",
};

/* ── GitHub Light ─────────────────────────────────────── */
const githubLight: ShepTheme = {
  id: "github-light",
  name: "GitHub Light",
  isTransparent: false,

  bgRadial1: "rgba(9, 105, 218, 0.08)",
  bgRadial2: "rgba(130, 80, 223, 0.05)",
  bgRadial3: "rgba(27, 124, 131, 0.05)",

  bgLinearFrom: "#eceef1",
  bgLinearMid: "#f6f8fa",
  bgLinearTo: "#eceef1",

  frameTint: "#f6f8fa",
  panelTint: "rgba(246, 248, 250, 0.60)",
  glassBorder: "rgba(31, 35, 40, 0.25)",
  glassPanelStrong: "rgba(246, 248, 250, 0.78)",
  glassBorderStrong: "rgba(31, 35, 40, 0.35)",

  statusRunning: "#0969da",
  statusStopped: "#57606a",
  statusCrashed: "#cf222e",
  statusAttention: "#4d2d00",

  appBg: "#f6f8fa",
  appFg: "#1f2328",

  termForeground: "#1f2328",
  termCursor: "#1f2328",
  termSelection: "#264f78",
  termBlack: "#24292f",
  termRed: "#cf222e",
  termGreen: "#116329",
  termYellow: "#4d2d00",
  termBlue: "#0969da",
  termMagenta: "#8250df",
  termCyan: "#1b7c83",
  termWhite: "#6e7781",
  termBrightBlack: "#57606a",
  termBrightRed: "#a40e26",
  termBrightGreen: "#1a7f37",
  termBrightYellow: "#633c01",
  termBrightBlue: "#218bff",
  termBrightMagenta: "#a475f9",
  termBrightCyan: "#3192aa",
  termBrightWhite: "#8c959f",
};

/* ── Catppuccin Latte ─────────────────────────────────── */
const catppuccinLatte: ShepTheme = {
  id: "catppuccin-latte",
  name: "Catppuccin Latte",
  isTransparent: false,

  bgRadial1: "rgba(30, 102, 245, 0.08)",
  bgRadial2: "rgba(234, 118, 203, 0.05)",
  bgRadial3: "rgba(23, 146, 153, 0.05)",

  bgLinearFrom: "#e6e8ec",
  bgLinearMid: "#eff1f5",
  bgLinearTo: "#e6e8ec",

  frameTint: "#eff1f5",
  panelTint: "rgba(239, 241, 245, 0.60)",
  glassBorder: "rgba(76, 79, 105, 0.25)",
  glassPanelStrong: "rgba(239, 241, 245, 0.78)",
  glassBorderStrong: "rgba(76, 79, 105, 0.35)",

  statusRunning: "#1e66f5",
  statusStopped: "#6c6f85",
  statusCrashed: "#d20f39",
  statusAttention: "#df8e1d",

  appBg: "#eff1f5",
  appFg: "#4c4f69",

  termForeground: "#4c4f69",
  termCursor: "#dc8a78",
  termSelection: "#d8dae1",
  termBlack: "#5c5f77",
  termRed: "#d20f39",
  termGreen: "#40a02b",
  termYellow: "#df8e1d",
  termBlue: "#1e66f5",
  termMagenta: "#ea76cb",
  termCyan: "#179299",
  termWhite: "#acb0be",
  termBrightBlack: "#6c6f85",
  termBrightRed: "#de293e",
  termBrightGreen: "#49af3d",
  termBrightYellow: "#eea02d",
  termBrightBlue: "#456eff",
  termBrightMagenta: "#fe85d8",
  termBrightCyan: "#2d9fa8",
  termBrightWhite: "#bcc0cc",
};

/* ── Nightfox Light ───────────────────────────────────── */
const nightfoxLight: ShepTheme = {
  id: "nightfox-light",
  name: "Dayfox",
  isTransparent: false,

  bgRadial1: "rgba(40, 72, 169, 0.08)",
  bgRadial2: "rgba(110, 51, 206, 0.05)",
  bgRadial3: "rgba(40, 121, 128, 0.05)",

  bgLinearFrom: "#ede6e0",
  bgLinearMid: "#f6f2ee",
  bgLinearTo: "#ede6e0",

  frameTint: "#f6f2ee",
  panelTint: "rgba(246, 242, 238, 0.60)",
  glassBorder: "rgba(61, 43, 90, 0.25)",
  glassPanelStrong: "rgba(246, 242, 238, 0.78)",
  glassBorderStrong: "rgba(61, 43, 90, 0.35)",

  statusRunning: "#2848a9",
  statusStopped: "#534c45",
  statusCrashed: "#a5222f",
  statusAttention: "#ac5402",

  appBg: "#f6f2ee",
  appFg: "#3d2b5a",

  termForeground: "#3d2b5a",
  termCursor: "#3d2b5a",
  termSelection: "#e7d2be",
  termBlack: "#352c24",
  termRed: "#a5222f",
  termGreen: "#396847",
  termYellow: "#ac5402",
  termBlue: "#2848a9",
  termMagenta: "#6e33ce",
  termCyan: "#287980",
  termWhite: "#f2e9e1",
  termBrightBlack: "#534c45",
  termBrightRed: "#b3434e",
  termBrightGreen: "#577f63",
  termBrightYellow: "#b86e28",
  termBrightBlue: "#4863b6",
  termBrightMagenta: "#8452d5",
  termBrightCyan: "#488d93",
  termBrightWhite: "#f4ece6",
};

export const THEMES: Record<string, ShepTheme> = {
  catppuccin,
  "nightfox-dark": nightfoxDark,
  "tokyo-night": tokyoNight,
  dracula,
  kanagawa,
  carbonfox,
  jellybeans,
  "catppuccin-glass": catppuccinGlass,
  "nightfox-glass": nightfoxGlass,
  "tokyo-glass": tokyoGlass,
  "catppuccin-latte": catppuccinLatte,
  "nightfox-light": nightfoxLight,
  "tokyo-day": tokyoDay,
  solarized,
  "github-light": githubLight,
};

export const THEME_LIST: ShepTheme[] = Object.values(THEMES);

/** Relative luminance of a hex color (0 = black, 1 = white) */
export function hexLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Accents for the built-in themes (each theme's signature color). */
const THEME_ACCENTS: Record<string, string> = {
  "tokyo-night": "#7aa2f7",
  "tokyo-glass": "#7aa2f7",
  "tokyo-day": "#2e7de9",
  dracula: "#bd93f9",
  catppuccin: "#cba6f7",
  "catppuccin-glass": "#cba6f7",
  "catppuccin-latte": "#8839ef",
  carbonfox: "#78a9ff",
  jellybeans: "#8197bf",
  kanagawa: "#7e9cd8",
  "nightfox-dark": "#719cd6",
  "nightfox-glass": "#719cd6",
  "nightfox-light": "#2848a9",
  solarized: "#268bd2",
  "github-light": "#0969da",
};

export function themeAccent(theme: ShepTheme): string {
  return theme.accent ?? THEME_ACCENTS[theme.id] ?? theme.termBlue;
}

/** Text color for a filled accent button: white unless the accent is too light. */
export function accentButtonText(accent: string): string {
  return 1.05 / (hexLuminance(accent) + 0.05) >= 3.2 ? "#ffffff" : "#000000";
}

/** Dark themes: the main panel steps this much darker than the theme color. */
const MAIN_PANEL_SHADE = 0.82;

function shadeHex(hex: string, factor: number): string {
  const channel = (offset: number) =>
    Math.round(parseInt(hex.slice(offset, offset + 2), 16) * factor).toString(16).padStart(2, "0");
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/**
 * Dark opaque themes keep their own color for the sidebar and put the main
 * panel (frame, terminals, chat) one step darker. Light and glass themes
 * are unchanged; their sidebar is tinted in CSS instead.
 */
export function withLayeredSurfaces(theme: ShepTheme): ShepTheme {
  if (theme.isTransparent || !/^#[0-9a-f]{6}$/i.test(theme.appBg) || hexLuminance(theme.appBg) > 0.3) {
    return theme;
  }
  const main = shadeHex(theme.appBg, MAIN_PANEL_SHADE);
  return { ...theme, sidebarBg: theme.appBg, appBg: main, frameTint: main };
}

export const DARK_THEMES: ShepTheme[] = THEME_LIST.filter((t) => !t.isTransparent && hexLuminance(t.appBg) <= 0.3);
export const LIGHT_THEMES: ShepTheme[] = THEME_LIST.filter((t) => !t.isTransparent && hexLuminance(t.appBg) > 0.3);
export const TRANSPARENT_THEMES: ShepTheme[] = THEME_LIST.filter((t) => t.isTransparent);

export const DEFAULT_THEME_ID = "catppuccin";

export function getThemeById(id: string): ShepTheme {
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID];
}
