import type { SpeechRequest } from '../types';
import { SAFE_HINTS, keyWordFor, pieceCaption } from '../content/parse';

/**
 * Piece audio routing (principle 8): a computer voice cannot pronounce letter
 * sounds on their own, so sound pieces must come from recorded human clips.
 * Until a clip exists we NEVER feed an invented spelling to TTS — instead we
 * speak the KEY WORD ("ai says eh" caption + word "say") or show only text.
 */

export interface ResolvedPieceAudio {
  /** 'clip' = play recorded audio; 'tts' = safe literal text via TTS; 'caption' = text only. */
  mode: 'clip' | 'tts' | 'caption';
  /** Clip URI when mode==='clip'. */
  clipUri?: string;
  /** Exact literal text for TTS when mode==='tts' (always real words/sentences). */
  ttsText?: string;
  /** Caption shown on the tile regardless of audio mode. */
  caption: string;
}

/** Registry of downloaded/cached recordings, keyed by pieceKey. Populated in Phase 4. */
const clipRegistry = new Map<string, string>();

export function registerClip(pieceKey: string, uri: string) {
  clipRegistry.set(pieceKey, uri);
}

export function hasClip(pieceKey: string): boolean {
  return clipRegistry.has(pieceKey);
}

/** Normalised registry key for one distinct piece grapheme, e.g. "sh", "ai". */
export function pieceKeyOf(req: SpeechRequest & { type: 'piece' }): string {
  return req.pieceKey.toLowerCase();
}

/**
 * Decide how to produce audio for a tapped sound piece.
 * Fallback ladder:
 *   1. recorded clip                     → play it (Phase 4)
 *   2. explicit "=!text"                 → speak that literal sentence
 *   3. hint is a safe English word       → `"<label> says <hint>"`
 *   4. key word exists for the grapheme  → speak the key word alone
 *   5. otherwise                         → caption only (never invent spellings)
 */
export function resolvePieceAudio(req: SpeechRequest & { type: 'piece' }): ResolvedPieceAudio {
  const label = req.label; // grapheme as written, e.g. "ai"
  const caption = pieceCaption(label, req.soundsLike ?? (req.silent ? 'quiet' : undefined));
  const key = req.pieceKey.toLowerCase();

  const clip = clipRegistry.get(key);
  if (clip) return { mode: 'clip', clipUri: clip, caption };

  // kind==='say': sayText is authored literal text — safe for TTS.
  if (req.sayText) return { mode: 'tts', ttsText: req.sayText, caption };

  // Silent letters are never spoken at all.
  if (req.silent) return { mode: 'caption', caption };

  if (req.soundsLike && SAFE_HINTS.has(req.soundsLike)) {
    return { mode: 'tts', ttsText: `${label} says ${req.soundsLike}`, caption };
  }

  const kw = keyWordFor(label, req.fallbackWord);
  if (kw) return { mode: 'tts', ttsText: kw, caption };

  // No recording, no safe route: show the caption and speak the whole word
  // (whole words ARE allowed through TTS per spec section 8).
  return { mode: 'tts', ttsText: req.fallbackWord, caption };
}
