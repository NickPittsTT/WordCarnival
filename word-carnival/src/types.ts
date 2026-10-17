/**
 * Word Carnival — shared domain types.
 *
 * Content is data (principle 10): words live in versioned content tables and
 * progress references content only by permanent ID (architecture rule 4).
 */

export type Subject = 'words' | 'phonics' | 'maths' | 'grammar' | 'science';

/** How a sound piece should be produced. Derived from the worksheet markup. */
export type PieceKind =
  | 'plain' //   spellable piece, no heart; clip or TTS fallback
  | 'heart' //    tricky piece (*mark); clip or caption/key-word fallback
  | 'quiet' //    silent letter (=quiet); never spoken, caption only
  | 'say'; //    explicit text to speak (=!text)

/** One parsed sound piece of a word ("heart word" chunking). */
export interface SoundPiece {
  /** Grapheme as written, e.g. "ai", "'". Leading `*` stripped. */
  text: string;
  /** True when the source marked this piece with `*` (the "heart" part). */
  tricky: boolean;
  /** `=x` pronunciation hint, e.g. "eh", "eye", "oh". Undefined for plain pieces. */
  soundsLike?: string;
  /** Resolved production strategy. */
  kind: PieceKind;
  /** For kind==='say': the exact sentence to speak (never invented spellings). */
  sayText?: string;
}

/** Payload stored in content_item.payload_json for type='word'. */
export interface WordPayload {
  word: string;
  pieces: SoundPiece[];
  sentence: string; // may contain "{name}" placeholders
}

export interface ContentSetRow {
  id: string;
  subject: Subject;
  name: string;
  sort_order: number;
}

export interface ContentItemRow {
  id: string;
  set_id: string;
  type: string; // 'word' | future module types
  payload_json: string;
  version: number;
}

export interface ParsedWordItem {
  id: string;
  setId: string;
  word: string;
  pieces: SoundPiece[];
  sentence: string;
  version: number;
}

/** Rating levels (parent-controlled mastery — principle 6). */
export const RATINGS = ['Not rated', 'Struggled', 'Kinda got it', 'Did well', 'Got it!'] as const;
export type RatingLevel = 0 | 1 | 2 | 3 | 4;

/** Learning piles derived from ratings + recency (principle 3). */
export type Pile = 'learning' | 'practice' | 'gotit' | 'unrated';

export interface ChildRow {
  id: string;
  parent_id: string;
  first_name: string;
  avatar: string;
  created_at: string;
  settings_json: string;
}

export interface ChildSettings {
  voiceURI?: string;
  rate: 'normal' | 'slower';
  reducedMotion?: boolean;
}

export interface AttemptRow {
  id: string;
  child_id: string;
  item_id: string;
  game: string;
  correct: boolean;
  first_try: boolean;
  helped: boolean;
  created_at: string;
  device_id: string;
  synced: number; // local queue flag: 0 = not yet pushed to backend
}

export interface RatingRow {
  child_id: string;
  item_id: string;
  level: RatingLevel;
  updated_at: string;
}

export interface RewardRow {
  child_id: string;
  stars: number;
  stickers_json: string;
}

/** Unified audio request used by the speech pipeline. */
export type SpeechRequest =
  | { type: 'word'; word: string }
  | { type: 'sentence'; text: string }
  | { type: 'phrase'; text: string } // safe literal text (captions read aloud)
  | {
      type: 'piece';
      /** Registry key for the recorded clip of this distinct piece, e.g. "ai". */
      pieceKey: string;
      /** Grapheme as displayed on the tile, e.g. "ai", "'". */
      label: string;
      /** `=x` hint if present, e.g. "eh". */
      soundsLike?: string;
      /** True when hint was `=quiet` — never speak it. */
      silent?: boolean;
      /** Authored literal sentence from `=!text` markup. */
      sayText?: string;
      /** The whole word this piece belongs to (used for key-word lookup / final fallback). */
      fallbackWord: string;
    };

/** Convenience: build a piece request from a parsed SoundPiece + its word. */
export function pieceRequest(piece: SoundPiece, word: string): SpeechRequest {
  return {
    type: 'piece',
    pieceKey: piece.text.toLowerCase(),
    label: piece.text,
    soundsLike: piece.soundsLike && piece.soundsLike !== 'quiet' && !piece.soundsLike.startsWith('!') ? piece.soundsLike : undefined,
    silent: piece.kind === 'quiet',
    sayText: piece.sayText,
    fallbackWord: word,
  };
}
