/**
 * Instagram Publisher (Instagram API with Instagram Login)
 *
 * Posts a Reel in three steps: create a resumable container, upload the
 * file to rupload.facebook.com, wait for processing, then publish. The
 * long-lived token (60 days) is refreshed on each run and the new one is
 * reported so it can be stored back.
 *
 * The API has no AI-label field: the caption carries the notice and the
 * label burned into the video stays visible.
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

export interface InstagramCredentials {
  accessToken: string;
  /** Instagram professional account id; looked up with /me when absent. */
  userId?: string;
  apiVersion?: string;
}

export class InstagramPublisher implements Publisher {
  readonly platform = "instagram" as const;
  private token: string;
  private renewed?: string;

  constructor(
    private readonly creds: InstagramCredentials,
    private readonly http: HttpOptions = {},
  ) {
    this.token = creds.accessToken;
  }

  private get fetch(): typeof fetch {
    return this.http.fetchImpl ?? fetch;
  }

  private get version(): string {
    return this.creds.apiVersion || "v23.0";
  }

  renewedSecrets(): Record<string, string> {
    return this.renewed ? { INSTAGRAM_ACCESS_TOKEN: this.renewed } : {};
  }

  /** Extends the token by 60 days. Best effort: a fresh token (under 24 h) cannot be refreshed yet. */
  async refreshToken(): Promise<void> {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", this.token);
    try {
      const json = await readJson<{ access_token?: string }>(await this.fetch(url), "Instagram token refresh");
      if (json.access_token && json.access_token !== this.token) {
        this.token = json.access_token;
        this.renewed = json.access_token;
      }
    } catch {
      // Keep the current token; it stays valid until it expires.
    }
  }

  private graph(path: string, params: Record<string, string> = {}): URL {
    const url = new URL(`https://graph.instagram.com/${this.version}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  }

  private async post<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
    const resp = await this.fetch(this.graph(path), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    return readJson<T>(resp, what);
  }

  private async get<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
    const resp = await this.fetch(this.graph(path, params), { headers: { Authorization: `Bearer ${this.token}` } });
    return readJson<T>(resp, what);
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    await this.refreshToken();
    const userId =
      this.creds.userId || (await this.get<{ user_id: string }>("me", { fields: "user_id" }, "Instagram account")).user_id;

    const container = await this.post<{ id: string; uri?: string }>(
      `${userId}/media`,
      { media_type: "REELS", upload_type: "resumable", caption: req.description.slice(0, 2200), share_to_feed: "true" },
      "Instagram container",
    );

    const video = fs.readFileSync(req.videoPath);
    const uploadUrl = container.uri ?? `https://rupload.facebook.com/ig-api-upload/${this.version}/${container.id}`;
    const upload = await this.fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `OAuth ${this.token}`, offset: "0", file_size: String(video.length) },
      body: video,
    });
    await readJson(upload, "Instagram upload");

    const sleep = this.http.sleep ?? defaultSleep;
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      const status = await this.get<{ status_code?: string; status?: string }>(
        container.id,
        { fields: "status_code,status" },
        "Instagram processing status",
      );
      if (status.status_code === "FINISHED") ready = true;
      else if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
        throw new Error(`Instagram processing failed: ${status.status ?? status.status_code}`);
      } else await sleep(15_000);
    }
    if (!ready) throw new Error(`Instagram container ${container.id} still processing after 10 minutes`);

    const media = await this.post<{ id: string }>(`${userId}/media_publish`, { creation_id: container.id }, "Instagram publish");
    let url: string | undefined;
    try {
      url = (await this.get<{ permalink?: string }>(media.id, { fields: "permalink" }, "Instagram permalink")).permalink;
    } catch {
      // The post is live; the link is only a convenience.
    }
    return { platform: "instagram", status: "published", id: media.id, url };
  }
}
