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
import { GeminiImage, GeminiTts, imagePrompt, lastOutputBlock } from "../video/gemini.js";
import type { TtsProvider } from "../video/tts.js";
import type { ImageProvider, VideoScript } from "../video/types.js";

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

  it("refuses videos above the per-video cap or the monthly budget", async () => {
    const paidImages: ImageProvider = { name: "paid", costCents: () => 4, generate: async (_p, out) => `${out}.png` };
    const twoScenes = { title: "Deux", niche: "n", scenes: [{ narration: "Un." }, { narration: "Deux." }] };
    await expect(
      createVideo(twoScenes, { dir, tts: fakeTts, images: paidImages, render, maxCostPerVideoCents: 5 }),
    ).rejects.toThrow(/per-video cap/);

    const counting = async (s: VideoScript, t: TtsProvider, out: string, _w: string, o: any) => {
      for (const [i, scene] of s.scenes.entries()) {
        await t.synthesize(scene.narration, "x");
        await o.images?.generate("p", `img-${i}`);
      }
      fs.writeFileSync(out, "v");
      return { durationSec: 70, costCents: 0 };
    };
    const first = await createVideo(twoScenes, {
      dir, tts: fakeTts, images: paidImages, render: counting, monthlyBudgetCents: 10,
    });
    expect(first.costCents).toBe(8);
    expect(first.visuals).toBe("paid");
    await expect(
      createVideo({ ...twoScenes, title: "Autre", scenes: [{ narration: "Trois." }, { narration: "Quatre." }] }, {
        dir, tts: fakeTts, images: paidImages, render: counting, monthlyBudgetCents: 10,
      }),
    ).rejects.toThrow(/Monthly video budget/);
  });

  it("keeps the cost of a render that failed after paid calls, and allows a retry", async () => {
    const paidImages: ImageProvider = { name: "paid", costCents: () => 4, generate: async (_p, out) => `${out}.png` };
    const failing = async (_s: VideoScript, _t: TtsProvider, _out: string, _w: string, o: any) => {
      await o.images.generate("p", "img");
      throw new Error("ffmpeg crashed");
    };
    const s = script("Une histoire qui échoue au rendu puis réussit.");
    await expect(createVideo(s, { dir, tts: fakeTts, images: paidImages, render: failing })).rejects.toThrow(/crashed/);
    const [failed] = listVideos(dir);
    expect(failed.renderFailed).toBe(true);
    expect(failed.costCents).toBe(4);
    const retry = await createVideo(s, { dir, tts: fakeTts, images: paidImages, render });
    expect(retry.status).toBe("pending_review");
  });

  it("uses Gemini providers only when GEMINI_API_KEY is set", async () => {
    const { defaultProviders } = await import("../video/review.js");
    const paid = await defaultProviders("fr", { GEMINI_API_KEY: "k" });
    expect(paid.tts.name).toContain("gemini-3.8-flash-tts");
    expect(paid.images?.name).toBe("gemini-nano-banana-2.1");
    const free = await defaultProviders("fr", {});
    expect(free.images).toBeUndefined();
  });

  it("records a human review decision", async () => {
    const v = await createVideo(script("Une vidéo à relire."), { dir, tts: fakeTts, render });
    const reviewed = setVideoStatus(v.id, "rejected", "voix trop robotique", dir);
    expect(reviewed.status).toBe("rejected");
    expect(listVideos(dir)[0].reviewNote).toBe("voix trop robotique");
    expect(() => setVideoStatus("missing", "approved", undefined, dir)).toThrow(/No video/);
  });

  it.skipIf(!hasTool("ffmpeg", ["-version"]) || !hasTool("espeak-ng", ["--version"]))(
    "renders scenes over generated illustrations",
    async () => {
      const images: ImageProvider = {
        name: "test-pattern",
        costCents: () => 0,
        generate: async (_prompt, out) => {
          const file = `${out}.png`;
          execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=768x1344", "-frames:v", "1", file]);
          return file;
        },
      };
      const v = await createVideo(
        { title: "Images", niche: "test", scenes: [{ narration: "Une scène illustrée.", visual: "un phare" }] },
        { dir, images, env: {} },
      );
      expect(v.visuals).toBe("test-pattern");
      const probe = execFileSync("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0", path.join(dir, v.id, "video.mp4"),
      ]).toString().trim();
      expect(probe).toBe("1080,1920");
    },
    60_000,
  );

  it.skipIf(!hasTool("ffmpeg", ["-version"]) || !hasTool("espeak-ng", ["--version"]))(
    "renders a real MP4 with ffmpeg and espeak-ng",
    async () => {
      const v = await createVideo(
        { title: "Rendu", niche: "test", scenes: [{ narration: "Bonjour. Ceci est un essai.", onScreen: "Essai" }] },
        { dir, env: {} },
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

describe("Gemini providers", () => {
  const response = (type: "audio" | "image", data: string, mime = "image/png") =>
    new Response(
      JSON.stringify({
        steps: [
          { type: "user_input", content: [] },
          { type: "model_output", content: [{ type: "text", text: "ok" }, { type, data, mime_type: mime }] },
        ],
      }),
      { status: 200 },
    );

  it("writes the narration audio and sends the voice and key", async () => {
    let sent: any;
    let headers: any;
    const fetchImpl = (async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      headers = init.headers;
      return response("audio", Buffer.from("RIFFwav").toString("base64"));
    }) as unknown as typeof fetch;
    const tts = new GeminiTts({ apiKey: "secret", voice: "Kore", fetchImpl });
    const out = path.join(os.tmpdir(), `tts-${Date.now()}.wav`);
    await tts.synthesize("Bonjour", out);
    expect(fs.readFileSync(out, "utf-8")).toBe("RIFFwav");
    expect(sent.model).toBe("gemini-3.8-flash-tts");
    expect(sent.generation_config.speech_config).toEqual([{ voice: "Kore" }]);
    expect(headers["x-goog-api-key"]).toBe("secret");
    expect(tts.costCents("x".repeat(140))).toBeCloseTo(0.225);
    fs.rmSync(out);
  });

  it("writes a vertical image with the extension of its type", async () => {
    let sent: any;
    const fetchImpl = (async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return response("image", Buffer.from("jpg").toString("base64"), "image/jpeg");
    }) as unknown as typeof fetch;
    const images = new GeminiImage({ apiKey: "k", fetchImpl });
    const file = await images.generate("un phare", path.join(os.tmpdir(), `img-${Date.now()}`));
    expect(file.endsWith(".jpg")).toBe(true);
    expect(sent.response_format.aspect_ratio).toBe("9:16");
    fs.rmSync(file);
  });

  it("reports API errors and missing output", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 })) as unknown as typeof fetch;
    await expect(new GeminiTts({ apiKey: "bad", fetchImpl }).synthesize("x", "/tmp/x.wav")).rejects.toThrow(/API key not valid/);
    expect(() => lastOutputBlock({ steps: [] }, "audio")).toThrow(/no audio/);
  });

  it("asks for the scene's visual description without text in the image", () => {
    const prompt = imagePrompt("Les abeilles", { narration: "…", visual: "une abeille qui danse sur un rayon" });
    expect(prompt).toContain("une abeille qui danse sur un rayon");
    expect(prompt).toContain("no text");
  });
});
