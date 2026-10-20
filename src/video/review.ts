/**
 * Video Review Queue
 *
 * Every rendered video waits in ~/.automaton/videos/<id>/ with its script
 * and a manifest. Only a human moves a video to "approved" or "rejected"
 * (through the video CLI); the agent can create and list videos, never
 * approve or publish them.
 */

import fs from "fs";
import path from "path";
import { ulid } from "ulid";
import { getAutomatonDir } from "../identity/wallet.js";
import { renderVideo, type RenderResult } from "./render.js";
import type { TtsProvider } from "./tts.js";
import { createDefaultTts } from "./tts.js";
import type { RenderOptions, VideoCheck, VideoManifest, VideoScript, VideoStatus } from "./types.js";
import { DEFAULT_AI_LABEL, MAX_SIMILARITY, MIN_DURATION_SEC } from "./types.js";

export function getVideosDir(): string {
  return path.join(getAutomatonDir(), "videos");
}

export function validateScript(input: unknown): VideoScript {
  const s = input as Partial<VideoScript> | null;
  if (!s || typeof s !== "object") throw new Error("Script must be a JSON object");
  if (typeof s.title !== "string" || !s.title.trim()) throw new Error("Script needs a title");
  if (typeof s.niche !== "string" || !s.niche.trim()) throw new Error("Script needs a niche");
  if (!Array.isArray(s.scenes) || s.scenes.length === 0) throw new Error("Script needs at least one scene");
  s.scenes.forEach((scene, i) => {
    if (!scene || typeof scene.narration !== "string" || !scene.narration.trim()) {
      throw new Error(`Scene ${i + 1} needs narration text`);
    }
    if (scene.onScreen !== undefined && typeof scene.onScreen !== "string") {
      throw new Error(`Scene ${i + 1}: onScreen must be text`);
    }
  });
  return s as VideoScript;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Jaccard overlap of 3-word shingles between two narrations (0..1). */
export function similarity(a: string, b: string): number {
  const shingles = (text: string) => {
    const w = words(text);
    const set = new Set<string>();
    for (let i = 0; i + 2 < w.length; i++) set.add(w.slice(i, i + 3).join(" "));
    return set;
  };
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / (sa.size + sb.size - shared);
}

export function narrationOf(script: VideoScript): string {
  return script.scenes.map((s) => s.narration).join(" ");
}

export function listVideos(dir = getVideosDir()): VideoManifest[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((id) => path.join(dir, id, "manifest.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, "utf-8")) as VideoManifest)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Closest earlier video, to refuse near-duplicates before rendering. */
export function findNearDuplicate(
  script: VideoScript,
  dir = getVideosDir(),
): { id: string; title: string; score: number } | null {
  const narration = narrationOf(script);
  let best: { id: string; title: string; score: number } | null = null;
  for (const video of listVideos(dir)) {
    const scriptFile = path.join(dir, video.id, "script.json");
    if (!fs.existsSync(scriptFile)) continue;
    const previous = JSON.parse(fs.readFileSync(scriptFile, "utf-8")) as VideoScript;
    const score = similarity(narration, narrationOf(previous));
    if (!best || score > best.score) best = { id: video.id, title: video.title, score };
  }
  return best;
}

export interface CreateVideoOptions extends RenderOptions {
  dir?: string;
  tts?: TtsProvider;
  /** Injected in tests to avoid running ffmpeg. */
  render?: typeof renderVideo;
}

export async function createVideo(input: unknown, options: CreateVideoOptions = {}): Promise<VideoManifest> {
  const script = validateScript(input);
  const dir = options.dir ?? getVideosDir();

  const duplicate = findNearDuplicate(script, dir);
  if (duplicate && duplicate.score > MAX_SIMILARITY) {
    throw new Error(
      `Too close to "${duplicate.title}" (${Math.round(duplicate.score * 100)}% identical). ` +
        "Platforms penalize mass-produced near-duplicates: write a genuinely different video.",
    );
  }

  const id = ulid();
  const videoDir = path.join(dir, id);
  fs.mkdirSync(videoDir, { recursive: true });
  fs.writeFileSync(path.join(videoDir, "script.json"), JSON.stringify(script, null, 2));

  const tts = options.tts ?? (await createDefaultTts(script.language));
  const aiLabel = options.aiLabel ?? DEFAULT_AI_LABEL;
  const render = options.render ?? renderVideo;
  let result: RenderResult;
  try {
    result = await render(script, tts, path.join(videoDir, "video.mp4"), path.join(videoDir, "work"), {
      ...options,
      aiLabel,
    });
  } catch (err) {
    fs.rmSync(videoDir, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(path.join(videoDir, "work"), { recursive: true, force: true });
  }

  const checks: VideoCheck[] = [
    {
      name: "duration",
      passed: result.durationSec >= MIN_DURATION_SEC,
      detail: `${result.durationSec.toFixed(1)} s (TikTok Creator Rewards counts videos over ${MIN_DURATION_SEC - 1} s)`,
    },
    {
      name: "ai_label",
      passed: aiLabel.trim().length > 0,
      detail: `Visible label on every frame: "${aiLabel}"`,
    },
    {
      name: "originality",
      passed: true,
      detail: duplicate
        ? `Closest earlier video: "${duplicate.title}" (${Math.round(duplicate.score * 100)}% overlap)`
        : "First video in the queue",
    },
  ];

  const manifest: VideoManifest = {
    id,
    title: script.title,
    niche: script.niche,
    status: "pending_review",
    createdAt: new Date().toISOString(),
    durationSec: Math.round(result.durationSec * 10) / 10,
    costCents: result.costCents,
    aiLabel,
    voice: tts.name,
    checks,
    caption: script.caption,
    hashtags: script.hashtags,
  };
  fs.writeFileSync(path.join(videoDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function setVideoStatus(
  id: string,
  status: Exclude<VideoStatus, "pending_review">,
  note?: string,
  dir = getVideosDir(),
): VideoManifest {
  const file = path.join(dir, id, "manifest.json");
  if (!fs.existsSync(file)) throw new Error(`No video with id ${id}`);
  const manifest = JSON.parse(fs.readFileSync(file, "utf-8")) as VideoManifest;
  manifest.status = status;
  manifest.reviewedAt = new Date().toISOString();
  if (note) manifest.reviewNote = note;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return manifest;
}

export function formatVideoList(videos: VideoManifest[]): string {
  if (videos.length === 0) return "No videos yet.";
  return videos
    .map((v) => {
      const failed = v.checks.filter((c) => !c.passed).map((c) => c.name);
      return (
        `${v.id}  [${v.status}]  ${v.durationSec}s  ${v.niche} — ${v.title}` +
        (failed.length ? `  (failed checks: ${failed.join(", ")})` : "") +
        (v.reviewNote ? `\n    review: ${v.reviewNote}` : "")
      );
    })
    .join("\n");
}
