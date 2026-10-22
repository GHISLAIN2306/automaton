/**
 * Partner Clips (DramaCPS)
 *
 * Licensed extracts of mini-series, dropped by the owner into
 * content/clips/a-publier/ (an .mp4, plus an optional .json with the same
 * name: {"series", "hook", "caption", "hashtags"}). Each clip is framed to
 * 1080x1920 with the hook written on screen for the first 3 seconds, and
 * posted with a "la suite : lien en bio" caption. With a "dramaUrl" in the
 * .json, the series gets a number on the bio link page (series.ts) and the
 * caption names it. These are not AI videos,
 * so they carry no AI label.
 *
 * Once taken, a clip moves to content/clips/en-cours/<video id>.mp4 so it can
 * be framed again on a fresh checkout, and is deleted once posted everywhere.
 */

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import os from "os";
import { ulid } from "ulid";
import { downloadEpisode } from "./dramacps.js";
import { filterPath, findFont, probeDuration, wrapText } from "./render.js";
import { registerSeries } from "./series.js";
import type { VideoCheck, VideoManifest } from "./types.js";

const run = promisify(execFile);

export const DEFAULT_CLIP_HOOK = "Regarde bien sa réaction à la fin";
export const DEFAULT_CLIP_CAPTION = "Tu veux savoir la suite ? 👀 Lien en bio 🎬";
export const DEFAULT_CLIP_HASHTAGS = ["minisérie", "drama", "série", "vengeance", "milliardaire", "dramaexpress"];
const HOOK_SECONDS = 3;
/** YouTube Shorts are at most 3 minutes long. */
const MAX_CLIP_SECONDS = 180;

export interface ClipInfo {
  /** Path of the .mp4 in the inbox. */
  file: string;
  series?: string;
  hook?: string;
  caption?: string;
  hashtags?: string[];
  /** DramaCPS "Drama URL" of the series, listed on the bio link page. */
  dramaUrl?: string;
  dramaId?: string;
  /** Set for an episode downloaded from a DramaCPS resource pack (not kept in git). */
  pack?: string;
  episode?: number;
}

export function getClipsDir(videosDir: string): string {
  return process.env.AUTOMATON_CLIPS_DIR || path.join(path.dirname(videosDir), "clips");
}

/** Clips waiting in the inbox, oldest name first, with their optional .json. */
export function listInbox(clipsDir: string): ClipInfo[] {
  const inbox = path.join(clipsDir, "a-publier");
  if (!fs.existsSync(inbox)) return [];
  return fs
    .readdirSync(inbox)
    .filter((f) => f.toLowerCase().endsWith(".mp4"))
    .sort()
    .map((f) => {
      const file = path.join(inbox, f);
      const meta = file.replace(/\.mp4$/i, ".json");
      const extra = fs.existsSync(meta) ? (JSON.parse(fs.readFileSync(meta, "utf-8")) as Partial<ClipInfo>) : {};
      return { ...extra, file };
    });
}

/** Strips characters the subtitle font cannot draw (emoji). */
function drawable(text: string): string {
  return text.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s+/g, " ").trim();
}

