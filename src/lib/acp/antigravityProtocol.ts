/** Keep OAuth URLs out of transcript/history and accept only Google's auth endpoint. */
export function antigravitySignInUrl(line: string): string | null {
  const prefix = "Open the following link to authenticate the ACP server: ";
  if (!line.startsWith(prefix) || line.length > 12_000) return null;
  try {
    const url = new URL(line.slice(prefix.length).trim());
    if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" ||
      url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password || url.port || url.hash) return null;
    return url.href;
  } catch { return null; }
}
