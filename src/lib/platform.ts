/**
 * Platform detection for the webview, evaluated once at module load.
 * WebView2 user agents contain "Windows"; WKWebView contains "Macintosh".
 */
export const isWindows = navigator.userAgent.includes("Windows");
export const isMac = !isWindows && navigator.userAgent.includes("Mac");

/** Display label for the primary modifier key. */
export const modKeyLabel = isMac ? "Cmd" : "Ctrl";

/** Platform-appropriate name for the system file manager. */
export const fileManagerName = isWindows ? "File Explorer" : "Finder";
