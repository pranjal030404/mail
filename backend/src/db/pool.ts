import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Config } from '../config/env.js';

export type Db = Pool;
export type Conn = PoolConnection;
export type Queryable = Pool | PoolConnection;

export function createPool(config: Config): Pool {
  return mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    connectionLimit: config.DB_POOL_SIZE,
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    connectTimeout: 10000,
    multipleStatements: false,
    namedPlaceholders: false,
    // Ensure every session uses UTC regardless of server defaults.
    // (Executed once per new pooled connection.)
  }).on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  }) as unknown as Pool;
}

export async function rows<T>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await db.query<RowDataPacket[]>(sql, params);
  return result as unknown as T[];
}

export async function one<T>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const list = await rows<T>(db, sql, params);
  return list[0] ?? null;
}

export async function exec(db: Queryable, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await db.query<ResultSetHeader>(sql, params);
  return result;
}

/** Runs `fn` inside a transaction. The callback must use the provided connection. */
export async function tx<T>(db: Pool, fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* connection may already be broken */
    }
    throw err;
  } finally {
    conn.release();
  }
}

export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ER_DUP_ENTRY';
}

export function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** mysql2 returns JSON columns already parsed; tolerate strings as well. */
export function fromJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}
