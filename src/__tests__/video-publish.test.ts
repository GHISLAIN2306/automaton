import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDescription, publishersFromEnv, runDaily } from "../video/daily.js";
import { loadSeries, renderSeriesPage } from "../video/series.js";
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

  it("posts privately when TikTok refuses a public post from an app not yet audited", async () => {
    const { impl, calls } = routes(["PUBLIC_TO_EVERYONE", "SELF_ONLY"], ["PUBLISH_COMPLETE"]);
    let inits = 0;
    const refusing: typeof fetch = (async (url: any, init?: any) => {
      if (String(url).includes("/video/init/") && inits++ === 0) {
        return json({ error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "Please review our integration guidelines" } }, 403);
      }
      return impl(url, init);
    }) as any;
    const result = await new TikTokPublisher({ clientKey: "k", clientSecret: "s", refreshToken: "r" }, { fetchImpl: refusing, sleep: async () => {} }).publish(req);
    expect(result.status).toBe("private");
    expect(JSON.parse(calls.find((c) => c.url.includes("/video/init/"))!.body).post_info.privacy_level).toBe("SELF_ONLY");
  });

  it("uploads a video over 64 MB in chunks, the last one taking the remainder", async () => {
    const big = path.join(os.tmpdir(), `tiktok-big-${process.pid}.mp4`);
    const size = 75 * 1024 * 1024 + 123;
    fs.writeFileSync(big, Buffer.alloc(size));
    try {
      const { impl, calls } = routes(["SELF_ONLY"], ["PUBLISH_COMPLETE"]);
      await new TikTokPublisher({ clientKey: "k", clientSecret: "s", refreshToken: "r" }, { fetchImpl: impl, sleep: async () => {} }).publish({ ...req, videoPath: big });
      const init = JSON.parse(calls.find((c) => c.url.includes("/video/init/"))!.body);
      expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: size, chunk_size: 10 * 1024 * 1024, total_chunk_count: 7 });
      const ranges = calls.filter((c) => c.url.includes("upload.tiktok")).map((c) => c.headers["content-range"]);
      expect(ranges).toHaveLength(7);
      expect(ranges[0]).toBe(`bytes 0-${10 * 1024 * 1024 - 1}/${size}`);
      expect(ranges[6]).toBe(`bytes ${60 * 1024 * 1024}-${size - 1}/${size}`);
    } finally {
      fs.rmSync(big, { force: true });
    }
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

  it("writes invented dramas by default and true stories in vulgarisation format", () => {
    const drama = scriptPrompt({ apiKey: "" });
    expect(drama).toContain("Histoire entièrement inventée");
    expect(drama).toContain("même apparence");
    const facts = scriptPrompt({ apiKey: "", format: "vulgarisation" });
    expect(facts).toContain("faits vérifiables");
    expect(facts).not.toContain("inventée");
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
    expect(script.fiction).toBe(true);
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

  it("does not post an earlier video to a platform connected later", async () => {
    const yt = fakePublisher("youtube");
    const env = { AUTOMATON_PUBLISH: "true", AUTOMATON_VIDEOS_PER_DAY: "1" };
    const create = fakeCreate();
    await runDaily({ env, now, dir, writer, create, publishers: [yt] });
    const tt = fakePublisher("tiktok");
    const second = await runDaily({ env, now, dir, writer, create, publishers: [yt, tt] });
    expect(second.created).toBe(false);
    expect(tt.seen).toHaveLength(0);
  });

  it("waits for the next slot when the last video is too recent", async () => {
    const yt = fakePublisher("youtube");
    const env = { AUTOMATON_PUBLISH: "true", AUTOMATON_VIDEOS_PER_DAY: "3", AUTOMATON_MIN_GAP_MINUTES: "90" };
    const create = fakeCreate();
    const first = await runDaily({ env, now, dir, writer, create, publishers: [yt] });
    const soon = new Date(Date.parse(first.video!.createdAt) + 30 * 60_000);
    const second = await runDaily({ env, now: soon, dir, writer, create, publishers: [yt] });
    expect(second.created).toBe(false);
    expect(yt.seen).toHaveLength(1);
    const later = new Date(Date.parse(first.video!.createdAt) + 120 * 60_000);
    if (later.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
      const third = await runDaily({ env, now: later, dir, writer, create, publishers: [yt] });
      expect(third.created).toBe(true);
    }
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

  it("makes a second video the same day when AUTOMATON_VIDEOS_PER_DAY is 2, then stops", async () => {
    const yt = fakePublisher("youtube");
    const env = { AUTOMATON_PUBLISH: "true", AUTOMATON_VIDEOS_PER_DAY: "2" };
    const create = fakeCreate();
    let n = 0;
    const numbered = async () => ({ ...(await writer()), title: `Sujet ${++n}` });
    const first = await runDaily({ env, now, dir, writer: numbered, create, publishers: [yt] });
    const second = await runDaily({ env, now, dir, writer: numbered, create, publishers: [yt] });
    const third = await runDaily({ env, now, dir, writer: numbered, create, publishers: [yt] });
    expect(first.video!.id).toBe("vid1");
    expect(second.created).toBe(true);
    expect(second.video!.id).toBe("vid2");
    expect(third.created).toBe(false);
    expect(yt.seen.map((r) => r.title)).toEqual(["Sujet 1", "Sujet 2"]);
    expect(n).toBe(2);
  });

  it("posts partner clips first, then one AI video, without the AI notice on clips", async () => {
    const clipsDir = path.join(tmp, "clips");
    const inbox = path.join(clipsDir, "a-publier");
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, "a-milliardaire.mp4"), "clip-a");
    fs.writeFileSync(path.join(inbox, "a-milliardaire.json"), JSON.stringify({ series: "Le milliardaire caché", hook: "Elle ne savait pas que son mari était milliardaire…" }));
    fs.writeFileSync(path.join(inbox, "b-mariage.mp4"), "clip-b");
    const framed: string[] = [];
    const frame = async (source: string, hook: string, out: string) => {
      framed.push(`${fs.readFileSync(source, "utf-8")}|${hook}`);
      fs.writeFileSync(out, "mp4");
      return 58;
    };
    const yt = fakePublisher("youtube");
    const env = { AUTOMATON_PUBLISH: "true", AUTOMATON_VIDEOS_PER_DAY: "3" };
    const create = fakeCreate();
    const run = () => runDaily({ env, now, dir, writer, create, publishers: [yt], clipsDir, frame });

    const first = await run();
    expect(first.video!.source).toBe("clip");
    expect(framed[0]).toBe("clip-a|Elle ne savait pas que son mari était milliardaire…");
    expect(yt.seen[0].title).toBe("Elle ne savait pas que son mari était milliardaire…");
    expect(yt.seen[0].description).toContain("Lien en bio");
    expect(yt.seen[0].description).not.toContain("IA");
    // Posted everywhere: the source clip is gone.
    expect(fs.readdirSync(path.join(clipsDir, "en-cours"))).toEqual([]);

    const second = await run();
    expect(second.video!.source).toBe("clip");
    expect(framed[1]).toBe("clip-b|Regarde bien sa réaction à la fin");
    const third = await run();
    expect(third.video!.source).toBeUndefined();
    expect(yt.seen[2].description).toContain("Contenu généré par IA");
    const fourth = await run();
    expect(fourth.created).toBe(false);
    expect(yt.seen).toHaveLength(3);
  });

  it("numbers each series on the bio link page and names the number in the caption", async () => {
    const clipsDir = path.join(tmp, "clips");
    const inbox = path.join(clipsDir, "a-publier");
    fs.mkdirSync(inbox, { recursive: true });
    for (const [name, url] of [["a", "https://d.example/1"], ["b", "https://d.example/2"], ["c", "https://d.example/1"]]) {
      fs.writeFileSync(path.join(inbox, `${name}.mp4`), name);
      fs.writeFileSync(path.join(inbox, `${name}.json`), JSON.stringify({ series: `Série ${url.slice(-1)}`, dramaUrl: url }));
    }
    const frame = async (_s: string, _h: string, out: string) => (fs.writeFileSync(out, "mp4"), 30);
    const yt = fakePublisher("youtube");
    const env = { AUTOMATON_PUBLISH: "true", AUTOMATON_VIDEOS_PER_DAY: "3", AUTOMATON_CLIPS_PER_DAY: "3" };
    for (let i = 0; i < 3; i++) await runDaily({ env, now, dir, writer, create: fakeCreate(), publishers: [yt], clipsDir, frame });
    expect(yt.seen.map((r) => r.description.split("\n")[0])).toEqual([
      "Tu veux savoir la suite ? 👀 Lien en bio, série n° 1 🎬",
      "Tu veux savoir la suite ? 👀 Lien en bio, série n° 2 🎬",
      "Tu veux savoir la suite ? 👀 Lien en bio, série n° 1 🎬",
    ]);
    const page = renderSeriesPage(loadSeries(clipsDir));
    expect(page.indexOf("n° 2")).toBeLessThan(page.indexOf("n° 1"));
    expect(page).toContain('href="https://d.example/2"');
  });

  it("posts the next episodes of the listed DramaCPS series, alternating series", async () => {
    const clipsDir = path.join(tmp, "clips");
    fs.mkdirSync(clipsDir, { recursive: true });
    fs.writeFileSync(
      path.join(clipsDir, "series-a-publier.json"),
      JSON.stringify([
        { dramaId: "653763", title: "La Petite Louve", dramaUrl: "https://r.example/louve", pack: "https://p.example/louve.zip", hook: "Elle était la louve ratée de la meute…", episodes: 2 },
        { dramaId: "658667", title: "La Femme que Tu As Jetée", dramaUrl: "https://r.example/femme", pack: "https://p.example/femme.zip" },
      ]),
    );
    const downloads: string[] = [];
    const download = async (series: { dramaId: string }, episode: number, out: string) => {
      downloads.push(`${series.dramaId}#${episode}`);
      fs.writeFileSync(out, "episode");
    };
    const frame = async (_s: string, _h: string, out: string) => (fs.writeFileSync(out, "mp4"), 90);
    const yt = fakePublisher("youtube");
    const env = { AUTOMATON_PUBLISH: "true", AUTOMATON_VIDEOS_PER_DAY: "6", AUTOMATON_CLIPS_PER_DAY: "5" };
    for (let i = 0; i < 4; i++) await runDaily({ env, now, dir, writer, create: fakeCreate(), publishers: [yt], clipsDir, frame, download });
    expect(downloads).toEqual(["653763#1", "658667#1", "653763#2", "658667#2"]);
    expect(yt.seen[0].title).toBe("Elle était la louve ratée de la meute… | Épisode 1");
    expect(yt.seen[1].description).toContain("série n° 2");
    // Pack episodes are not kept in the repository.
    expect(fs.existsSync(path.join(clipsDir, "en-cours"))).toBe(false);

    // A fresh checkout downloads the episode again to retry a failed platform.
    const fifth = await runDaily({ env, now, dir, writer, create: fakeCreate(), publishers: [fakePublisher("youtube", true)], clipsDir, frame, download });
    expect(downloads.at(-1)).toBe("658667#3");
    fs.rmSync(path.join(dir, fifth.video!.id, "video.mp4"));
    const retry = await runDaily({ env, now, dir, writer, create: fakeCreate(), publishers: [yt], clipsDir, frame, download });
    expect(retry.video!.id).toBe(fifth.video!.id);
    expect(downloads.at(-1)).toBe("658667#3");
    expect(downloads).toHaveLength(6);
  });

  it("frames a clip again on a fresh checkout and keeps it until posted everywhere", async () => {
    const clipsDir = path.join(tmp, "clips");
    fs.mkdirSync(path.join(clipsDir, "a-publier"), { recursive: true });
    fs.writeFileSync(path.join(clipsDir, "a-publier", "x.mp4"), "clip-x");
    let frames = 0;
    const frame = async (_s: string, _h: string, out: string) => {
      frames++;
      fs.writeFileSync(out, "mp4");
      return 40;
    };
    const env = { AUTOMATON_PUBLISH: "true", AUTOMATON_VIDEOS_PER_DAY: "3" };
    const first = await runDaily({ env, now, dir, writer, create: fakeCreate(), publishers: [fakePublisher("youtube"), fakePublisher("tiktok", true)], clipsDir, frame });
    const id = first.video!.id;
    expect(fs.existsSync(path.join(clipsDir, "en-cours", `${id}.mp4`))).toBe(true);
    fs.rmSync(path.join(dir, id, "video.mp4"));

    const tt = fakePublisher("tiktok");
    const second = await runDaily({ env, now, dir, writer, create: fakeCreate(), publishers: [fakePublisher("youtube"), tt], clipsDir, frame });
    expect(second.video!.id).toBe(id);
    expect(frames).toBe(2);
    expect(tt.seen).toHaveLength(1);
    expect(fs.existsSync(path.join(clipsDir, "en-cours", `${id}.mp4`))).toBe(false);
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
    expect(buildDescription({ title: "T", caption: "Elle a menti.", hashtags: [] }, true)).toContain(
      "Histoire fictive : personnages et situations sont inventés. Contenu généré par IA",
    );
  });

  it("posts dramas in Entertainment and true stories in Education", async () => {
    const category = async (env: Record<string, string>) => {
      const { impl, calls } = fakeFetch([
        ["oauth2", () => json({ access_token: "t" })],
        ["uploadType=resumable", () => new Response("", { status: 200, headers: { location: "https://upload.example/1" } })],
        ["upload.example", () => json({ id: "v", status: { privacyStatus: "public" } })],
      ]);
      const [yt] = publishersFromEnv({ YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b", YOUTUBE_REFRESH_TOKEN: "c", ...env }, { fetchImpl: impl });
      const file = path.join(tmp, "v.mp4");
      fs.writeFileSync(file, "mp4");
      await yt.publish({ videoPath: file, title: "T", description: "d", hashtags: [] });
      return JSON.parse(calls[1].body).snippet.categoryId;
    };
    expect(await category({})).toBe("24");
    expect(await category({ AUTOMATON_FORMAT: "vulgarisation" })).toBe("27");
  });
});
