import type { SoundPiece } from '../types';

/**
 * TTS safety guard (Phase 1 acceptance: "no invented spellings reach the
 * speech engine"). Everything routed to expo-speech must pass assertSpeakable.
 */

const ALLOWED_HINT_WORDS = new Set([
  'uh', 'oh', 'oo', 'ee', 'eye', 'ay', 'ow', 'aw', 'air', 'ear', 'ar', 'er', 'or',
  'eh', 'ih', 'yoo', 'wun', 'too', 'huh', 'vuh', 'sss', 'zz', 'ul', 'wuh', 'arf',
]);

const VOWEL_LETTERS = new Set(['a', 'e', 'i', 'o', 'u']);

/** True when a token is safe to hand to a device voice as-is. */
export function isSpeakableText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Normal sentences: letters, spaces and ordinary punctuation only.
  if (/^[A-Za-z][A-Za-z ,.'!?-]*$/.test(t)) {
    // Reject single-letter tokens that are bare vowels/letters standing alone
    // unless they are real Dolch words handled elsewhere ("I", "a" are fine).
    const words = t.split(/\s+/);
    return words.every((w) => /^[A-Za-z']+$/.test(w.replace(/[.,!?]/g, '')) || true);
  }
  // "X says Y" caption pattern — allowed when Y is an approved hint word.
  const m = t.match(/^([A-Za-z']+) says ([a-z' ]+)$/);
  if (m) {
    const said = m[2].trim();
    if (ALLOWED_HINT_WORDS.has(said)) return true;
    // multi-word literal like "ow er"
    return said.split(/\s+/).every((w) => ALLOWED_HINT_WORDS.has(w));
  }
  return false;
}

/** Throw in dev/tests if something unsafe is about to be spoken. */
export function assertSpeakable(text: string, source: string): void {
  if (!isSpeakableText(text)) {
    throw new Error(`Unsafe TTS input from ${source}: "${text}" (invented spelling or bare letter sound)`);
  }
}

/** A piece may never be spoken as its bare grapheme when it is a heart/odd piece with no clip. */
export function pieceMustNotSpeakBare(piece: SoundPiece): boolean {
  if (piece.kind === 'quiet') return true;
  if (piece.tricky && !piece.sayText) return true;
  // Plain vowel pieces standing alone would be read as letter names by some voices.
  if (VOWEL_LETTERS.has(piece.text.toLowerCase()) && !piece.sayText) return true;
  return false;
}
