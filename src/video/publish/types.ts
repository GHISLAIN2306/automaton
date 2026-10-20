/**
 * Publishing Types
 *
 * Each platform posts through its official API with the owner's own
 * credentials. Every post declares the video as AI-generated where the
 * platform has a field for it, and the caption repeats the label.
 */

import type { Platform } from "../types.js";

export interface PublishRequest {
  videoPath: string;
  title: string;
  /** Full post text: caption, AI notice and hashtags. */
  description: string;
  hashtags: string[];
}

export interface PublishResult {
  platform: Platform;
  /** "private" when the platform forced a private post (app not yet audited). */
  status: "published" | "private";
  id: string;
  url?: string;
}

export interface Publisher {
  readonly platform: Platform;
  publish(req: PublishRequest): Promise<PublishResult>;
  /** Credentials renewed during the run, to store back as secrets. */
  renewedSecrets?(): Record<string, string>;
}

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  /** Waits between status checks; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parses a JSON response and throws a readable error on HTTP failure. */
export async function readJson<T = any>(resp: Response, what: string): Promise<T> {
  const text = await resp.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${what}: HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  if (!resp.ok) {
    // OAuth endpoints answer {error: "invalid_grant", error_description: "..."}; APIs answer {error: {message}}.
    const code = typeof json?.error === "string" ? `${json.error}: ` : "";
    const message = json?.error?.message ?? (json?.error_description ? code + json.error_description : undefined) ?? json?.error?.code ?? text.slice(0, 300);
    throw new Error(`${what}: HTTP ${resp.status}: ${typeof message === "string" ? message : JSON.stringify(message)}`);
  }
  return json as T;
}
