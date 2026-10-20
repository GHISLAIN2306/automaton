/**
 * Text-to-Speech
 *
 * The default provider is espeak-ng, local and free. With the MBROLA French
 * voices installed (mbrola-fr4) it sounds noticeably more natural, so it is
 * preferred when available. Paid voices can be added behind the same
 * interface later, once a real budget is approved.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

export interface TtsProvider {
  readonly name: string;
  /** Cost of synthesizing `text`, in cents. */
  costCents(text: string): number;
  synthesize(text: string, outWav: string): Promise<void>;
}

const MBROLA_VOICES: Record<string, string> = { fr: "mb-fr4", en: "mb-en1" };

export class EspeakTts implements TtsProvider {
  readonly name: string;

  constructor(
    private readonly voice: string,
    private readonly wordsPerMinute = 155,
  ) {
    this.name = `espeak-ng:${voice}`;
  }

  costCents(): number {
    return 0;
  }

  async synthesize(text: string, outWav: string): Promise<void> {
    await run("espeak-ng", ["-v", this.voice, "-s", String(this.wordsPerMinute), "-w", outWav, text]);
  }
}

/** Pick the best free voice installed for `language`. */
export async function createDefaultTts(language = "fr"): Promise<TtsProvider> {
  const lang = language.split("-")[0].toLowerCase();
  const mbrola = MBROLA_VOICES[lang];
  if (mbrola && (await voiceWorks(mbrola))) return new EspeakTts(mbrola);
  return new EspeakTts(lang);
}

async function voiceWorks(voice: string): Promise<boolean> {
  try {
    await run("espeak-ng", ["-v", voice, "-q", "test"]);
    return true;
  } catch {
    return false;
  }
}
