import type { DbDriver, DbResult, SqlValue } from './schema';

/**
 * Minimal in-memory SQL engine for unit-testing the data layer WITHOUT native
 * modules. It understands exactly the statement shapes this app issues:
 *   CREATE TABLE/INDEX (no-ops), PRAGMA (no-op),
 *   INSERT OR REPLACE INTO t VALUES (?,...) / ON CONFLICT DO UPDATE SET x=excluded.x,
 *   INSERT INTO t ... ON CONFLICT DO NOTHING,
 *   SELECT <cols|COUNT(*)|exprs> FROM t [WHERE a=? AND b=? ...] [ORDER BY c [DESC]] [LIMIT n],
 *   UPDATE t SET col=? WHERE ..., DELETE FROM t WHERE ...
 * Anything unrecognised throws — so tests stay honest about coverage.
 */

interface Table {
  cols: string[];
  pk: string[];
  rows: Record<string, SqlValue>[];
}

export class MemoryDriver implements DbDriver {
  private tables = new Map<string, Table>();
  /** Log of every statement, handy for assertions. */
  readonly log: string[] = [];

  createTable(name: string, cols: string[], pk: string[] = []) {
    this.tables.set(name, { cols, pk, rows: [] });
  }

  seed(name: string, rows: Record<string, SqlValue>[]) {
    const t = this.mustTable(name);
    for (const r of rows) {
      if (!this.pkConflict(t, r)) t.rows.push({ ...r });
    }
  }

  private mustTable(name: string): Table {
    const t = this.tables.get(name);
    if (!t) throw new Error(`MemoryDriver: unknown table "${name}"`);
    return t;
  }

  private pkConflict(t: Table, row: Record<string, SqlValue>): boolean {
    if (t.pk.length === 0) return false;
    return t.rows.some((r) => t.pk.every((k) => r[k] === row[k]));
  }

