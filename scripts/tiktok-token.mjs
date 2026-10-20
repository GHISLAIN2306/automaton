#!/usr/bin/env node
/**
 * Exchanges a TikTok authorization code for a refresh token.
 *
 *   TIKTOK_CODE=<code or full redirect URL> node scripts/tiktok-token.mjs <out-file>
 *
 * Needs TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_REDIRECT_URI (the
 * redirect URI registered in Login Kit). Writes {"TIKTOK_REFRESH_TOKEN": ...}
 * to <out-file> and never prints the token.
 */

import fs from "fs";

const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI, TIKTOK_CODE } = process.env;
const out = process.argv[2];
if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) throw new Error("TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET secrets are required");
if (!TIKTOK_CODE?.trim()) throw new Error("Paste the code (or the whole address of the page TikTok sent you to)");
if (!out) throw new Error("Usage: node scripts/tiktok-token.mjs <out-file>");

/** Accepts the bare code or the full redirect URL containing ?code=... */
function extractCode(input) {
  const text = input.trim();
  if (/^https?:\/\//.test(text)) {
    const code = new URL(text).searchParams.get("code");
    if (!code) throw new Error("This address has no code= parameter");
    return code;
  }
  return decodeURIComponent(text);
}

const resp = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    client_secret: TIKTOK_CLIENT_SECRET,
    code: extractCode(TIKTOK_CODE),
    grant_type: "authorization_code",
    redirect_uri: TIKTOK_REDIRECT_URI || "https://ghislain2306.github.io/automaton/",
  }).toString(),
});
const json = await resp.json().catch(() => ({}));
if (!resp.ok || !json.refresh_token) {
  throw new Error(`TikTok refused the code: ${json.error_description || json.error || `HTTP ${resp.status}`}. Codes expire after a few minutes: ask for a new one.`);
}
fs.writeFileSync(out, JSON.stringify({ TIKTOK_REFRESH_TOKEN: json.refresh_token }), { mode: 0o600 });
console.log(`Connected TikTok account ${json.open_id ?? ""}; scopes: ${json.scope ?? "?"}`);
