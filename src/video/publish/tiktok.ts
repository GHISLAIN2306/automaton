/**
 * TikTok Publisher (Content Posting API, Direct Post)
 *
 * Refreshes the access token, reads the creator's allowed privacy levels
 * (required by TikTok before each post), uploads the file and waits for
 * TikTok to finish processing. Every post sets is_aigc, which shows
 * TikTok's "AI-generated" label.
 *
 * Until the app passes TikTok's audit, only SELF_ONLY (private) posts are
 * allowed: we then post privately instead of failing.
 */

import fs from "fs";
import {
  defaultSleep,
  readJson,
  type HttpOptions,
  type PublishRequest,
  type PublishResult,
  type Publisher,
} from "./types.js";

export interface TikTokCredentials {
  clientKey: string;
  clientSecret: string;
  refreshToken: string;
  /** Wanted privacy level (default PUBLIC_TO_EVERYONE). */
  privacy?: string;
}

const API = "https://open.tiktokapis.com/v2";
/** TikTok accepts a single chunk up to 64 MB; bigger files go in chunks of 5 to 64 MB. */
const MAX_SINGLE_CHUNK = 64 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;
/** The last chunk takes the remainder and may reach 128 MB; TikTok allows up to 1000 chunks. */
const MAX_VIDEO = 1000 * CHUNK;

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

export class TikTokPublisher implements Publisher {
  readonly platform = "tiktok" as const;
  private newRefreshToken?: string;

  constructor(
    private readonly creds: TikTokCredentials,
    private readonly http: HttpOptions = {},
  ) {}

  private get fetch(): typeof fetch {
    return this.http.fetchImpl ?? fetch;
  }

  renewedSecrets(): Record<string, string> {
    return this.newRefreshToken && this.newRefreshToken !== this.creds.refreshToken
      ? { TIKTOK_REFRESH_TOKEN: this.newRefreshToken }
      : {};
  }

  async accessToken(): Promise<string> {
    const resp = await this.fetch(`${API}/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: this.creds.clientKey,
        client_secret: this.creds.clientSecret,
        grant_type: "refresh_token",
        refresh_token: this.creds.refreshToken,
      }).toString(),
    });
    const json = await readJson<{ access_token?: string; refresh_token?: string; error_description?: string }>(
      resp,
      "TikTok token refresh",
    );
    if (!json.access_token) throw new Error(`TikTok token refresh: ${json.error_description ?? "no access token"}`);
    this.newRefreshToken = json.refresh_token;
    return json.access_token;
  }

  private async call<T>(token: string, path: string, body: unknown, what: string): Promise<T> {
    const resp = await this.fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    });
    const json = await readJson<TikTokEnvelope<T>>(resp, what);
    if (json.error?.code && json.error.code !== "ok") {
      throw new Error(`${what}: ${json.error.code}: ${json.error.message ?? ""}`);
    }
    return json.data as T;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const token = await this.accessToken();
    const creator = await this.call<{ privacy_level_options?: string[]; max_video_post_duration_sec?: number }>(
      token,
      "/post/publish/creator_info/query/",
      {},
      "TikTok creator info",
    );
    const options = creator.privacy_level_options ?? [];
    const wanted = this.creds.privacy || "PUBLIC_TO_EVERYONE";
    const privacy = options.includes(wanted) ? wanted : options.includes("SELF_ONLY") ? "SELF_ONLY" : undefined;
    if (!privacy) throw new Error(`TikTok refuses privacy ${wanted} (allowed: ${options.join(", ") || "none"})`);

    const size = fs.statSync(req.videoPath).size;
    if (size > MAX_VIDEO) throw new Error(`Video is ${Math.round(size / 1e6)} MB, too big for TikTok`);
    const chunkSize = size > MAX_SINGLE_CHUNK ? CHUNK : size;
    const chunks = Math.max(1, Math.floor(size / chunkSize));

    const start = (privacy_level: string) => this.call<{ publish_id: string; upload_url: string }>(
      token,
      "/post/publish/video/init/",
      {
        post_info: {
          title: req.description.slice(0, 2200),
          privacy_level,
          disable_comment: false,
          disable_duet: false,
          disable_stitch: false,
          is_aigc: true,
          brand_content_toggle: false,
          brand_organic_toggle: false,
        },
        source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: chunks },
      },
      "TikTok post start",
    );
    // An app not yet audited may list PUBLIC_TO_EVERYONE but gets a 403 for it:
    // post privately instead.
    let posted = privacy;
    const init = await start(privacy).catch((err: Error) => {
      if (privacy === "SELF_ONLY" || !options.includes("SELF_ONLY") || !/HTTP 403/.test(err.message)) throw err;
      posted = "SELF_ONLY";
      return start(posted);
    });

    const file = fs.readFileSync(req.videoPath);
    for (let i = 0; i < chunks; i++) {
      const from = i * chunkSize;
      const to = i === chunks - 1 ? size - 1 : from + chunkSize - 1;
      const upload = await this.fetch(init.upload_url, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(to - from + 1),
          "Content-Range": `bytes ${from}-${to}/${size}`,
        },
        body: file.subarray(from, to + 1),
      });
      if (!upload.ok) throw new Error(`TikTok upload (part ${i + 1}/${chunks}): HTTP ${upload.status}: ${(await upload.text()).slice(0, 300)}`);
    }

    const sleep = this.http.sleep ?? defaultSleep;
    for (let attempt = 0; attempt < 40; attempt++) {
      const status = await this.call<{ status: string; fail_reason?: string; publicaly_available_post_id?: Array<string | number> }>(
        token,
        "/post/publish/status/fetch/",
        { publish_id: init.publish_id },
        "TikTok post status",
      );
      if (status.status === "PUBLISH_COMPLETE") {
        const postId = status.publicaly_available_post_id?.[0];
        return {
          platform: "tiktok",
          status: posted === "SELF_ONLY" ? "private" : "published",
          id: postId ? String(postId) : init.publish_id,
        };
      }
      if (status.status === "FAILED") throw new Error(`TikTok post failed: ${status.fail_reason ?? "unknown reason"}`);
      await sleep(15_000);
    }
    throw new Error(`TikTok post ${init.publish_id} still processing after 10 minutes`);
  }
}