  async execAsync(sql: string, params: SqlValue[] = []): Promise<void> {
    for (const stmt of splitStatements(sql)) await this.runOne(stmt, params);
  }
  async runAsync(sql: string, params: SqlValue[] = []): Promise<DbResult> {
    return this.runOne(sql, params);
  }
  async getAllAsync<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const r = await this.runOne(sql, params);
    return r.rows as T[];
  }
  async getFirstAsync<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    const r = await this.getAllAsync<T>(sql, params);
    return r[0] ?? null;
  }
  async closeAsync(): Promise<void> {}

  private runOne(sqlIn: string, params: SqlValue[]): DbResult {
    const sql = sqlIn.trim().replace(/\s+/g, ' ');
    this.log.push(sql);
    let pi = 0;
    const next = () => params[pi++];

    if (/^(PRAGMA|CREATE|DROP|BEGIN|COMMIT)/i.test(sql)) return { rows: [] };

    // ---- INSERT -----------------------------------------------------------
    // Structure-based parse: regexes cannot survive commas/quotes inside JSON
    // literals, so locate balanced parens by hand. splitCsv is quote-aware.
    {
      const im = sql.match(/^INSERT (OR REPLACE |OR IGNORE )?INTO (\w+) *\(/i);
      if (im) {
        const mode = im[1]?.trim() === 'OR IGNORE' ? 'ignore' : 'replace';
        const tableName = im[2];
        const colsOpen = (im.index ?? 0) + im[0].length - 1;
        const colsClose = matchBalanced(sql, colsOpen);
        const colsPart = sql.slice(colsOpen + 1, colsClose);
        const rest = sql.slice(colsClose + 1).trim();
        if (!/^VALUES *\(/i.test(rest)) throw new Error(`MemoryDriver: malformed INSERT: ${sql}`);
        const vOpen = colsClose + 1 + rest.indexOf('(');
        const vClose = matchBalanced(sql, vOpen);
        const valsRaw = splitCsv(sql.slice(vOpen + 1, vClose));
        let conflictClause = sql.slice(vClose + 1).trim();
        if (!/^ON CONFLICT/i.test(conflictClause)) conflictClause = '';
        const table = this.mustTable(tableName);
        const cols = splitCsv(colsPart);
        const row: Record<string, SqlValue> = {};
        cols.forEach((c, i) => {
          const token = valsRaw[i].trim();
          row[c] = token === '?' ? next() : coerceLiteral(token);
        });
        const conflict = this.pkConflict(table, row);
        if (conflict) {
          if (/DO NOTHING/i.test(conflictClause) || mode === 'ignore') return { rows: [], changes: 0 };
          if (/DO UPDATE/i.test(conflictClause)) {
            const setMatch = conflictClause.match(/DO UPDATE SET (.+)$/i);
            const target = table.rows.find((r) => table.pk.every((k) => r[k] === row[k]))!;
            if (setMatch) {
              for (const pair of splitCsv(setMatch[1])) {
                const [col, expr] = pair.split('=').map((x) => x.trim());
                const em = expr.match(/^excluded\.(\w+)$/i);
                target[col] = em ? row[em[1]] : target[col];
              }
            } else Object.assign(target, row);
            return { rows: [], changes: 1 };
          }
          const idx = table.rows.findIndex((r) => table.pk.every((k) => r[k] === row[k]));
          table.rows[idx] = { ...table.rows[idx], ...row };
          return { rows: [], changes: 1 };
        }
        table.rows.push(row);
        return { rows: [], insertId: table.rows.length, changes: 1 };
      }
    }

    // ---- UPDATE -----------------------------------------------------------
    let m = sql.match(/^UPDATE (\w+) SET ([^W]+?)(?: WHERE (.*))?$/i);
    if (m) {
      const table = this.mustTable(m[1]);
      const sets = splitCsv(m[2]).map((p) => { const [c, e] = p.split('=').map((x) => x.trim()); return [c, e] as [string, string]; });
      // SET params come first in SQLite param order, then WHERE params.
      const setVals = sets.map(([, expr]) => (expr === '?' ? next() : coerceLiteral(expr)));
      const pred = compileWhere(m[3], next);
      let changes = 0;
      for (const r of table.rows) {
        if (pred(r)) {
          sets.forEach(([col], i) => { r[col] = setVals[i]; });
          changes++;
        }
      }
      return { rows: [], changes };
    }

    // ---- DELETE -----------------------------------------------------------
    m = sql.match(/^DELETE FROM (\w+)(?: WHERE (.*))?$/i);
    if (m) {
      const table = this.mustTable(m[1]);
      const pred = compileWhere(m[2], next);
      const before = table.rows.length;
      table.rows = table.rows.filter((r) => !pred(r));
      return { rows: [], changes: before - table.rows.length };
    }

    // ---- SELECT -----------------------------------------------------------
    m = sql.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (.*?))?(?: ORDER BY (.*?))?(?: LIMIT (\d+))?$/i);
    if (m) {
      const table = this.mustTable(m[2]);
      const pred = compileWhere(m[3], next);
      let rows = table.rows.filter(pred);
      if (m[5]) {
        const limit = parseInt(m[5], 10);
        rows = rows.slice(0, limit);
      }
      const order = m[4];
      if (order) {
        const [colRaw, dirRaw] = order.split(' ');
        const col = colRaw.trim();
        const desc = /^desc$/i.test(dirRaw ?? '');
        rows = [...rows].sort((a, b) => {
          const av = a[col], bv = b[col];
          if (av === bv) return 0;
          if (av == null) return -1;
          if (bv == null) return 1;
          return (av < bv ? -1 : 1) * (desc ? -1 : 1);
        });
      }
      const proj = project(m[1], rows, table);
      return { rows: proj, changes: proj.length };
    }

    throw new Error(`MemoryDriver: unsupported statement: ${sql}`);
  }
}

function project(selectList: string, rows: Record<string, SqlValue>[], table: Table): Record<string, SqlValue>[] {
  const list = selectList.trim();
  if (list === '*') return rows.map((r) => ({ ...r }));
  // Support: COUNT(*), and simple column lists with optional aliases.
  const out: Record<string, SqlValue>[] = [];
  if (/count\(\*\)/i.test(list)) {
    out.push({ count: rows.length });
    return out;
  }
  for (const raw of splitCsv(list)) {
    const parts = raw.trim().split(/\s+(?:as|AS)\s+/);
    const col = parts[0];
    const alias = parts[1] ?? col;
    // fallthrough handled below per row
    for (let i = 0; i < rows.length; i++) {
      out[i] = out[i] ?? {};
      out[i][alias] = rows[i][col] ?? null;
    }
  }
  return out;
}

