import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDescription, publishersFromEnv, runDaily } from "../video/daily.js";
import { InstagramPublisher } from "../video/publish/instagram.js";
import { TikTokPublisher } from "../video/publish/tiktok.js";
import { YouTubePublisher } from "../video/publish/youtube.js";
import type { Publisher, PublishRequest } from "../video/publish/types.js";
import type { VideoManifest, VideoScript } from "../video/types.js";
import { checkScriptShape, extractJson, scriptPrompt, writeScript } from "../video/writer.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

/** Fake fetch answering from a list of [url fragment, response] pairs, in order of first match. */
function fakeFetch(routes: Array<[string | RegExp, (call: Call) => Response]>) {
  const calls: Call[] = [];
  const impl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: init.body,
    };
    calls.push(call);
    const route = routes.find(([match]) => (typeof match === "string" ? url.includes(match) : match.test(url)));
    if (!route) throw new Error(`Unexpected request ${call.method} ${url}`);
    return route[1](call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let tmp: string;
let req: PublishRequest;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
  const videoPath = path.join(tmp, "video.mp4");
  fs.writeFileSync(videoPath, Buffer.alloc(1000, 1));
  req = { videoPath, title: "Les abeilles dansent", description: "Légende\n\nContenu généré par IA", hashtags: ["abeilles"] };
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("YouTube publisher", () => {
  it("uploads as a Short declared as synthetic media", async () => {
    const { impl, calls } = fakeFetch([
      ["oauth2.googleapis.com/token", () => json({ access_token: "yt-token" })],
      ["uploadType=resumable", () => json({}, 200, { location: "https://upload.example/session1" })],
      ["upload.example/session1", () => json({ id: "abc123", status: { privacyStatus: "public" } })],
    ]);
    const result = await new YouTubePublisher({ clientId: "id", clientSecret: "s", refreshToken: "r" }, { fetchImpl: impl }).publish(req);
    expect(result).toEqual({ platform: "youtube", status: "published", id: "abc123", url: "https://www.youtube.com/shorts/abc123" });
    const meta = JSON.parse(calls[1].body);
    expect(meta.status.containsSyntheticMedia).toBe(true);
    expect(meta.status.privacyStatus).toBe("public");
    expect(meta.snippet.title).toBe("Les abeilles dansent #Shorts");
    expect(calls[1].headers.authorization).toBe("Bearer yt-token");
    expect(calls[2].method).toBe("PUT");
  });

  it("reports a private result when YouTube locks the upload", async () => {
    const { impl } = fakeFetch([
      ["oauth2", () => json({ access_token: "t" })],
      ["uploadType=resumable", () => json({}, 200, { location: "https://upload.example/s" })],
      ["upload.example/s", () => json({ id: "x", status: { privacyStatus: "private" } })],
    ]);
    const result = await new YouTubePublisher({ clientId: "i", clientSecret: "s", refreshToken: "r" }, { fetchImpl: impl }).publish(req);
    expect(result.status).toBe("private");
  });

  it("surfaces a refused refresh token", async () => {
    const { impl } = fakeFetch([["oauth2", () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400)]]);
    await expect(
      new YouTubePublisher({ clientId: "i", clientSecret: "s", refreshToken: "r" }, { fetchImpl: impl }).publish(req),
    ).rejects.toThrow(/invalid_grant: Token has been expired or revoked/);
  });
});

