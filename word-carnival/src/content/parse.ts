import type { SoundPiece } from '../types';

/**
 * Pronunciation hints that are real English words (or safe literal text) a
 * device voice CAN say. Anything else must never reach the speech engine —
 * this is what guarantees "no invented spellings reach TTS" (Phase 1 test).
 */
export const SAFE_HINTS: ReadonlySet<string> = new Set([
  'uh', 'oh', 'oo', 'ee', 'eye', 'ay', 'ow', 'aw', 'air', 'ear', 'ar', 'er', 'or',
  'eh', 'ih', 'yoo', 'wun', 'too', 'huh', 'vuh', 'sss', 'zz', 'ul', 'wuh', 'arf',
]);

/**
 * Key words for sounding-out fallbacks (spec section 8). One short recorded
 * clip per distinct piece is the end state; until a clip exists we speak the
 * KEY WORD through TTS (never the bare letter/piece).
 */
export const KEY_WORDS: Readonly<Record<string, string>> = {
  b: 'bat', c: 'cat', d: 'dog', f: 'fan', g: 'gum', h: 'hat', j: 'jam', k: 'kite',
  l: 'leg', m: 'man', n: 'net', p: 'pig', r: 'run', s: 'sun', t: 'tap', v: 'van',
  w: 'wet', y: 'yes', z: 'zoo',
  wh: 'when', sh: 'ship', ch: 'chip',
  // 'th' defaults to "this"; thin/thank family uses "thin" (see thKeyWordFor)
  a: 'apple', e: 'egg', i: 'insect', o: 'on', u: 'up',
  // end sounds
  x: 'fox', ck: 'duck', ng: 'ring', nk: 'pink',
};

/** Words whose "th" is the voiced /ð/ → "this"; the rest → unvoiced /θ/ → "thin". */
const VOICED_TH = new Set(['the', 'this', 'that', 'these', 'those', 'them', 'then', 'there', 'their', 'they', 'than']);

export function thKeyWordFor(word: string): string {
  return VOICED_TH.has(word.toLowerCase()) ? 'this' : 'thin';
}

/**
 * Key word for a grapheme when no recording exists. Returns null when there is
 * no safe single key word (multi-letter blends without an entry) — the caller
 * then speaks the whole word instead.
 */
export function keyWordFor(pieceText: string, word: string): string | null {
  const g = pieceText.toLowerCase();
  if (g === 'th') return thKeyWordFor(word);
  const kw = KEY_WORDS[g];
  if (kw) return kw;
  // Doubled letters map to their single-sound key word ("ll" → leg, "ss" → sun).
  if (g.length === 2 && g[0] === g[1] && KEY_WORDS[g[0]]) return KEY_WORDS[g[0]];
  // Vowel teams & other digraphs with no key word: no safe short clip.
  return null;
}

/** Caption shown on a heart tile, e.g. `ai says "eh"`. */
export function pieceCaption(text: string, soundsLike?: string): string {
  if (soundsLike === 'quiet') return `Silent ${text}. It makes no sound, but it makes the other vowel say its name.`;
  if (soundsLike && soundsLike.startsWith('!')) return soundsLike.slice(1);
  if (soundsLike) return `${text} says "${soundsLike}"`;
  return `says ${text}`;
}

/**
 * Parse one raw piece token from the worksheet notation.
 * Grammar:  [*] grapheme [ "=" hint ]
 *   *        → tricky (heart) piece
 *   =quiet   → silent letter, never spoken
 *   =!text   → speak this literal sentence instead
 *   =x       → sounds like x
 */
export function parsePieceToken(rawToken: string): SoundPiece {
  const token = rawToken.trim();
  if (!token) throw new Error(`Empty sound piece in content`);
  const tricky = token.startsWith('*');
  const body = tricky ? token.slice(1) : token;
  const eq = body.indexOf('=');
  let text = body;
  let soundsLike: string | undefined;
  if (eq >= 0) {
    text = body.slice(0, eq);
    soundsLike = body.slice(eq + 1);
  }
  if (!text) throw new Error(`Sound piece missing grapheme: "${rawToken}"`);

  let kind: SoundPiece['kind'] = tricky ? 'heart' : 'plain';
  let sayText: string | undefined;
  if (soundsLike === 'quiet') {
    kind = 'quiet';
  } else if (soundsLike && soundsLike.startsWith('!')) {
    kind = 'say';
    sayText = soundsLike.slice(1).trim();
  }

  return { text, tricky, soundsLike, kind, sayText };
}

/** Split the pieces field of a worksheet line ("c|*o=uh|m|*e=quiet"). */
export function parsePiecesField(piecesField: string): SoundPiece[] {
  const tokens = piecesField.split('|');
  if (tokens.length === 0) throw new Error('No sound pieces');
  return tokens.map(parsePieceToken);
}

export interface ParsedWordLine {
  word: string;
  pieces: SoundPiece[];
  sentence: string;
}

/**
 * Parse a full worksheet line:  word | pieces | sentence
 * Top-level fields are separated by " | " (space-pipe-space); pieces inside
 * field 2 use bare "|". The apostrophe piece of don't relies on this rule.
 */
export function parseWordLine(line: string): ParsedWordLine {
  const parts = line.split(' | ');
  if (parts.length !== 3) {
    throw new Error(`Malformed content line (expected 3 fields): "${line}"`);
  }
  const word = parts[0].trim();
  const pieces = parsePiecesField(parts[1].trim());
  const sentence = parts[2].trim();
  if (!word) throw new Error(`Missing word in line: "${line}"`);
  if (!sentence) throw new Error(`Missing sentence for "${word}"`);
  // Heart-piece check: joined graphemes must reconstruct the word.
  const joined = pieces.map((p) => p.text).join('').toLowerCase();
  const clean = word.toLowerCase().replace(/[^a-z']/g, '');
  if (joined !== clean) {
    throw new Error(`Pieces "${joined}" do not spell word "${clean}" (${word})`);
  }
  return { word, pieces, sentence };
}
