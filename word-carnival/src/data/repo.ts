import type {
  AttemptRow, ChildRow, ChildSettings, ContentItemRow, ContentSetRow, ParsedWordItem,
  Pile, RatingLevel, RatingRow,
} from '../types';
import type { DbDriver } from '../db/schema';
import { buildContentFromSource, decodeWordItem } from '../content/loader';

/**
 * Repository: the ONLY place that touches SQL. Screens/games go through this.
 * Local-first: every write lands in SQLite immediately; sync (Phase 3) later
 * pushes the `synced = 0` rows.
 */

export function todayLocal(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic-ish id helper (crypto.randomUUID is available on Hermes RN 0.81+; fall back). */
export function makeId(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

export class Repo {
  constructor(private db: DbDriver) {}

  // ---------------- content ----------------

  /** Idempotent seed of bundled content. Re-running updates changed rows by version. */
  async seedContent(rawWorksheet: string, version = 1): Promise<{ sets: number; items: number }> {
    const { sets, items } = buildContentFromSource(rawWorksheet, version);
    for (const s of sets) {
      await this.db.runAsync(
        `INSERT INTO content_set (id, subject, name, sort_order) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET subject=excluded.subject, name=excluded.name, sort_order=excluded.sort_order`,
        [s.id, s.subject, s.name, s.sort_order],
      );
    }
    for (const it of items) {
      await this.db.runAsync(
        `INSERT INTO content_item (id, set_id, type, payload_json, version) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET set_id=excluded.set_id, type=excluded.type, payload_json=excluded.payload_json, version=excluded.version`,
        [it.id, it.set_id, it.type, it.payload_json, it.version],
      );
    }
    return { sets: sets.length, items: items.length };
  }

  async listSets(): Promise<ContentSetRow[]> {
    return this.db.getAllAsync<ContentSetRow>(`SELECT * FROM content_set ORDER BY sort_order`);
  }

  async getWord(id: string): Promise<ParsedWordItem | null> {
    const row = await this.db.getFirstAsync<ContentItemRow>(`SELECT * FROM content_item WHERE id = ?`, [id]);
    return row ? decodeWordItem(row) : null;
  }

  async wordsInSets(setIds: string[]): Promise<ParsedWordItem[]> {
    if (setIds.length === 0) return [];
    const ph = setIds.map(() => '?').join(', ');
    const rows = await this.db.getAllAsync<ContentItemRow>(
      `SELECT * FROM content_item WHERE set_id IN (${ph})`, setIds,
    );
    return rows.map(decodeWordItem);
  }

  // ---------------- children ----------------

  async createChild(input: { parentId: string; firstName: string; avatar?: string; settings?: ChildSettings }): Promise<ChildRow> {
    const child: ChildRow = {
      id: makeId('child'),
      parent_id: input.parentId,
      first_name: input.firstName.trim(),
      avatar: input.avatar ?? 'star',
      created_at: nowIso(),
      settings_json: JSON.stringify(input.settings ?? { rate: 'normal' }),
    };
    await this.db.runAsync(
      `INSERT INTO child (id, parent_id, first_name, avatar, created_at, settings_json) VALUES (?, ?, ?, ?, ?, ?)`,
      [child.id, child.parent_id, child.first_name, child.avatar, child.created_at, child.settings_json],
    );
    await this.db.runAsync(`INSERT INTO reward (child_id, stars, stickers_json) VALUES (?, 0, '[]')`, [child.id]);
    return child;
  }

  async listChildren(parentId: string): Promise<ChildRow[]> {
    return this.db.getAllAsync<ChildRow>(`SELECT * FROM child WHERE parent_id = ? ORDER BY created_at`, [parentId]);
  }

  async getChild(id: string): Promise<ChildRow | null> {
    return this.db.getFirstAsync<ChildRow>(`SELECT * FROM child WHERE id = ?`, [id]);
  }

  async updateChildSettings(childId: string, settings: ChildSettings): Promise<void> {
    await this.db.runAsync(`UPDATE child SET settings_json = ? WHERE id = ?`, [JSON.stringify(settings), childId]);
  }

  async getSettings(childId: string): Promise<ChildSettings> {
    const c = await this.getChild(childId);
    if (!c) return { rate: 'normal' };
    try { return { rate: 'normal', ...(JSON.parse(c.settings_json) as ChildSettings) }; }
    catch { return { rate: 'normal' }; }
  }

  /** Seed Kai's starting state or any explicit rating map (used by seeding + tests). */
  async setRating(childId: string, itemId: string, level: RatingLevel): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO rating (child_id, item_id, level, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (child_id, item_id) DO UPDATE SET level=excluded.level, updated_at=excluded.updated_at`,
      [childId, itemId, level, nowIso()],
    );
  }

  async getRating(childId: string, itemId: string): Promise<RatingLevel> {
    const r = await this.db.getFirstAsync<RatingRow>(
      `SELECT * FROM rating WHERE child_id = ? AND item_id = ?`, [childId, itemId],
    );
    return (r?.level ?? 0) as RatingLevel;
  }

  async ratingsForChild(childId: string): Promise<Map<string, RatingLevel>> {
    const rows = await this.db.getAllAsync<RatingRow>(`SELECT * FROM rating WHERE child_id = ?`, [childId]);
    return new Map(rows.map((r) => [r.item_id, r.level as RatingLevel]));
  }

  // ---------------- word sets (child_set) ----------------

  async setActiveSets(childId: string, setIds: string[]): Promise<void> {
    const all = await this.listSets();
    for (const s of all) {
      const active = setIds.includes(s.id) ? 1 : 0;
      await this.db.runAsync(
        `INSERT INTO child_set (child_id, set_id, active) VALUES (?, ?, ?)
         ON CONFLICT (child_id, set_id) DO UPDATE SET active=excluded.active`,
        [childId, s.id, active],
      );
    }
  }

  async activeSetIds(childId: string): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ set_id: string }>(
      `SELECT set_id FROM child_set WHERE child_id = ? AND active = 1`, [childId],
    );
    return rows.map((r) => r.set_id);
  }

  // ---------------- attempts / daily summary ----------------

  /** Append-only attempt write + daily rollup, in one call. Never edit/delete. */
  async recordAttempt(a: Omit<AttemptRow, 'id' | 'created_at' | 'device_id' | 'synced'> & { deviceId: string; createdAt?: string }): Promise<AttemptRow> {
    const row: AttemptRow = {
      id: makeId('att'),
      child_id: a.child_id,
      item_id: a.item_id,
      game: a.game,
      correct: a.correct,
      first_try: a.first_try,
      helped: a.helped,
      created_at: a.createdAt ?? nowIso(),
      device_id: a.deviceId,
      synced: 0,
    };
    await this.db.runAsync(
      `INSERT INTO attempt (id, child_id, item_id, game, correct, first_try, helped, created_at, device_id, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [row.id, row.child_id, row.item_id, row.game, boolNum(row.correct), boolNum(row.first_try), boolNum(row.helped), row.created_at, row.device_id],
    );
    const date = row.created_at.slice(0, 10);
    const existing = await this.db.getFirstAsync<{ right: number; tries: number }>(
      `SELECT * FROM daily_summary WHERE child_id = ? AND date = ? AND item_id = ?`, [row.child_id, date, row.item_id],
    );
    const right = (existing?.right ?? 0) + (row.correct ? 1 : 0);
    const tries = (existing?.tries ?? 0) + 1;
    if (existing) {
      await this.db.runAsync(`UPDATE daily_summary SET right = ?, tries = ? WHERE child_id = ? AND date = ? AND item_id = ?`,
        [right, tries, row.child_id, date, row.item_id]);
    } else {
      await this.db.runAsync(`INSERT INTO daily_summary (child_id, date, item_id, right, tries) VALUES (?, ?, ?, ?, ?)`,
        [row.child_id, date, row.item_id, right, tries]);
    }
    return row;
  }

  async unsyncedAttempts(): Promise<AttemptRow[]> {
    const rows = await this.db.getAllAsync<AttemptRow & { correct: number; first_try: number; helped: number }>(
      `SELECT * FROM attempt WHERE synced = 0 ORDER BY created_at`);
    return rows.map(fromBoolNums);
  }

  async markAttemptsSynced(ids: string[]): Promise<void> {
    for (const id of ids) await this.db.runAsync(`UPDATE attempt SET synced = 1 WHERE id = ?`, [id]);
  }

  /** Insert an attempt coming FROM the backend during sync-merge (append-only union). */
  async mergeRemoteAttempt(row: AttemptRow): Promise<boolean> {
    const before = await this.db.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count FROM attempt WHERE id = ?`, [row.id]);
    if (before && Number(before.count) > 0) return false; // already have it
    await this.db.runAsync(
      `INSERT INTO attempt (id, child_id, item_id, game, correct, first_try, helped, created_at, device_id, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [row.id, row.child_id, row.item_id, row.game, boolNum(row.correct), boolNum(row.first_try), boolNum(row.helped), row.created_at, row.device_id],
    );
    return true;
  }

  async attemptsForItem(childId: string, itemId: string): Promise<AttemptRow[]> {
    const rows = await this.db.getAllAsync<AttemptRow & { correct: number; first_try: number; helped: number }>(
      `SELECT * FROM attempt WHERE child_id = ? AND item_id = ? ORDER BY created_at`, [childId, itemId]);
    return rows.map(fromBoolNums);
  }

  // ---------------- rewards ----------------

  /** Stars are recomputed from attempts (spec §5): one star per first-try correct answer. */
  async recomputeStars(childId: string): Promise<number> {
    const rows = await this.db.getAllAsync<AttemptRow & { correct: number; first_try: number; helped: number }>(
      `SELECT * FROM attempt WHERE child_id = ?`, [childId]);
    const stars = rows.filter((r) => r.correct && r.first_try).length;
    const existing = await this.db.getFirstAsync<{ child_id: string }>(`SELECT * FROM reward WHERE child_id = ?`, [childId]);
    if (existing) await this.db.runAsync(`UPDATE reward SET stars = ? WHERE child_id = ?`, [stars, childId]);
    else await this.db.runAsync(`INSERT INTO reward (child_id, stars, stickers_json) VALUES (?, ?, '[]')`, [childId, stars]);
    return stars;
  }

  async getReward(childId: string): Promise<{ stars: number; stickers: string[] }> {
    const r = await this.db.getFirstAsync<{ stars: number; stickers_json: string }>(
      `SELECT * FROM reward WHERE child_id = ?`, [childId]);
    let stickers: string[] = [];
    try { stickers = JSON.parse(r?.stickers_json ?? '[]'); } catch { /* graceful */ }
    return { stars: r?.stars ?? 0, stickers };
  }

  /** Award a sticker when crossing each 10-star threshold; returns newly earned stickers. */
  async maybeAwardSticker(childId: string, stickerPool: string[]): Promise<string[]> {
    const stars = await this.recomputeStars(childId);
    const earnedCount = Math.floor(stars / 10);
    const cur = await this.getReward(childId);
    if (cur.stickers.length >= earnedCount) return [];
    const fresh: string[] = [];
    for (let i = cur.stickers.length; i < earnedCount; i++) {
      fresh.push(stickerPool[i % stickerPool.length]);
    }
    const next = [...cur.stickers, ...fresh];
    await this.db.runAsync(`UPDATE reward SET stickers_json = ? WHERE child_id = ?`, [JSON.stringify(next), childId]);
    return fresh;
  }

  // ---------------- piles (spaced recall, principle 3) ----------------

  /**
   * Learning pile: rating 1 → daily. Practise pile: rating 2 → every 2 days.
   * Got-it pile: rating ≥3 → weekly. Unrated (0) never auto-scheduled —
   * the parent decides mastery (principle 6).
   */
  async pileFor(childId: string, itemId: string): Promise<Pile> {
    const level = await this.getRating(childId, itemId);
    if (level === 0) return 'unrated';
    if (level === 1) return 'learning';
    if (level === 2) return 'practice';
    return 'gotit';
  }

  /** Due items across a child's active sets, weighted so unknown words come back sooner. */
  async dueItems(childId: string, opts: { maxLearning?: number; maxPractice?: number; maxGotIt?: number } = {}): Promise<ParsedWordItem[]> {
    const setIds = await this.activeSetIds(childId);
    const words = await this.wordsInSets(setIds);
    const ratings = await this.ratingsForChild(childId);
    const lastSeen = await this.lastAttemptDates(childId);
    const today = todayLocal();
    const dayDiff = (d?: string) => {
      if (!d) return Infinity;
      const ms = new Date(today + 'T00:00:00').getTime() - new Date(d + 'T00:00:00').getTime();
      return Math.floor(ms / 86400000);
    };
    const learning = words.filter((w) => (ratings.get(w.id) ?? 0) === 1);
    const practice = words.filter((w) => (ratings.get(w.id) ?? 0) === 2 && dayDiff(lastSeen.get(w.id)) >= 2);
    const gotit = words.filter((w) => (ratings.get(w.id) ?? 0) >= 3 && dayDiff(lastSeen.get(w.id)) >= 7);
    const out = [
      ...shufflePriority(learning, opts.maxLearning ?? 4),
      ...shufflePriority(practice, opts.maxPractice ?? 2),
      ...shufflePriority(gotit, opts.maxGotIt ?? 2),
    ];
    return out;
  }

  async lastAttemptDates(childId: string): Promise<Map<string, string>> {
    const rows = await this.db.getAllAsync<{ item_id: string; created_at: string }>(
      `SELECT * FROM attempt WHERE child_id = ? ORDER BY created_at`, [childId]);
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.item_id, r.created_at.slice(0, 10)); // ordered: last wins
    return map;
  }

  // ---------------- progress report ----------------

  async progressReport(childId: string, days = 7): Promise<{
    percentFirstTryRight: number; daysPlayed: number; needsWork: ParsedWordItem[]; gettingBetter: ParsedWordItem[]; byDay: { date: string; right: number; tries: number }[];
  }> {
    const attempts = (await this.db.getAllAsync<AttemptRow & { correct: number; first_try: number; helped: number }>(
      `SELECT * FROM attempt WHERE child_id = ? ORDER BY created_at`, [childId])).map(fromBoolNums);
    const firsts = attempts.filter((a) => a.first_try);
    const pct = firsts.length ? Math.round((firsts.filter((a) => a.correct).length / firsts.length) * 100) : 0;
    const dates = new Set(attempts.map((a) => a.created_at.slice(0, 10)));
    const byDayRows = await this.db.getAllAsync<{ date: string; right: number; tries: number }>(
      `SELECT * FROM daily_summary WHERE child_id = ?`, [childId]);
    const agg = new Map<string, { right: number; tries: number }>();
    for (const r of byDayRows) {
      const cur = agg.get(r.date) ?? { right: 0, tries: 0 };
      cur.right += Number(r.right); cur.tries += Number(r.tries);
      agg.set(r.date, cur);
    }
    const byDay = [...agg.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-days)
      .map(([date, v]) => ({ date, ...v }));
    const ratings = await this.ratingsForChild(childId);
    const setIds = await this.activeSetIds(childId);
    const words = await this.wordsInSets(setIds);
    const needsWork = words.filter((w) => (ratings.get(w.id) ?? 0) === 1);
    const gettingBetter = words.filter((w) => (ratings.get(w.id) ?? 0) === 2);
    return { percentFirstTryRight: pct, daysPlayed: dates.size, needsWork, gettingBetter, byDay };
  }

  // ---------------- start over (keeps attempt history) ----------------

  async startOver(childId: string): Promise<void> {
    await this.db.runAsync(`DELETE FROM rating WHERE child_id = ?`, [childId]);
    await this.db.runAsync(`UPDATE reward SET stars = 0, stickers_json = '[]' WHERE child_id = ?`, [childId]);
  }

  // ---------------- sound clips ----------------

  async upsertClip(piece: string, localUri: string, audioUrl?: string, recordedBy?: string): Promise<void> {
    const id = `clip:${piece.toLowerCase()}`;
    await this.db.runAsync(
      `INSERT INTO sound_clip (id, piece, audio_url, local_uri, recorded_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET audio_url=excluded.audio_url, local_uri=excluded.local_uri, recorded_by=excluded.recorded_by, updated_at=excluded.updated_at`,
      [id, piece.toLowerCase(), audioUrl ?? null, localUri, recordedBy ?? null, nowIso()],
    );
  }

  async listClips(): Promise<{ piece: string; local_uri: string | null; audio_url: string | null }[]> {
    return this.db.getAllAsync(`SELECT * FROM sound_clip ORDER BY piece`);
  }
}

// helpers -------------------------------------------------------------------

function boolNum(b: boolean): number { return b ? 1 : 0; }
function fromBoolNums(r: AttemptRow & { correct: number; first_try: number; helped: number }): AttemptRow {
  return { ...r, correct: r.correct === 1, first_try: r.first_try === 1, helped: r.helped === 1 };
}

/** Stable "round robin" ordering: least-recently-seen first, then deterministic shuffle. */
function shufflePriority<T extends { id: string }>(items: T[], max: number): T[] {
  const salted = items.map((it) => ({ it, k: hash(it.id + ':' + todayLocal()) }));
  salted.sort((a, b) => a.k - b.k);
  return salted.slice(0, max).map((s) => s.it);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