describe("TikTok publisher", () => {
  function routes(privacyOptions: string[], statuses: string[]) {
    let poll = 0;
    return fakeFetch([
      ["/oauth/token/", () => json({ access_token: "tt-token", refresh_token: "rotated" })],
      ["/creator_info/query/", () => json({ data: { privacy_level_options: privacyOptions }, error: { code: "ok" } })],
      ["/video/init/", () => json({ data: { publish_id: "pub1", upload_url: "https://upload.tiktok.example/u" }, error: { code: "ok" } })],
      ["upload.tiktok.example", () => new Response(null, { status: 201 })],
      ["/status/fetch/", () => json({ data: { status: statuses[Math.min(poll++, statuses.length - 1)], publicaly_available_post_id: [777] }, error: { code: "ok" } })],
    ]);
  }

  it("posts publicly, labelled as AI-generated, and reports the rotated refresh token", async () => {
    const { impl, calls } = routes(["PUBLIC_TO_EVERYONE", "SELF_ONLY"], ["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"]);
    const publisher = new TikTokPublisher({ clientKey: "k", clientSecret: "s", refreshToken: "r" }, { fetchImpl: impl, sleep: async () => {} });
    const result = await publisher.publish(req);
    expect(result).toEqual({ platform: "tiktok", status: "published", id: "777" });
    const init = JSON.parse(calls.find((c) => c.url.includes("/video/init/"))!.body);
    expect(init.post_info.is_aigc).toBe(true);
    expect(init.post_info.privacy_level).toBe("PUBLIC_TO_EVERYONE");
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 1000, chunk_size: 1000, total_chunk_count: 1 });
    expect(calls.find((c) => c.url.includes("upload.tiktok"))!.headers["content-range"]).toBe("bytes 0-999/1000");
    expect(publisher.renewedSecrets()).toEqual({ TIKTOK_REFRESH_TOKEN: "rotated" });
  });

  it("falls back to a private post while the app is not audited", async () => {
    const { impl } = routes(["SELF_ONLY"], ["PUBLISH_COMPLETE"]);
    const result = await new TikTokPublisher({ clientKey: "k", clientSecret: "s", refreshToken: "r" }, { fetchImpl: impl, sleep: async () => {} }).publish(req);
    expect(result.status).toBe("private");
  });

  it("fails when TikTok rejects the post", async () => {
    const { impl } = routes(["PUBLIC_TO_EVERYONE"], ["FAILED"]);
    await expect(
      new TikTokPublisher({ clientKey: "k", clientSecret: "s", refreshToken: "r" }, { fetchImpl: impl, sleep: async () => {} }).publish(req),
    ).rejects.toThrow(/TikTok post failed/);
  });
});

describe("Instagram publisher", () => {
  it("creates a resumable Reel, uploads, waits and publishes", async () => {
    let polls = 0;
    const { impl, calls } = fakeFetch([
      ["refresh_access_token", () => json({ access_token: "ig-new" })],
      [/\/v23\.0\/me\?/, () => json({ user_id: "1784" })],
      ["/1784/media_publish", () => json({ id: "media9" })],
      ["/1784/media", () => json({ id: "cont1" })],
      ["rupload.facebook.com", () => json({ success: true })],
      [/\/cont1\?/, () => json({ status_code: polls++ === 0 ? "IN_PROGRESS" : "FINISHED" })],
      [/\/media9\?/, () => json({ permalink: "https://www.instagram.com/reel/xyz/" })],
    ]);
    const publisher = new InstagramPublisher({ accessToken: "ig-old" }, { fetchImpl: impl, sleep: async () => {} });
    const result = await publisher.publish(req);
    expect(result).toEqual({ platform: "instagram", status: "published", id: "media9", url: "https://www.instagram.com/reel/xyz/" });
    const container = new URLSearchParams(calls.find((c) => c.url.endsWith("/1784/media"))!.body);
    expect(container.get("media_type")).toBe("REELS");
    expect(container.get("upload_type")).toBe("resumable");
    expect(container.get("caption")).toContain("Contenu généré par IA");
    const upload = calls.find((c) => c.url.includes("rupload"))!;
    expect(upload.url).toBe("https://rupload.facebook.com/ig-api-upload/v23.0/cont1");
    expect(upload.headers.authorization).toBe("OAuth ig-new");
    expect(upload.headers.file_size).toBe("1000");
    expect(publisher.renewedSecrets()).toEqual({ INSTAGRAM_ACCESS_TOKEN: "ig-new" });
  });

  it("stops on a processing error", async () => {
    const { impl } = fakeFetch([
      ["refresh_access_token", () => json({ error: { message: "too young" } }, 400)],
      ["/42/media", () => json({ id: "c" })],
      ["rupload", () => json({ success: true })],
      [/\/c\?/, () => json({ status_code: "ERROR", status: "Error: unsupported codec" })],
    ]);
    const publisher = new InstagramPublisher({ accessToken: "t", userId: "42" }, { fetchImpl: impl, sleep: async () => {} });
    await expect(publisher.publish(req)).rejects.toThrow(/unsupported codec/);
    expect(publisher.renewedSecrets()).toEqual({});
  });
});

