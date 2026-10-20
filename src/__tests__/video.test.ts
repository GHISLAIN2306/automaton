import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitSentences, timeSentences, wrapText, paletteFor } from "../video/render.js";
import {
  createVideo,
  findNearDuplicate,
  listVideos,
  setVideoStatus,
  similarity,
  validateScript,
} from "../video/review.js";
import type { TtsProvider } from "../video/tts.js";
import type { VideoScript } from "../video/types.js";

const fakeTts: TtsProvider = {
  name: "fake",
  costCents: () => 0,
  synthesize: async () => {},
};

function script(narration: string, title = "Test"): VideoScript {
  return { title, niche: "histoire", scenes: [{ narration, onScreen: "Titre" }] };
}

function hasTool(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("video text helpers", () => {
  it("wraps words without exceeding the width", () => {
    const wrapped = wrapText("Les pyramides de Gizeh ont été construites il y a plus de quatre mille ans", 20);
    for (const line of wrapped.split("\n")) expect(line.length).toBeLessThanOrEqual(20);
    expect(wrapped.replace(/\n/g, " ")).toBe(
      "Les pyramides de Gizeh ont été construites il y a plus de quatre mille ans",
    );
  });

  it("splits sentences and shares time by length", () => {
    const sentences = splitSentences("Court. Une phrase bien plus longue que la première !");
    expect(sentences).toHaveLength(2);
    const timed = timeSentences(sentences, 10);
    expect(timed[0].start).toBe(0);
    expect(timed[1].end).toBeCloseTo(10);
    expect(timed[1].end - timed[1].start).toBeGreaterThan(timed[0].end - timed[0].start);
  });

  it("gives each niche a stable palette", () => {
    expect(paletteFor("cuisine")).toEqual(paletteFor("cuisine"));
  });
});

describe("script validation and originality", () => {
  it("rejects scripts without scenes or narration", () => {
    expect(() => validateScript({ title: "x", niche: "y", scenes: [] })).toThrow(/scene/);
    expect(() => validateScript({ title: "x", niche: "y", scenes: [{ narration: " " }] })).toThrow(/narration/);
    expect(() => validateScript({ niche: "y", scenes: [{ narration: "a" }] })).toThrow(/title/);
  });

  it("scores near-identical narrations high and different ones low", () => {
    const a = "Le Mont Saint-Michel est entouré par les plus grandes marées d'Europe continentale.";
    const b = "Le Mont Saint-Michel est entouré par les plus grandes marées d'Europe, vraiment.";
    const c = "Les abeilles communiquent la position des fleurs en dansant dans la ruche.";
    expect(similarity(a, b)).toBeGreaterThan(0.5);
    expect(similarity(a, c)).toBe(0);
  });
});

describe("review queue", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "videos-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const render = async (_s: VideoScript, _t: TtsProvider, out: string) => {
    fs.writeFileSync(out, "fake video");
    return { durationSec: 64.2, costCents: 0 };
  };

  it("stores a pending video with its checks and refuses near-duplicates", async () => {
    const first = await createVideo(
      script("Le Mont Saint-Michel est entouré par les plus grandes marées d'Europe continentale."),
      { dir, tts: fakeTts, render },
    );
    expect(first.status).toBe("pending_review");
    expect(first.costCents).toBe(0);
    expect(first.checks.every((c) => c.passed)).toBe(true);
    expect(fs.existsSync(path.join(dir, first.id, "video.mp4"))).toBe(true);

    await expect(
      createVideo(script("Le Mont Saint-Michel est entouré par les plus grandes marées d'Europe, vraiment."), {
        dir,
        tts: fakeTts,
        render,
      }),
    ).rejects.toThrow(/Too close/);

    const other = await createVideo(script("Les abeilles communiquent en dansant.", "Abeilles"), {
      dir,
      tts: fakeTts,
      render,
    });
    expect(listVideos(dir).map((v) => v.id)).toEqual([first.id, other.id]);
    expect(findNearDuplicate(script("Rien à voir avec le reste du tout."), dir)?.score).toBe(0);
  });

  it("flags videos too short for TikTok rewards", async () => {
    const v = await createVideo(script("Trop court."), {
      dir,
      tts: fakeTts,
      render: async (_s, _t, out) => {
        fs.writeFileSync(out, "x");
        return { durationSec: 12, costCents: 0 };
      },
    });
    expect(v.checks.find((c) => c.name === "duration")?.passed).toBe(false);
  });

  it("removes the folder when rendering fails", async () => {
    await expect(
      createVideo(script("Échec."), {
        dir,
        tts: fakeTts,
        render: async () => {
          throw new Error("ffmpeg failed");
        },
      }),
    ).rejects.toThrow(/ffmpeg failed/);
    expect(listVideos(dir)).toHaveLength(0);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("records a human review decision", async () => {
    const v = await createVideo(script("Une vidéo à relire."), { dir, tts: fakeTts, render });
    const reviewed = setVideoStatus(v.id, "rejected", "voix trop robotique", dir);
    expect(reviewed.status).toBe("rejected");
    expect(listVideos(dir)[0].reviewNote).toBe("voix trop robotique");
    expect(() => setVideoStatus("missing", "approved", undefined, dir)).toThrow(/No video/);
  });

  it.skipIf(!hasTool("ffmpeg", ["-version"]) || !hasTool("espeak-ng", ["--version"]))(
    "renders a real MP4 with ffmpeg and espeak-ng",
    async () => {
      const v = await createVideo(
        { title: "Rendu", niche: "test", scenes: [{ narration: "Bonjour. Ceci est un essai.", onScreen: "Essai" }] },
        { dir },
      );
      const file = path.join(dir, v.id, "video.mp4");
      const probe = execFileSync("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0", file,
      ]).toString().trim();
      expect(probe).toBe("1080,1920");
      expect(v.durationSec).toBeGreaterThan(1);
      expect(v.checks.find((c) => c.name === "duration")?.passed).toBe(false);
    },
    60_000,
  );
});
