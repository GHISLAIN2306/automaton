/**
 * Video Renderer
 *
 * Turns a VideoScript into a vertical 1080x1920 MP4 with ffmpeg only:
 * an animated gradient background per scene, the scene headline, subtitles
 * timed sentence by sentence, the synthesized narration, and a permanent
 * "AI-generated" label. Everything runs locally and costs nothing.
 */

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { TtsProvider } from "./tts.js";
import type { RenderOptions, VideoScript } from "./types.js";
import { DEFAULT_AI_LABEL } from "./types.js";

const run = promisify(execFile);

const FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
];

/** Background color pairs; each niche gets a stable one. */
const PALETTES: Array<[string, string]> = [
  ["0x1e3a8a", "0x7c3aed"],
  ["0x064e3b", "0x0ea5e9"],
  ["0x7c2d12", "0xdb2777"],
  ["0x111827", "0x2563eb"],
  ["0x3f1d38", "0xf59e0b"],
  ["0x0f172a", "0x14b8a6"],
];

export interface RenderResult {
  durationSec: number;
  costCents: number;
}

export function findFont(explicit?: string): string {
  const candidates = [explicit, process.env.AUTOMATON_VIDEO_FONT, ...FONT_CANDIDATES].filter(
    (f): f is string => !!f,
  );
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) throw new Error("No usable font found; set AUTOMATON_VIDEO_FONT to a .ttf/.otf file");
  return found;
}

export function paletteFor(niche: string): [string, string] {
  let hash = 0;
  for (const ch of niche) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTES[hash % PALETTES.length];
}

/** Greedy word wrap to at most `width` characters per line. */
export function wrapText(text: string, width: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Share `duration` between sentences in proportion to their length. */
export function timeSentences(sentences: string[], duration: number): Array<{ text: string; start: number; end: number }> {
  const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
  let t = 0;
  return sentences.map((text) => {
    const span = (duration * text.length) / total;
    const timed = { text, start: t, end: t + span };
    t += span;
    return timed;
  });
}

/** Escape a path for use inside an ffmpeg filter argument. */
function filterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const value = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(value)) throw new Error(`Could not read duration of ${file}`);
  return value;
}

export async function renderVideo(
  script: VideoScript,
  tts: TtsProvider,
  outFile: string,
  workDir: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const fps = options.fps ?? 30;
  const font = filterPath(findFont(options.fontPath));
  const label = options.aiLabel ?? DEFAULT_AI_LABEL;
  const [c0, c1] = paletteFor(script.niche);
  const pause = 0.4;

  fs.mkdirSync(workDir, { recursive: true });
  const labelFile = path.join(workDir, "label.txt");
  fs.writeFileSync(labelFile, label);

  let costCents = 0;
  const sceneFiles: string[] = [];
  for (const [i, scene] of script.scenes.entries()) {
    const wav = path.join(workDir, `scene-${i}.wav`);
    await tts.synthesize(scene.narration, wav);
    costCents += tts.costCents(scene.narration);
    const duration = (await probeDuration(wav)) + pause;

    const filters = [
      `drawtext=fontfile='${font}':textfile='${filterPath(labelFile)}':fontsize=38:fontcolor=white@0.9:` +
        `box=1:boxcolor=black@0.45:boxborderw=14:x=(w-text_w)/2:y=90`,
    ];
    if (scene.onScreen) {
      const headline = path.join(workDir, `headline-${i}.txt`);
      fs.writeFileSync(headline, wrapText(scene.onScreen, 16));
      filters.push(
        `drawtext=fontfile='${font}':textfile='${filterPath(headline)}':fontsize=96:fontcolor=white:` +
          `line_spacing=18:shadowcolor=black@0.5:shadowx=4:shadowy=4:x=(w-text_w)/2:y=(h-text_h)/2-260`,
      );
    }
    for (const [j, s] of timeSentences(splitSentences(scene.narration), duration - pause).entries()) {
      const sub = path.join(workDir, `sub-${i}-${j}.txt`);
      fs.writeFileSync(sub, wrapText(s.text, 30));
      filters.push(
        `drawtext=fontfile='${font}':textfile='${filterPath(sub)}':fontsize=58:fontcolor=white:` +
          `line_spacing=12:box=1:boxcolor=black@0.55:boxborderw=22:x=(w-text_w)/2:y=h*0.68:` +
          `enable='between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})'`,
      );
    }

    const sceneFile = path.join(workDir, `scene-${i}.mp4`);
    await run(
      "ffmpeg",
      [
        "-y", "-v", "error",
        "-f", "lavfi",
        "-i", `gradients=s=${width}x${height}:c0=${c0}:c1=${c1}:speed=0.008:r=${fps}:d=${duration.toFixed(2)}:seed=${i + 1}`,
        "-i", wav,
        "-filter_complex", `[0:v]${filters.join(",")},format=yuv420p[v];[1:a]apad,aresample=44100[a]`,
        "-map", "[v]", "-map", "[a]",
        "-t", duration.toFixed(2),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        sceneFile,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    sceneFiles.push(sceneFile);
  }

  const list = path.join(workDir, "scenes.txt");
  fs.writeFileSync(list, sceneFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  await run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", outFile]);

  return { durationSec: await probeDuration(outFile), costCents };
}
