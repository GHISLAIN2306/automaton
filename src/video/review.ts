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
import { GeminiImage, GeminiTts } from "./gemini.js";
import type { ImageProvider, RenderOptions, VideoCheck, VideoManifest, VideoScript, VideoStatus } from "./types.js";
import {
  DEFAULT_AI_LABEL,
  DEFAULT_MAX_COST_PER_VIDEO_CENTS,
  DEFAULT_MONTHLY_BUDGET_CENTS,
  MAX_SIMILARITY,
  MIN_DURATION_SEC,
} from "./types.js";

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
    for (const field of ["onScreen", "visual"] as const) {
      if (scene[field] !== undefined && typeof scene[field] !== "string") {
        throw new Error(`Scene ${i + 1}: ${field} must be text`);
      }
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
    if (video.renderFailed) continue;
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
  /** Spending caps in cents (default from env, then 50 per video and 3000 per month). */
  maxCostPerVideoCents?: number;
  monthlyBudgetCents?: number;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests to avoid running ffmpeg. */
  render?: typeof renderVideo;
}

/**
 * Natural voice and illustrations when GEMINI_API_KEY is set (paid);
 * otherwise the free local voice and gradient backgrounds.
 */
export async function defaultProviders(
  language: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ tts: TtsProvider; images?: ImageProvider }> {
  const apiKey = env.GEMINI_API_KEY;
  if (apiKey) {
    return {
      tts: new GeminiTts({ apiKey, model: env.AUTOMATON_TTS_MODEL, voice: env.AUTOMATON_TTS_VOICE }),
      images: new GeminiImage({ apiKey, model: env.AUTOMATON_IMAGE_MODEL }),
    };
  }
  return { tts: await createDefaultTts(language) };
}

function centsFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Money already spent on videos created this calendar month (UTC), in cents. */
export function spentThisMonthCents(dir = getVideosDir(), now = new Date()): number {
  const month = now.toISOString().slice(0, 7);
  return listVideos(dir)
    .filter((v) => v.createdAt.startsWith(month))
    .reduce((sum, v) => sum + (v.costCents || 0), 0);
}

export function estimateCostCents(script: VideoScript, tts: TtsProvider, images?: ImageProvider): number {
  const voice = script.scenes.reduce((sum, s) => sum + tts.costCents(s.narration), 0);
  return voice + (images ? images.costCents() * script.scenes.length : 0);
}

export async function createVideo(input: unknown, options: CreateVideoOptions = {}): Promise<VideoManifest> {
  const script = validateScript(input);
  const dir = options.dir ?? getVideosDir();
  const env = options.env ?? process.env;

  const duplicate = findNearDuplicate(script, dir);
  if (duplicate && duplicate.score > MAX_SIMILARITY) {
    throw new Error(
      `Too close to "${duplicate.title}" (${Math.round(duplicate.score * 100)}% identical). ` +
        "Platforms penalize mass-produced near-duplicates: write a genuinely different video.",
    );
  }

  const providers =
    options.tts || options.images ? { tts: options.tts, images: options.images } : await defaultProviders(script.language, env);
  const tts = providers.tts ?? (await createDefaultTts(script.language));
  const images = providers.images;

  const estimate = estimateCostCents(script, tts, images);
  const perVideo = options.maxCostPerVideoCents ?? centsFromEnv(env.AUTOMATON_VIDEO_MAX_COST_CENTS, DEFAULT_MAX_COST_PER_VIDEO_CENTS);
  const monthly = options.monthlyBudgetCents ?? centsFromEnv(env.AUTOMATON_VIDEO_MONTHLY_BUDGET_CENTS, DEFAULT_MONTHLY_BUDGET_CENTS);
  if (estimate > perVideo) {
    throw new Error(
      `Estimated cost $${(estimate / 100).toFixed(2)} exceeds the per-video cap of $${(perVideo / 100).toFixed(2)}. Use fewer scenes.`,
    );
  }
  const spent = spentThisMonthCents(dir);
  if (spent + estimate > monthly) {
    throw new Error(
      `Monthly video budget reached: $${(spent / 100).toFixed(2)} spent of $${(monthly / 100).toFixed(2)}. ` +
        "Ask your creator before spending more.",
    );
  }

  const id = ulid();
  const videoDir = path.join(dir, id);
  fs.mkdirSync(videoDir, { recursive: true });
  fs.writeFileSync(path.join(videoDir, "script.json"), JSON.stringify(script, null, 2));

  // Count what each paid call actually costs, so a failed render is still billed.
  let spentCents = 0;
  const trackedTts: TtsProvider = {
    name: tts.name,
    costCents: (text) => tts.costCents(text),
    synthesize: async (text, out) => {
      await tts.synthesize(text, out);
      spentCents += tts.costCents(text);
    },
  };
  const trackedImages: ImageProvider | undefined = images && {
    name: images.name,
    costCents: () => images.costCents(),
    generate: async (prompt, out) => {
      const file = await images.generate(prompt, out);
      spentCents += images.costCents();
      return file;
    },
  };

  const aiLabel = options.aiLabel ?? DEFAULT_AI_LABEL;
  const render = options.render ?? renderVideo;
  let result: RenderResult;
  try {
    result = await render(script, trackedTts, path.join(videoDir, "video.mp4"), path.join(videoDir, "work"), {
      ...options,
      images: trackedImages,
      aiLabel,
    });
  } catch (err: any) {
    if (spentCents > 0) {
      // Keep a record of the money spent so the monthly budget stays accurate.
      fs.rmSync(path.join(videoDir, "video.mp4"), { force: true });
      const failed: VideoManifest = {
        id,
        title: script.title,
        niche: script.niche,
        status: "rejected",
        createdAt: new Date().toISOString(),
        reviewNote: `Render failed: ${err?.message ?? String(err)}`,
        renderFailed: true,
        durationSec: 0,
        costCents: Math.round(spentCents * 100) / 100,
        visuals: images?.name ?? "gradient",
        aiLabel,
        voice: tts.name,
        checks: [],
      };
      fs.writeFileSync(path.join(videoDir, "manifest.json"), JSON.stringify(failed, null, 2));
    } else {
      fs.rmSync(videoDir, { recursive: true, force: true });
    }
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
    costCents: Math.round(spentCents * 100) / 100,
    visuals: images?.name ?? "gradient",
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
