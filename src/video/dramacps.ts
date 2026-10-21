/**
 * DramaCPS Resource Packs
 *
 * "Get Video" on DramaCPS gives a zip per series (a cover and Episode1.mp4,
 * Episode2.mp4, ... already vertical, French subtitles burned in), often
 * over 500 MB. Only the episode needed is fetched, with HTTP range requests:
 * the zip's central directory is read from the end of the file, then just
 * that entry's bytes.
 *
 * The series to promote are listed by the owner in
 * content/clips/series-a-publier.json:
 *   [{"dramaId": "653763", "title": "...", "dramaUrl": "https://...",
 *     "pack": "https://...zip", "hook": "...", "episodes": 5}]
 * Each clip slot takes the next episode of the series posted least so far.
 */

import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import zlib from "zlib";
import type { VideoManifest } from "./types.js";

export interface PackSeries {
  dramaId: string;
  title: string;
  dramaUrl?: string;
  pack: string;
  hook?: string;
  hashtags?: string[];
  /** Episodes to post before moving on (default 5); the rest stays in the app. */
  episodes?: number;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

type Fetch = typeof fetch;

async function range(url: string, start: number, end: number, fetchImpl: Fetch): Promise<Buffer> {
  const resp = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (resp.status !== 206 && resp.status !== 200) throw new Error(`Pack download: HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/** Lists a remote zip from its central directory (zip files under 4 GB). */
export async function listZip(url: string, fetchImpl: Fetch = fetch): Promise<ZipEntry[]> {
  const head = await fetchImpl(url, { method: "HEAD" });
  const size = Number(head.headers.get("content-length"));
  if (!head.ok || !size) throw new Error(`Pack unavailable: HTTP ${head.status}`);
  const tailStart = Math.max(0, size - 66_000);
  const tail = await range(url, tailStart, size - 1, fetchImpl);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("Pack is not a zip file");
  const count = tail.readUInt16LE(eocd + 10);
  const dirSize = tail.readUInt32LE(eocd + 12);
  const dirOffset = tail.readUInt32LE(eocd + 16);
  const dir = await range(url, dirOffset, dirOffset + dirSize - 1, fetchImpl);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && dir.readUInt32LE(p) === 0x02014b50; i++) {
    const nameLength = dir.readUInt16LE(p + 28);
    const extraLength = dir.readUInt16LE(p + 30);
    const commentLength = dir.readUInt16LE(p + 32);
    entries.push({
      method: dir.readUInt16LE(p + 10),
      compressedSize: dir.readUInt32LE(p + 20),
      size: dir.readUInt32LE(p + 24),
      localHeaderOffset: dir.readUInt32LE(p + 42),
      name: dir.subarray(p + 46, p + 46 + nameLength).toString("utf-8"),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Downloads one entry of a remote zip to a file. */
export async function extractZipEntry(url: string, entry: ZipEntry, outFile: string, fetchImpl: Fetch = fetch): Promise<void> {
  const header = await range(url, entry.localHeaderOffset, entry.localHeaderOffset + 29, fetchImpl);
  const dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const resp = await fetchImpl(url, { headers: { Range: `bytes=${dataStart}-${dataStart + entry.compressedSize - 1}` } });
  if (resp.status !== 206 || !resp.body) throw new Error(`Pack download: HTTP ${resp.status}`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const body = Readable.fromWeb(resp.body as any);
  if (entry.method === 0) await pipeline(body, fs.createWriteStream(outFile));
  else if (entry.method === 8) await pipeline(body, zlib.createInflateRaw(), fs.createWriteStream(outFile));
  else throw new Error(`Unsupported zip compression ${entry.method} for ${entry.name}`);
}

export function episodeEntryName(episode: number): RegExp {
  return new RegExp(`(^|/)(episode|ep|épisode)[ _-]?0*${episode}\\.mp4$`, "i");
}

export function loadPackSeries(clipsDir: string): PackSeries[] {
  const file = path.join(clipsDir, "series-a-publier.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf-8")) as PackSeries[]) : [];
}

/**
 * Next series episode to post: the series with the fewest episodes taken so
 * far (list order breaks ties), skipping series that reached their limit.
 */
export function nextPackEpisode(series: PackSeries[], videos: VideoManifest[]): { series: PackSeries; episode: number } | undefined {
  const taken = (s: PackSeries) =>
    videos.filter((v) => v.source === "clip" && v.dramaId === s.dramaId && !v.renderFailed && v.status !== "rejected").length;
  const open = series.map((s) => ({ s, n: taken(s) })).filter(({ s, n }) => n < (s.episodes ?? 5));
  if (!open.length) return undefined;
  const best = open.reduce((a, b) => (b.n < a.n ? b : a));
  return { series: best.s, episode: best.n + 1 };
}

/** Downloads one episode of a series pack. */
export async function downloadEpisode(series: PackSeries, episode: number, outFile: string, fetchImpl: Fetch = fetch): Promise<void> {
  const entries = await listZip(series.pack, fetchImpl);
  const entry = entries.find((e) => episodeEntryName(episode).test(e.name));
  if (!entry) throw new Error(`Episode ${episode} not found in the pack of ${series.title}`);
  await extractZipEntry(series.pack, entry, outFile, fetchImpl);
}
