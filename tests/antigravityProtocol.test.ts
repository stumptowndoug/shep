import test from "node:test";
import assert from "node:assert/strict";
import { antigravitySignInUrl } from "../src/lib/acp/antigravityProtocol.ts";

const prefix = "Open the following link to authenticate the ACP server: ";
test("Antigravity sign-in preserves Google's OAuth URL and ignores ordinary logs", () => {
  const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=example&state=opaque&redirect_uri=http%3A%2F%2Flocalhost%3A1234";
  assert.equal(antigravitySignInUrl(prefix + url), url);
  assert.equal(antigravitySignInUrl("Starting AGY ACP Server..."), null);
  assert.equal(antigravitySignInUrl("Unrelated log " + url), null);
});
test("Antigravity sign-in refuses unrelated or malformed links", () => {
  for (const url of ["https://accounts.google.com.evil.test/o/oauth2/v2/auth", "http://accounts.google.com/o/oauth2/v2/auth", "https://evil.test/?next=https://accounts.google.com", "https://user@accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com/redirect", "https://accounts.google.com:1234/o/oauth2/v2/auth", "javascript:alert(1)", "https://accounts.google.com/o/oauth2/v2/auth#fragment", "https://accounts.google.com/o/oauth2/v2/auth?state=" + "x".repeat(12000)]) {
    assert.equal(antigravitySignInUrl(prefix + url), null, url.slice(0, 100));
  }
});
