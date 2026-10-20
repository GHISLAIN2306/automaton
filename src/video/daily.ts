#!/usr/bin/env node
/**
 * Daily Publisher
 *
 *   node dist/video/daily.js
 *
 * Once a day: writes a new script for the niche, renders it (voice, images,
 * AI label), then posts it to every platform whose credentials are set.
 * Running it twice the same day reuses that day's video and only retries
 * the platforms that failed.
 *
 * Nothing is posted unless AUTOMATON_PUBLISH=true: without it the run makes
 * the video and stops (dry run). Spending caps from review.ts still apply.
 */

import fs from "fs";
import path from "path";
import { createVideo, getVideosDir, listVideos, setVideoStatus } from "./review.js";
import { DEFAULT_NICHE, writeScript, type WriteScriptOptions } from "./writer.js";
import { InstagramPublisher } from "./publish/instagram.js";
import { TikTokPublisher } from "./publish/tiktok.js";
import { YouTubePublisher } from "./publish/youtube.js";
import type { HttpOptions, Publisher } from "./publish/types.js";
import type { Platform, PublicationRecord, VideoManifest, VideoScript } from "./types.js";

const MAX_WRITE_ATTEMPTS = 3;
const AI_NOTICE = "Contenu généré par IA : voix et images créées par intelligence artificielle.";

export interface DailyOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  dir?: string;
  writer?: (options: WriteScriptOptions) => Promise<VideoScript>;
  create?: typeof createVideo;
  publishers?: Publisher[];
  log?: (message: string) => void;
}

export interface DailyReport {
  video?: VideoManifest;
  created: boolean;
  publishing: boolean;
  failures: string[];
  renewedSecrets: Record<string, string>;
}

/** One publisher per platform whose credentials are all present. */
export function publishersFromEnv(env: NodeJS.ProcessEnv = process.env, http: HttpOptions = {}): Publisher[] {
  const publishers: Publisher[] = [];
  if (env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN) {
    publishers.push(
      new YouTubePublisher(
        {
          clientId: env.YOUTUBE_CLIENT_ID,
          clientSecret: env.YOUTUBE_CLIENT_SECRET,
          refreshToken: env.YOUTUBE_REFRESH_TOKEN,
          privacy: env.YOUTUBE_PRIVACY,
        },
        http,
      ),
    );
  }
  if (env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET && env.TIKTOK_REFRESH_TOKEN) {
    publishers.push(
      new TikTokPublisher(
        {
          clientKey: env.TIKTOK_CLIENT_KEY,
          clientSecret: env.TIKTOK_CLIENT_SECRET,
          refreshToken: env.TIKTOK_REFRESH_TOKEN,
          privacy: env.TIKTOK_PRIVACY,
        },
        http,
      ),
    );
  }
  if (env.INSTAGRAM_ACCESS_TOKEN) {
    publishers.push(
      new InstagramPublisher(
        { accessToken: env.INSTAGRAM_ACCESS_TOKEN, userId: env.INSTAGRAM_USER_ID, apiVersion: env.INSTAGRAM_API_VERSION },
        http,
      ),
    );
  }
  return publishers;
}

export function buildDescription(video: Pick<VideoManifest, "title" | "caption" | "hashtags">): string {
  const tags = (video.hashtags ?? []).map((t) => `#${t.replace(/^#/, "").replace(/\s+/g, "")}`);
  return [video.caption || video.title, AI_NOTICE, [...tags, "#IA"].join(" ")].join("\n\n");
}

function saveManifest(dir: string, manifest: VideoManifest): void {
  fs.writeFileSync(path.join(dir, manifest.id, "manifest.json"), JSON.stringify(manifest, null, 2));
}

async function makeTodaysVideo(options: DailyOptions, dir: string, env: NodeJS.ProcessEnv): Promise<VideoManifest> {
  const writer = options.writer ?? writeScript;
  const create = options.create ?? createVideo;
  const log = options.log ?? (() => {});
  const pastTitles = listVideos(dir)
    .filter((v) => !v.renderFailed)
    .map((v) => v.title)
    .slice(-200);
  const rejectedTitles: string[] = [];
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    let script: VideoScript | undefined;
    try {
      script = await writer({
        apiKey: env.GEMINI_API_KEY ?? "",
        model: env.AUTOMATON_SCRIPT_MODEL,
        niche: env.AUTOMATON_NICHE || DEFAULT_NICHE,
        topic: env.AUTOMATON_TOPIC,
        pastTitles,
        rejectedTitles,
      });
      log(`Script: "${script.title}" (${script.scenes.length} scenes)`);
      return await create(script, { dir, env });
    } catch (err: any) {
      lastError = err;
      const message = err?.message ?? String(err);
      // Retry only what a new script can fix; budget and API errors stop the run.
      const retryable = /^Too close to|^Narration too|^Script (has|needs|writer)|^Scene \d|JSON/.test(message);
      log(`Attempt ${attempt} failed: ${message}`);
      if (!retryable) throw err;
      if (script) rejectedTitles.push(script.title);
    }
  }
  throw lastError;
}

/**
 * Renders an earlier video's script again under a new id. The old entry is
 * kept as renderFailed so its cost still counts in the monthly budget and the
 * near-duplicate check ignores it; posts already made are carried over.
 */
