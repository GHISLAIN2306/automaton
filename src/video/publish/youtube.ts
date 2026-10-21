/**
 * YouTube Publisher (YouTube Data API v3)
 *
 * Refreshes an OAuth access token, then uploads the video with a resumable
 * upload. A vertical video under 3 minutes is shown as a Short. The upload
 * sets status.containsSyntheticMedia so YouTube shows its "altered or
 * synthetic content" label.
 *
 * Projects that have not passed the YouTube API audit can only upload
 * private videos: YouTube locks them as private whatever we ask.
 */

import fs from "fs";
import { readJson, type HttpOptions, type PublishRequest, type PublishResult, type Publisher } from "./types.js";

export interface YouTubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** "public" (default), "unlisted" or "private". */
  privacy?: string;
  /** YouTube category: "27" Education (default), "24" Entertainment. */
  categoryId?: string;
}

export class YouTubePublisher implements Publisher {
  readonly platform = "youtube" as const;

  constructor(
    private readonly creds: YouTubeCredentials,
    private readonly http: HttpOptions = {},
  ) {}

  private get fetch(): typeof fetch {
    return this.http.fetchImpl ?? fetch;
  }

  async accessToken(): Promise<string> {
    const resp = await this.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    const json = await readJson<{ access_token: string }>(resp, "YouTube token refresh");
    return json.access_token;
  }

  async publish(req: PublishRequest): Promise<PublishResult> {
    const token = await this.accessToken();
    const video = fs.readFileSync(req.videoPath);
    const privacy = this.creds.privacy || "public";
    const title = `${req.title} #Shorts`.slice(0, 100);

    const init = await this.fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": String(video.length),
        },
        body: JSON.stringify({
          snippet: {
            title,
            description: req.description.slice(0, 5000),
            tags: req.hashtags,
            categoryId: this.creds.categoryId || "27",
            defaultLanguage: "fr",
            defaultAudioLanguage: "fr",
          },
          status: {
            privacyStatus: privacy,
            selfDeclaredMadeForKids: false,
            containsSyntheticMedia: true,
          },
        }),
      },
    );
    if (!init.ok) await readJson(init, "YouTube upload start");
    const location = init.headers.get("location");
    if (!location) throw new Error("YouTube upload start: no upload URL returned");

    const upload = await this.fetch(location, {
      method: "PUT",
      headers: { "Content-Type": "video/mp4", "Content-Length": String(video.length) },
      body: video,
    });
    const json = await readJson<{ id: string; status?: { privacyStatus?: string } }>(upload, "YouTube upload");
    const finalPrivacy = json.status?.privacyStatus ?? privacy;
    return {
      platform: "youtube",
      status: finalPrivacy === "public" ? "published" : "private",
      id: json.id,
      url: `https://www.youtube.com/shorts/${json.id}`,
    };
  }
}