type Pred = (row: Record<string, SqlValue>) => boolean;

function compileWhere(clause: string | undefined, nextParam: () => SqlValue): Pred {
  if (!clause || !clause.trim()) return () => true;
  const conds = clause.split(/ AND /i).map((c) => {
    const m = c.trim().match(/^(\w+)\s*(=|!=|<>|>=|<=|>|<|\bIN\b|\bIS NOT NULL\b|\bIS NULL\b)\s*(.*)$/i);
    if (!m) throw new Error(`MemoryDriver: unsupported WHERE: ${c}`);
    const col = m[1];
    const op = m[2].toUpperCase();
    const rhs = m[3].trim();
    if (op === 'IS NULL') return (r: Record<string, SqlValue>) => r[col] == null;
    if (op === 'IS NOT NULL') return (r: Record<string, SqlValue>) => r[col] != null;
    if (op === 'IN') {
      const inner = rhs.replace(/^\(|\)$/g, '');
      const items = splitCsv(inner).map((t) => {
        const tok = t.trim();
        return tok === '?' ? nextParam() : coerceLiteral(tok);
      });
      return (r: Record<string, SqlValue>) => items.includes(r[col] as never);
    }
    const val = rhs === '?' ? nextParam() : coerceLiteral(rhs);
    return (r: Record<string, SqlValue>) => {
      const rv = r[col];
      switch (op) {
        case '=': return rv === val;
        case '!=': case '<>': return rv !== val;
        case '>': return (rv as number) > (val as number);
        case '<': return (rv as number) < (val as number);
        case '>=': return (rv as number) >= (val as number);
        case '<=': return (rv as number) <= (val as number);
        default: return false;
      }
    };
  });
  return (r) => conds.every((f) => f(r));
}

function coerceLiteral(tok: string): SqlValue {
  const t = tok.trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^(NULL)$/i.test(t)) return null;
  return t;
}

/** Index of the ')' matching the '(' at position `open`, quote-aware. */
function matchBalanced(sql: string, open: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === "'") { q = ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  throw new Error('MemoryDriver: unbalanced parentheses');
}

/** Split on commas that are not inside quotes or parens. */
function splitCsv(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Split multi-statement strings on ';' respecting quotes. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const ch of sql) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ';') { if (cur.trim()) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Register the schema tables/columns/PKs into a MemoryDriver (mirrors SCHEMA_SQL). */
export function installSchema(mem: MemoryDriver) {
  mem.createTable('meta', ['key', 'value'], ['key']);
  mem.createTable('content_set', ['id', 'subject', 'name', 'sort_order'], ['id']);
  mem.createTable('content_item', ['id', 'set_id', 'type', 'payload_json', 'version'], ['id']);
  mem.createTable('child', ['id', 'parent_id', 'first_name', 'avatar', 'created_at', 'settings_json'], ['id']);
  mem.createTable('child_set', ['child_id', 'set_id', 'active'], ['child_id', 'set_id']);
  mem.createTable('rating', ['child_id', 'item_id', 'level', 'updated_at'], ['child_id', 'item_id']);
  mem.createTable('attempt', ['id', 'child_id', 'item_id', 'game', 'correct', 'first_try', 'helped', 'created_at', 'device_id', 'synced'], ['id']);
  mem.createTable('daily_summary', ['child_id', 'date', 'item_id', 'right', 'tries'], ['child_id', 'date', 'item_id']);
  mem.createTable('reward', ['child_id', 'stars', 'stickers_json'], ['child_id']);
  mem.createTable('sound_clip', ['id', 'piece', 'audio_url', 'local_uri', 'recorded_by', 'updated_at'], ['id']);
  mem.createTable('voice_template', ['child_id', 'item_id', 'speaker', 'features', 'created_at'], ['child_id', 'item_id', 'speaker']);
}
