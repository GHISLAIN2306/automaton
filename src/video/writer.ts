/**
 * Script Writer
 *
 * Asks a Gemini text model for the next video of the niche: a new subject
 * (never one of the earlier titles), 6 to 8 scenes, a caption and hashtags.
 * The result goes through validateScript and the near-duplicate check like
 * any hand-written script.
 */

import { interact, outputText, type GeminiOptions } from "./gemini.js";
import { validateScript } from "./review.js";
import type { VideoScript } from "./types.js";

/** Narration length for 75 to 100 s of French speech (about 14 characters per second). */
export const MIN_NARRATION_CHARS = 1050;
export const MAX_NARRATION_CHARS = 1450;
export const MAX_SCENES = 8;

export const DEFAULT_NICHE =
  "Vulgarisation en français : sciences, nature, animaux, patrimoine et prouesses d'ingénierie, " +
  "racontés comme une petite histoire surprenante et rigoureusement exacte";

export interface WriteScriptOptions extends GeminiOptions {
  niche?: string;
  /** Imposed subject, for a manual run. */
  topic?: string;
  /** Titles already made, so the model picks something new. */
  pastTitles?: string[];
  /** Titles refused in this run (too close to an earlier video). */
  rejectedTitles?: string[];
}

export function scriptPrompt(options: WriteScriptOptions): string {
  const niche = options.niche || DEFAULT_NICHE;
  const past = options.pastTitles ?? [];
  const rejected = options.rejectedTitles ?? [];
  return [
    `Tu écris le script d'une vidéo verticale courte (70 à 100 secondes) pour une chaîne de ${niche}.`,
    options.topic
      ? `Sujet imposé : ${options.topic}.`
      : "Choisis toi-même un sujet précis, concret et étonnant, qui donne envie de regarder jusqu'au bout.",
    past.length
      ? `Sujets déjà traités, à ne pas reprendre ni paraphraser :\n${past.map((t) => `- ${t}`).join("\n")}`
      : "",
    rejected.length ? `Sujets refusés car trop proches d'une vidéo existante :\n${rejected.map((t) => `- ${t}`).join("\n")}` : "",
    "",
    "Règles :",
    "- Uniquement des faits vérifiables et largement admis. Pas de chiffres inventés, pas de légendes présentées comme vraies.",
    "- La première scène est une accroche forte (une question ou un fait surprenant), la dernière conclut et invite à s'abonner en une phrase.",
    `- Entre 6 et ${MAX_SCENES} scènes. Narration totale entre ${MIN_NARRATION_CHARS} et ${MAX_NARRATION_CHARS} caractères, phrases courtes, ton chaleureux, en français.`,
    "- onScreen : 2 à 5 mots en majuscules pour l'écran.",
    "- visual : description en anglais d'une image photoréaliste qui illustre exactement la scène, sans texte ni personne célèbre identifiable.",
    "- caption : 1 à 2 phrases pour la publication, sans hashtag.",
    "- hashtags : 4 à 6 mots-clés sans le #.",
    "",
    "Réponds uniquement avec un objet JSON de cette forme :",
    '{"title": "...", "scenes": [{"narration": "...", "onScreen": "...", "visual": "..."}], "caption": "...", "hashtags": ["..."]}',
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** First JSON object in a model answer (tolerates ```json fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Script writer returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

export function checkScriptShape(script: VideoScript): void {
  const chars = script.scenes.reduce((n, s) => n + s.narration.length, 0);
  if (script.scenes.length > MAX_SCENES) throw new Error(`Script has ${script.scenes.length} scenes (max ${MAX_SCENES})`);
  if (chars < MIN_NARRATION_CHARS) throw new Error(`Narration too short (${chars} characters, video would be under a minute)`);
  if (chars > MAX_NARRATION_CHARS * 1.2) throw new Error(`Narration too long (${chars} characters)`);
}

export async function writeScript(options: WriteScriptOptions): Promise<VideoScript> {
  const resp = await interact(
    {
      model: options.model ?? "gemini-3.8-flash",
      input: scriptPrompt(options),
    },
    options,
  );
  const raw = extractJson(outputText(resp)) as Record<string, unknown>;
  const script = validateScript({ ...raw, niche: options.niche || DEFAULT_NICHE, language: "fr" });
  checkScriptShape(script);
  return script;
}