describe("script writer", () => {
  const scene = (n: number) => ({ narration: "x".repeat(160), onScreen: `SCÈNE ${n}`, visual: "a bee" });

  it("asks for a new subject and lists earlier titles", () => {
    const prompt = scriptPrompt({ apiKey: "", pastTitles: ["Les abeilles dansent"], rejectedTitles: ["Le miel"] });
    expect(prompt).toContain("- Les abeilles dansent");
    expect(prompt).toContain("- Le miel");
    expect(prompt).toContain("JSON");
  });

  it("extracts JSON from a fenced answer", () => {
    expect(extractJson('```json\n{"title":"A"}\n```')).toEqual({ title: "A" });
    expect(() => extractJson("pas de json")).toThrow(/no JSON/);
  });

  it("refuses scripts that would be under a minute", () => {
    expect(() => checkScriptShape({ title: "A", niche: "n", scenes: [scene(1)] })).toThrow(/too short/);
    expect(() => checkScriptShape({ title: "A", niche: "n", scenes: [1, 2, 3, 4, 5, 6, 7].map(scene) })).not.toThrow();
  });

  it("calls Gemini and returns a validated script", async () => {
    const answer = { title: "Le viaduc", scenes: [1, 2, 3, 4, 5, 6, 7].map(scene), caption: "Wow", hashtags: ["pont"] };
    const { impl, calls } = fakeFetch([
      ["interactions", () => json({ steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(answer) }] }] })],
    ]);
    const script = await writeScript({ apiKey: "k", fetchImpl: impl, niche: "patrimoine" });
    expect(script.title).toBe("Le viaduc");
    expect(script.niche).toBe("patrimoine");
    expect(script.language).toBe("fr");
    expect(JSON.parse(calls[0].body).model).toBe("gemini-3.8-flash");
  });
});

