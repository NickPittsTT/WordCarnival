import * as Speech from 'expo-speech';
import type { ChildSettings, SpeechRequest } from '../types';
import { resolvePieceAudio } from './pieces';

/**
 * Single-flight speech pipeline (Phase 1 test: "rapid taps never play stale or
 * overlapping speech").
 *
 * Rules implemented here:
 *  - Only ONE utterance is ever in flight; a new speak() discards anything
 *    queued behind it (we keep no backlog at all).
 *  - If something is playing: stop(), wait ~220 ms (device voices need a beat
 *    to release), then speak.
 *  - Rate floor 0.6 ("slower" = 0.75, "normal" = 1.0). Never lower.
 *  - Graceful degradation: any TTS failure resolves quietly so the UI keeps
 *    showing the text instead of crashing.
 */

const STOP_GAP_MS = 220;
const RATE_NORMAL = 1.0;
const RATE_SLOWER = 0.75;
const RATE_FLOOR = 0.6;

export function clampRate(r: number): number {
  if (!Number.isFinite(r)) return RATE_NORMAL;
  return Math.max(RATE_FLOOR, Math.min(1.0, r));
}

export function rateFor(settings?: Partial<ChildSettings> | null): number {
  return clampRate(settings?.rate === 'slower' ? RATE_SLOWER : RATE_NORMAL);
}

type Speaker = typeof Speech;

export class SpeechQueue {
  private speaking = false;
  private gen = 0; // generation token: stale callbacks are discarded
  private settings: Partial<ChildSettings> = {};
  /** Injectable for tests; defaults to expo-speech. */
  constructor(private engine: Speaker = Speech) {}

  setSettings(s: Partial<ChildSettings>) {
    this.settings = s;
  }

  /** Immediately silence everything and drop any pending start. */
  stopAll() {
    this.gen++;
    this.speaking = false;
    try {
      this.engine.stop();
    } catch {
      /* never crash on audio errors */
    }
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Speak a unified request (word/sentence/phrase go to TTS; pieces route through clips). */
  async speak(req: SpeechRequest): Promise<void> {
    const myGen = ++this.gen; // discard anything queued before this tap
    if (this.speaking) {
      try {
        this.engine.stop();
      } catch {
        /* ignore */
      }
      await delay(STOP_GAP_MS);
    }
    if (myGen !== this.gen) return; // a newer request superseded us while waiting

    if (req.type === 'piece') {
      const resolved = resolvePieceAudio(req);
      if (resolved.mode === 'clip') {
        // Phase 4 wires real clip playback; until then fall back below.
        await this.tts(resolved.ttsText || req.fallbackWord, myGen);
        return;
      }
      await this.tts(resolved.ttsText ?? req.fallbackWord, myGen);
      return;
    }

    const text = req.type === 'word' ? req.word : req.text;
    await this.tts(text, myGen);
  }

  private tts(text: string, myGen: number): Promise<void> {
    return new Promise((resolve) => {
      if (!text) return resolve();
      this.speaking = true;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (myGen === this.gen) this.speaking = false;
        resolve();
      };
      try {
        this.engine.speak(text, {
          language: 'en-TT',
          voice: this.settings.voiceURI,
          rate: rateFor(this.settings),
          onDone: done,
          onError: done, // graceful degradation: show text, don't block the child
        });
      } catch {
        done();
      }
    });
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** App-wide singleton used by screens. */
export const speech = new SpeechQueue();
