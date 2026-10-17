import type { ContentItemRow, ContentSetRow, ParsedWordItem, WordPayload } from '../types';
import { parseWordLine } from './parse';

/**
 * Content loader: turns the bundled worksheet text into permanent-ID rows for
 * content_set / content_item. Adding words later means adding rows, not code.
 * IDs are deterministic (slug-based) so progress survives app updates and can
 * be re-seeded idempotently.
 */

export interface BundledContent {
  sets: ContentSetRow[];
  items: ContentItemRow[];
}

const SET_DEFS: Array<{ slug: string; name: string }> = [
  { slug: 'pre-primer', name: 'Pre-Primer' },
  { slug: 'primer', name: 'Primer' },
  { slug: 'first-grade', name: '1st Grade' },
  { slug: 'second-grade', name: '2nd Grade' },
  { slug: 'third-grade', name: '3rd Grade' },
];

export function wordItemId(setSlug: string, word: string): string {
  const slug = word
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `dolch:${setSlug}:${slug}`;
}

/** Parse the raw worksheet source into versioned content rows. */
export function buildContentFromSource(raw: string, version = 1): BundledContent {
  const sets: ContentSetRow[] = [];
  const items: ContentItemRow[] = [];
  let current: { slug: string; name: string } | null = null;
  const seenIds = new Set<string>();

  SET_DEFS.forEach((def, i) => {
    sets.push({ id: `dolch-set:${def.slug}`, subject: 'words', name: def.name, sort_order: i + 1 });
  });

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('## ')) {
      const title = t.slice(3).replace(/\s*\(\d+\)\s*$/, '').trim();
      current = SET_DEFS.find((d) => d.name === title) ?? null;
      if (!current) throw new Error(`Unknown content set header: "${t}"`);
      continue;
    }
    if (!current) throw new Error(`Content line before any set header: "${t}"`);
    const parsed = parseWordLine(t);
    const id = wordItemId(current.slug, parsed.word);
    if (seenIds.has(id)) throw new Error(`Duplicate word id: ${id}`);
    seenIds.add(id);
    const payload: WordPayload = { word: parsed.word, pieces: parsed.pieces, sentence: parsed.sentence };
    items.push({
      id,
      set_id: `dolch-set:${current.slug}`,
      type: 'word',
      payload_json: JSON.stringify(payload),
      version,
    });
  }
  return { sets, items };
}

/** Re-hydrate a stored content_item row into a usable word item. */
export function decodeWordItem(row: ContentItemRow): ParsedWordItem {
  const p = JSON.parse(row.payload_json) as WordPayload;
  return { id: row.id, setId: row.set_id, word: p.word, pieces: p.pieces, sentence: p.sentence, version: row.version };
}

/** Fill "{name}" placeholders with the child's first name. */
export function fillName(sentence: string, name: string): string {
  return sentence.replace(/\{name\}/g, name);
}