describe("daily run", () => {
  let dir: string;
  const now = new Date("2026-10-21T16:17:00Z");

  beforeEach(() => {
    dir = path.join(tmp, "videos");
    fs.mkdirSync(dir);
  });

  function fakeCreate(durationSec = 80) {
    let n = 0;
    return (async (input: unknown) => {
      const s = input as VideoScript;
      const id = `vid${++n}`;
      fs.mkdirSync(path.join(dir, id), { recursive: true });
      fs.writeFileSync(path.join(dir, id, "script.json"), JSON.stringify(s));
      fs.writeFileSync(path.join(dir, id, "video.mp4"), "mp4");
      const manifest: VideoManifest = {
        id,
        title: s.title,
        niche: s.niche,
        status: "pending_review",
        createdAt: now.toISOString(),
        durationSec,
        costCents: 29,
        visuals: "fake",
        aiLabel: "Contenu généré par IA",
        voice: "fake",
        checks: [{ name: "duration", passed: durationSec >= 61, detail: `${durationSec} s` }],
        caption: s.caption,
        hashtags: s.hashtags,
      };
      fs.writeFileSync(path.join(dir, id, "manifest.json"), JSON.stringify(manifest));
      return manifest;
    }) as any;
  }

  const writer = async () => ({ title: "Le viaduc", niche: "n", scenes: [{ narration: "x" }], caption: "Wow", hashtags: ["pont"] });

  function fakePublisher(platform: Publisher["platform"], fail = false): Publisher & { seen: PublishRequest[] } {
    const seen: PublishRequest[] = [];
    return {
      platform,
      seen,
      publish: async (r) => {
        seen.push(r);
        if (fail) throw new Error("boom");
        return { platform, status: "published", id: `${platform}-1`, url: `https://${platform}.example/1` };
      },
    };
  }

  it("makes a video but posts nothing without AUTOMATON_PUBLISH", async () => {
    const yt = fakePublisher("youtube");
    const report = await runDaily({ env: {}, now, dir, writer, create: fakeCreate(), publishers: [yt] });
    expect(report.created).toBe(true);
    expect(report.publishing).toBe(false);
    expect(yt.seen).toHaveLength(0);
    expect(report.failures).toEqual([]);
  });

  it("publishes everywhere with the AI notice, then only retries failures the same day", async () => {
    const yt = fakePublisher("youtube");
    const tt = fakePublisher("tiktok", true);
    const env = { AUTOMATON_PUBLISH: "true" };
    const create = fakeCreate();
    const first = await runDaily({ env, now, dir, writer, create, publishers: [yt, tt] });
    expect(first.video!.status).toBe("approved");
    expect(first.video!.publications!.youtube!.status).toBe("published");
    expect(first.video!.publications!.tiktok!.status).toBe("failed");
    expect(first.failures).toEqual(["tiktok: boom"]);
    expect(yt.seen[0].description).toContain("Contenu généré par IA");
    expect(yt.seen[0].videoPath).toBe(path.join(dir, "vid1", "video.mp4"));

    const tt2 = fakePublisher("tiktok");
    const second = await runDaily({ env, now, dir, writer, create, publishers: [yt, tt2] });
    expect(second.created).toBe(false);
    expect(yt.seen).toHaveLength(1);
    expect(tt2.seen).toHaveLength(1);
    expect(second.failures).toEqual([]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "vid1", "manifest.json"), "utf-8"));
    expect(saved.publications.tiktok.status).toBe("published");
  });

  it("renders today's script again when the video file is gone (fresh CI checkout)", async () => {
    const yt = fakePublisher("youtube");
    const tt = fakePublisher("tiktok", true);
    const env = { AUTOMATON_PUBLISH: "true" };
    const create = fakeCreate();
    let written = 0;
    const countingWriter = async () => {
      written++;
      return writer();
    };
    await runDaily({ env, now, dir, writer: countingWriter, create, publishers: [yt, tt] });
    fs.rmSync(path.join(dir, "vid1", "video.mp4"));

    const tt2 = fakePublisher("tiktok");
    const report = await runDaily({ env, now, dir, writer: countingWriter, create, publishers: [yt, tt2] });
    expect(written).toBe(1);
    expect(report.video!.id).toBe("vid2");
    expect(report.video!.title).toBe("Le viaduc");
    expect(yt.seen).toHaveLength(1);
    expect(tt2.seen[0].videoPath).toBe(path.join(dir, "vid2", "video.mp4"));
    expect(report.video!.publications!.youtube!.status).toBe("published");
    const old = JSON.parse(fs.readFileSync(path.join(dir, "vid1", "manifest.json"), "utf-8"));
    expect(old.renderFailed).toBe(true);
    expect(old.costCents).toBe(29);
  });

  it("does not post a video that fails its checks", async () => {
    const yt = fakePublisher("youtube");
    const report = await runDaily({ env: { AUTOMATON_PUBLISH: "true" }, now, dir, writer, create: fakeCreate(40), publishers: [yt] });
    expect(yt.seen).toHaveLength(0);
    expect(report.video!.status).toBe("rejected");
    expect(report.failures[0]).toMatch(/duration/);
  });

  it("writes a new script when the first is too close to an earlier video", async () => {
    const titles: string[][] = [];
    let call = 0;
    const create = fakeCreate();
    const picky = (async (s: VideoScript, o: any) => {
      if (call++ === 0) throw new Error('Too close to "Les abeilles" (80% identical).');
      return create(s, o);
    }) as any;
    const report = await runDaily({
      env: {},
      now,
      dir,
      writer: async (o) => {
        titles.push(o.rejectedTitles ?? []);
        return writer();
      },
      create: picky,
      publishers: [],
    });
    expect(report.created).toBe(true);
    expect(titles[1]).toEqual(["Le viaduc"]);
  });

  it("enables only the platforms whose credentials are set", () => {
    expect(publishersFromEnv({}).map((p) => p.platform)).toEqual([]);
    expect(
      publishersFromEnv({ YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b", YOUTUBE_REFRESH_TOKEN: "c", INSTAGRAM_ACCESS_TOKEN: "d" }).map(
        (p) => p.platform,
      ),
    ).toEqual(["youtube", "instagram"]);
  });

  it("builds a caption with the AI notice and hashtags", () => {
    expect(buildDescription({ title: "T", caption: "Le saviez-vous ?", hashtags: ["pont", "#France", "génie civil"] })).toBe(
      "Le saviez-vous ?\n\nContenu généré par IA : voix et images créées par intelligence artificielle.\n\n#pont #France #géniecivil #IA",
    );
  });
});