/** Frames a clip to 1080x1920 with the hook on screen for the first seconds. */
export async function frameClip(source: string, hook: string, outFile: string): Promise<number> {
  const font = filterPath(findFont());
  const hookFile = `${outFile}.hook.txt`;
  fs.writeFileSync(hookFile, wrapText(drawable(hook), 18));
  try {
    await run(
      "ffmpeg",
      [
        "-y", "-v", "error",
        "-i", source,
        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black," +
          `drawtext=fontfile='${font}':textfile='${filterPath(hookFile)}':fontsize=78:fontcolor=white:` +
          "line_spacing=16:box=1:boxcolor=black@0.6:boxborderw=26:x=(w-text_w)/2:y=h*0.16:" +
          `enable='lt(t,${HOOK_SECONDS})',format=yuv420p`,
        "-t", String(MAX_CLIP_SECONDS - 5),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-movflags", "+faststart",
        outFile,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    fs.rmSync(hookFile, { force: true });
  }
  return probeDuration(outFile);
}

export interface PrepareClipOptions {
  /** Videos directory (content/videos). */
  dir: string;
  clipsDir: string;
  /** Replaced in tests. */
  frame?: typeof frameClip;
  download?: typeof downloadEpisode;
  /** Creation time of the video (the daily run's clock). */
  now?: Date;
}

/** Takes a clip from the inbox and makes it today's video. */
export async function prepareClip(clip: ClipInfo, options: PrepareClipOptions): Promise<VideoManifest> {
  const id = ulid();
  // Inbox clips are small and kept in git until posted; pack episodes are
  // large and downloaded again when needed.
  const pending = clip.pack ? undefined : path.join(options.clipsDir, "en-cours", `${id}.mp4`);
  if (pending) {
    fs.mkdirSync(path.dirname(pending), { recursive: true });
    fs.renameSync(clip.file, pending);
    fs.rmSync(clip.file.replace(/\.mp4$/i, ".json"), { force: true });
  }

  const hook = clip.hook || DEFAULT_CLIP_HOOK;
  const series = clip.series || path.basename(clip.file, path.extname(clip.file));
  const number = clip.dramaUrl ? registerSeries(options.clipsDir, { title: series, url: clip.dramaUrl, dramaId: clip.dramaId }) : undefined;
  const caption = clip.caption || (number ? `Tu veux savoir la suite ? 👀 Lien en bio, série n° ${number} 🎬` : DEFAULT_CLIP_CAPTION);
  const manifest: VideoManifest = {
    id,
    title: (clip.episode
      ? `${clip.hook ? drawable(clip.hook) : series} | Épisode ${clip.episode}`
      : drawable(clip.hook || series)
    ).slice(0, 90),
    niche: series,
    status: "pending_review",
    createdAt: (options.now ?? new Date()).toISOString(),
    durationSec: 0,
    costCents: 0,
    visuals: "clip",
    aiLabel: "",
    voice: "original",
    checks: [],
    caption,
    hashtags: clip.hashtags?.length ? clip.hashtags : DEFAULT_CLIP_HASHTAGS,
    source: "clip",
    clipFile: pending && path.relative(options.clipsDir, pending),
    hook,
    dramaId: clip.dramaId,
    episode: clip.episode,
    pack: clip.pack,
  };
  try {
    return await frameManifest(manifest, options, clip.pack ? clip.file : undefined);
  } finally {
    if (clip.pack) fs.rmSync(clip.file, { force: true });
  }
}

/** Frames (again) the clip behind a manifest, e.g. on a fresh checkout. */
export async function frameManifest(manifest: VideoManifest, options: PrepareClipOptions, downloaded?: string): Promise<VideoManifest> {
  const videoDir = path.join(options.dir, manifest.id);
  fs.mkdirSync(videoDir, { recursive: true });
  let source = downloaded ?? (manifest.clipFile ? path.join(options.clipsDir, manifest.clipFile) : undefined);
  let temporary: string | undefined;
  if (!source && manifest.pack && manifest.episode) {
    temporary = path.join(os.tmpdir(), `episode-${manifest.id}.mp4`);
    await (options.download ?? downloadEpisode)(
      { dramaId: manifest.dramaId ?? "", title: manifest.niche, pack: manifest.pack },
      manifest.episode,
      temporary,
    );
    source = temporary;
  }
  if (!source || !fs.existsSync(source)) throw new Error(`Clip file missing: ${manifest.clipFile ?? manifest.id}`);
  let duration: number;
  try {
    duration = await (options.frame ?? frameClip)(source, manifest.hook || DEFAULT_CLIP_HOOK, path.join(videoDir, "video.mp4"));
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
  }
  const checks: VideoCheck[] = [
    { name: "duration", passed: duration > 0 && duration <= MAX_CLIP_SECONDS, detail: `${duration.toFixed(1)} s (Shorts: ${MAX_CLIP_SECONDS} s max)` },
  ];
  const framed = { ...manifest, durationSec: Math.round(duration * 10) / 10, checks };
  fs.writeFileSync(path.join(videoDir, "manifest.json"), JSON.stringify(framed, null, 2));
  return framed;
}

/** Deletes the source once the clip is posted everywhere. */
export function releaseClip(manifest: VideoManifest, clipsDir: string): void {
  if (manifest.clipFile) fs.rmSync(path.join(clipsDir, manifest.clipFile), { force: true });
}
