/**
 * Gemini Providers
 *
 * Natural narration (Gemini 3.8 Flash TTS) and scene illustrations (Nano
 * Banana 2.1) through the Gemini Interactions API. Both need GEMINI_API_KEY
 * and cost real money, so every call reports its cost for the budget checks.
 *
 * Prices (Gemini API pricing page, Oct 2026, paid tier):
 *   - gemini-3.8-flash-tts: $0.00225 per 10 s of audio until 31 Dec 2026,
 *     then $0.0045. A free tier exists for this model.
 *   - gemini-nano-banana-2.1: $0.0336 per 1K image. No free tier.
 */

import fs from "fs";
import type { TtsProvider } from "./tts.js";
import type { ImageProvider } from "./types.js";

const API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** French speech averages roughly 14 characters per second. */
const CHARS_PER_SECOND = 14;

interface ContentBlock {
  type?: string;
  data?: string;
  mime_type?: string;
}

interface InteractionResponse {
  steps?: Array<{ type?: string; content?: ContentBlock[] }>;
  error?: { message?: string };
}

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function interact(body: unknown, options: GeminiOptions): Promise<InteractionResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resp = await fetchImpl(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
  });
  const text = await resp.text();
  let json: InteractionResponse;
  try {
    json = JSON.parse(text) as InteractionResponse;
  } catch {
    throw new Error(`Gemini API returned HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  if (!resp.ok) throw new Error(`Gemini API error (HTTP ${resp.status}): ${json.error?.message ?? text.slice(0, 200)}`);
  return json;
}

/** Last block of `type` in the model output steps. */
export function lastOutputBlock(resp: InteractionResponse, type: "audio" | "image"): ContentBlock {
  const blocks = (resp.steps ?? [])
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === type && typeof c.data === "string");
  const block = blocks[blocks.length - 1];
  if (!block) throw new Error(`Gemini API response contained no ${type}`);
  return block;
}

export class GeminiTts implements TtsProvider {
  readonly name: string;
  private readonly model: string;

  constructor(
    private readonly options: GeminiOptions & { voice?: string; style?: string },
  ) {
    this.model = options.model ?? "gemini-3.8-flash-tts";
    this.name = `${this.model}:${options.voice ?? "Charon"}`;
  }

  costCents(text: string): number {
    const seconds = text.length / CHARS_PER_SECOND;
    return (seconds / 10) * 0.225;
  }

  async synthesize(text: string, outWav: string): Promise<void> {
    const resp = await interact(
      {
        model: this.model,
        input: [
          {
            type: "user_input",
            content: [
              {
                type: "text",
                text,
                annotations: [
                  {
                    type: "speech_metadata",
                    style: this.options.style ?? "documentary narrator, calm, warm and engaging, natural French",
                  },
                ],
              },
            ],
          },
        ],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: this.options.voice ?? "Charon" }] },
      },
      this.options,
    );
    fs.writeFileSync(outWav, Buffer.from(lastOutputBlock(resp, "audio").data!, "base64"));
  }
}

export class GeminiImage implements ImageProvider {
  readonly name: string;
  private readonly model: string;

  constructor(private readonly options: GeminiOptions) {
    this.model = options.model ?? "gemini-nano-banana-2.1";
    this.name = this.model;
  }

  costCents(): number {
    return 3.36;
  }

  async generate(prompt: string, outBase: string): Promise<string> {
    const resp = await interact(
      {
        model: this.model,
        input: prompt,
        response_format: { type: "image", mime_type: "image/png", aspect_ratio: "9:16", image_size: "1K" },
      },
      this.options,
    );
    const block = lastOutputBlock(resp, "image");
    const ext = block.mime_type === "image/jpeg" ? "jpg" : "png";
    const file = `${outBase}.${ext}`;
    fs.writeFileSync(file, Buffer.from(block.data!, "base64"));
    return file;
  }
}

/** Prompt for one scene illustration: no text, so subtitles stay readable. */
export function imagePrompt(title: string, scene: { visual?: string; onScreen?: string; narration: string }): string {
  const subject = scene.visual ?? `${scene.onScreen ? `${scene.onScreen}. ` : ""}${scene.narration}`;
  return (
    `Vertical 9:16 photorealistic image illustrating a short educational video titled "${title}". ` +
    `Show exactly this: ${subject} ` +
    "Factually accurate, natural light, cinematic composition, no text, no letters, no captions, no watermark."
  );
}
