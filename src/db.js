// Postgres (Supabase) data layer. Set DATABASE_URL to the project's connection string.
// Route and service code keeps the same small helper API as before (h.all / h.get / h.run / h.tx),
// written with SQLite-style `?` placeholders, but every call is now async and must be awaited.
const path = require('node:path');
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types } = require('pg');

// COUNT/SUM over integers come back as int8 and ROUND as numeric; return plain JS numbers like SQLite did.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'schema.sql');
// Tables keyed by a natural key rather than an `id` column (no RETURNING id on insert).
const NO_ID = new Set(['settings', 'email_templates', 'files', 'app_state']);
const WRITE_LOCK = 72000; // advisory lock key: serialises write transactions like SQLite's BEGIN IMMEDIATE

const cache = new Map();
// Rewrites the SQLite dialect the app was written in: `?` → `$n`, the ISO-now expression → now_iso(),
// case-insensitive LIKE, and RETURNING id on inserts so callers still get lastInsertRowid.
function translate(sql) {
  let out = cache.get(sql);
  if (out) return out;
  let n = 0, q = '', inStr = false;
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    q += !inStr && ch === '?' ? '$' + ++n : ch;
  }
  q = q.replace(/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*'now'\)/g, 'public.now_iso()').replace(/\bLIKE\b/g, 'ILIKE');
  const ins = q.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
  if (ins && !NO_ID.has(ins[1].toLowerCase()) && !/\bRETURNING\b/i.test(q)) q = q.replace(/;?\s*$/, ' RETURNING id');
  out = q;
  cache.set(sql, out);
  return out;
}

// Form fields arrive as '' for "not filled in". SQLite stored that in any column; Postgres rejects '' for numbers,
// so empty strings are sent as NULL. Booleans become 1/0 to match the integer flag columns.
const param = (v) => (v === '' || v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

// Keep the SQLite-era error text the app checks for ('UNIQUE', 'FOREIGN KEY'); DOUBLE_BOOKING comes from the trigger.
function wrapError(e, sql) {
  if (e && e.code === '23505' && !/UNIQUE/.test(e.message)) e.message = `UNIQUE constraint failed: ${e.detail || e.message}`;
  if (e && e.code === '23503' && !/FOREIGN KEY/.test(e.message)) e.message = `FOREIGN KEY constraint failed: ${e.detail || e.message}`;
  if (e && process.env.DEBUG_SQL) e.message += `\n  SQL: ${sql}`;
  return e;
}

function makePool(url) {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || (local ? 5 : 3)),
    idleTimeoutMillis: 10000,
    ssl: local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
  });
}

function helpers(pool) {
  const als = new AsyncLocalStorage(); // current transaction client, if any
  let settings = new Map();

  async function q(sql, params) {
    const text = translate(sql);
    const client = als.getStore()?.client || pool;
    try {
      return await client.query(text, params.map(param));
    } catch (e) {
      throw wrapError(e, text);
    }
  }

  return {
    pool,
    async all(sql, ...p) { return (await q(sql, p)).rows; },
    async get(sql, ...p) { return (await q(sql, p)).rows[0]; },
    async run(sql, ...p) {
      const r = await q(sql, p);
      return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id };
    },
    // Runs fn in a transaction. Nested calls become savepoints, so a failed inner step
    // (e.g. a DOUBLE_BOOKING retry) rolls back only itself, as it did with SQLite.
    async tx(fn) {
      const cur = als.getStore();
      if (cur) {
        const sp = `sp_${++cur.depth}`;
        await cur.client.query(`SAVEPOINT ${sp}`);
        try {
          const r = await fn();
          await cur.client.query(`RELEASE SAVEPOINT ${sp}`);
          return r;
        } catch (e) {
          await cur.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw e;
        }
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
        const r = await als.run({ client, depth: 0 }, fn);
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    // Settings are read on almost every page, so they are loaded once per request (see server.js)
    // and read synchronously. Call loadSettings() again after changing them.
    async loadSettings() {
      const rows = (await q('SELECT key, value FROM settings', [])).rows;
      settings = new Map(rows.map((r) => [r.key, r.value]));
      return settings;
    },
    setting(key, fallback) {
      return settings.has(key) ? settings.get(key) ?? '' : fallback;
    },
  };
}

async function applySchema(pool) {
  await pool.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

let shared;
// One pool per process (one per Vercel function instance).
function connect(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set. Point it at your Supabase Postgres connection string (see README).');
  if (!shared) shared = helpers(makePool(url));
  return shared;
}

module.exports = { connect, helpers, makePool, applySchema, translate, SCHEMA_FILE };
