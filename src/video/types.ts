/**
 * Video Production Types
 *
 * A video starts as a VideoScript (written by the agent or by hand), is
 * rendered locally into a vertical MP4, and lands in a review queue. Nothing
 * in this module publishes anywhere: a human reviews every video.
 */

export interface VideoScene {
  /** Text read aloud by the voice. */
  narration: string;
  /** Short headline shown large in the middle of the screen. */
  onScreen?: string;
}

export interface VideoScript {
  title: string;
  /** Niche or theme, used to keep each account on a distinct subject. */
  niche: string;
  /** BCP-47 language code of the narration (default "fr"). */
  language?: string;
  scenes: VideoScene[];
  /** Caption proposed for the post. */
  caption?: string;
  hashtags?: string[];
}

export type VideoStatus = "pending_review" | "approved" | "rejected";

export interface VideoCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VideoManifest {
  id: string;
  title: string;
  niche: string;
  status: VideoStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewNote?: string;
  durationSec: number;
  /** Money spent producing this video, in cents. Local tools cost 0. */
  costCents: number;
  /** Every video carries a visible "AI-generated" label (EU AI Act art. 50). */
  aiLabel: string;
  voice: string;
  checks: VideoCheck[];
  caption?: string;
  hashtags?: string[];
}

export interface RenderOptions {
  width?: number;
  height?: number;
  fps?: number;
  fontPath?: string;
  /** Visible label burned into every frame. */
  aiLabel?: string;
}

/** TikTok Creator Rewards only counts videos longer than one minute. */
export const MIN_DURATION_SEC = 61;
/** Narration overlap above this ratio counts as a near-duplicate. */
export const MAX_SIMILARITY = 0.5;
export const DEFAULT_AI_LABEL = "Contenu généré par IA";
