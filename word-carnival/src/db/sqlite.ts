import * as SQLite from 'expo-sqlite';
import { SCHEMA_SQL, type DbDriver, type DbResult, type SqlValue } from './schema';

/** expo-sqlite-backed DbDriver used on the device. */
export function createExpoSqliteDriver(): DbDriver {
  const db = SQLite.openDatabaseSync('wordcarnival.db');
  return {
    async execAsync(sql: string, params: SqlValue[] = []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db.execAsync as any)(sql, ...(params as any));
    },
    async runAsync(sql: string, params: SqlValue[] = []): Promise<DbResult> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await (db.runAsync as any)(sql, ...(params as any));
      return { rows: [], insertId: Number(r.lastInsertRowId ?? 0), changes: r.changes };
    },
    async getAllAsync<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await (db.getAllAsync as any)<T>(sql, ...(params as any))) as T[];
    },
    async getFirstAsync<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await (db.getFirstAsync as any)<T>(sql, ...(params as any));
      return r ?? null;
    },
    async closeAsync() {
      await db.closeAsync();
    },
  };
}

/** Create + migrate the on-device database. */
export async function openAppDb(driver?: DbDriver): Promise<DbDriver> {
  const d = driver ?? createExpoSqliteDriver();
  await d.execAsync('PRAGMA journal_mode = WAL;');
  await d.execAsync('PRAGMA foreign_keys = ON;');
  // SCHEMA_SQL holds several statements; expo-sqlite's execAsync handles multi-statement strings.
  await d.execAsync(SCHEMA_SQL);
  return d;
}