async function rerender(
  previous: VideoManifest,
  options: DailyOptions,
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<VideoManifest> {
  const script = JSON.parse(fs.readFileSync(path.join(dir, previous.id, "script.json"), "utf-8")) as VideoScript;
  saveManifest(dir, { ...previous, renderFailed: true, reviewNote: "Video file missing; rendered again" });
  const create = options.create ?? createVideo;
  const fresh = await create(script, { dir, env });
  if (!previous.publications) return fresh;
  const carried = { ...fresh, publications: previous.publications };
  saveManifest(dir, carried);
  return carried;
}

export async function runDaily(options: DailyOptions = {}): Promise<DailyReport> {
  const env = options.env ?? process.env;
  const dir = options.dir ?? getVideosDir();
  const now = options.now ?? new Date();
  const log = options.log ?? (() => {});
  const today = now.toISOString().slice(0, 10);
  const publishing = env.AUTOMATON_PUBLISH === "true";
  const report: DailyReport = { created: false, publishing, failures: [], renewedSecrets: {} };

  let video = listVideos(dir).find((v) => !v.renderFailed && v.status !== "rejected" && v.createdAt.startsWith(today));
  if (video && !fs.existsSync(path.join(dir, video.id, "video.mp4"))) {
    // Only scripts and manifests are kept between runs (the MP4 is not committed):
    // render today's script again rather than writing a new one.
    video = await rerender(video, options, dir, env);
    report.created = true;
    log(`Rendered today's script again as ${video.id}: ${video.durationSec}s`);
  } else if (video) {
    log(`Reusing today's video ${video.id}: "${video.title}"`);
  } else {
    video = await makeTodaysVideo(options, dir, env);
    report.created = true;
    log(`Rendered ${video.id}: ${video.durationSec}s, $${(video.costCents / 100).toFixed(2)}`);
  }
  report.video = video;

  const failedChecks = video.checks.filter((c) => !c.passed);
  if (failedChecks.length) {
    report.video = setVideoStatus(video.id, "rejected", `Failed checks: ${failedChecks.map((c) => c.name).join(", ")}`, dir);
    report.failures.push(`checks: ${failedChecks.map((c) => `${c.name} (${c.detail})`).join("; ")}`);
    return report;
  }

  if (!publishing) {
    log("Dry run: AUTOMATON_PUBLISH is not true, nothing posted.");
    return report;
  }

  const publishers = options.publishers ?? publishersFromEnv(env);
  if (publishers.length === 0) {
    report.failures.push("no platform credentials set");
    return report;
  }
  if (video.status !== "approved") video = setVideoStatus(video.id, "approved", "Publication automatique", dir);

  const videoPath = path.join(dir, video.id, "video.mp4");
  const publications: Partial<Record<Platform, PublicationRecord>> = { ...(video.publications ?? {}) };
  for (const publisher of publishers) {
    const previous = publications[publisher.platform];
    if (previous && previous.status !== "failed") continue;
    try {
      const result = await publisher.publish({
        videoPath,
        title: video.title,
        description: buildDescription(video),
        hashtags: video.hashtags ?? [],
      });
      publications[publisher.platform] = { status: result.status, at: new Date().toISOString(), id: result.id, url: result.url };
      log(`${publisher.platform}: ${result.status}${result.url ? ` ${result.url}` : ""}`);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      publications[publisher.platform] = { status: "failed", at: new Date().toISOString(), error: message };
      report.failures.push(`${publisher.platform}: ${message}`);
      log(`${publisher.platform}: FAILED ${message}`);
    } finally {
      Object.assign(report.renewedSecrets, publisher.renewedSecrets?.() ?? {});
    }
  }
  video = { ...video, publications };
  saveManifest(dir, video);
  report.video = video;
  return report;
}

function summary(report: DailyReport): string {
  const v = report.video;
  const lines = [`## Vidéo du jour${v ? ` : ${v.title}` : ""}`];
  if (v) {
    lines.push(`${report.created ? "Créée" : "Reprise"} : ${v.durationSec} s, ${(v.costCents / 100).toFixed(2)} $`);
    if (!report.publishing) lines.push("Mode essai : rien n'a été publié.");
    for (const [platform, p] of Object.entries(v.publications ?? {})) {
      lines.push(`- ${platform} : ${p!.status}${p!.url ? ` (${p!.url})` : ""}${p!.error ? ` : ${p!.error}` : ""}`);
    }
  }
  for (const f of report.failures) lines.push(`- Échec : ${f}`);
  return lines.join("\n") + "\n";
}

async function main(): Promise<number> {
  const report = await runDaily({ log: (m) => console.log(m) });
  const text = summary(report);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  const secretsFile = process.env.AUTOMATON_RENEWED_SECRETS_FILE;
  if (secretsFile && Object.keys(report.renewedSecrets).length) {
    fs.writeFileSync(secretsFile, JSON.stringify(report.renewedSecrets), { mode: 0o600 });
  }
  return report.failures.length ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\.ts$/, ".js").endsWith(path.join("video", "daily.js"));
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.message ?? err);
      process.exit(1);
    },
  );
}
