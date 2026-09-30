// Usage history in SQLite (node:sqlite, built in; needs Node >= 22.13). One row per API call,
// upserted with cumulative (monotonic) values so replays/restarts are idempotent (MAX()).
// If node:sqlite is unavailable history is disabled and the rest of cc-ctl keeps working.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DB_PATH = process.env.CC_CTL_DB || path.join(os.homedir(), '.cc-ctl', 'history.db');

const GROUPS = { // whitelist: group_by name -> SQL expression
  day: "strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime')",
  hour: "strftime('%Y-%m-%d %H:00', ts/1000, 'unixepoch', 'localtime')",
  repo: "COALESCE(repo,'?')", agent: "COALESCE(agent_type,'main')", agent_id: "COALESCE(agent_id,'-')",
  session: 'session_id', model: 'model', cwd: "COALESCE(cwd,'?')",
};

export async function openDb() {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (e) { return { enabled: false, reason: 'node:sqlite unavailable (need Node >= 22.13)' }; }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS calls(
      msg_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT, agent_id TEXT, agent_type TEXT, agent_desc TEXT,
      cwd TEXT, repo TEXT, model TEXT, input INTEGER, output INTEGER, cache_read INTEGER,
      cache_write_5m INTEGER, cache_write_1h INTEGER, usd REAL, unpriced INTEGER);
    CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
    CREATE INDEX IF NOT EXISTS calls_repo ON calls(repo, ts);
    CREATE INDEX IF NOT EXISTS calls_agent ON calls(agent_type, ts);`);
  const up = db.prepare(`INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(msg_id) DO UPDATE SET output=MAX(output,excluded.output), usd=MAX(usd,excluded.usd),
      ts=MIN(ts,excluded.ts), agent_type=COALESCE(agent_type,excluded.agent_type), agent_desc=COALESCE(agent_desc,excluded.agent_desc),
      repo=COALESCE(repo,excluded.repo), cwd=COALESCE(cwd,excluded.cwd)`);
  let queue = [];
  const flush = () => {
    if (!queue.length) return;
    const q = queue; queue = [];
    try { db.exec('BEGIN'); for (const r of q) up.run(...r); db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } console.error('db flush failed:', e.message); }
  };
  setInterval(flush, 500).unref?.();
  process.on('exit', flush);

  return {
    enabled: true, path: DB_PATH,
    /** r: {mid, ts, session, agentId, agentType, agentDesc, cwd, repo, model, cum, cumUsd, unpriced} */
    record(r) {
      queue.push([r.mid, r.ts, r.session, r.agentId || null, r.agentType || null, r.agentDesc || null, r.cwd || null,
        r.repo || null, r.model, r.cum.input, r.cum.output, r.cum.cacheRead, r.cum.cacheWrite5m, r.cum.cacheWrite1h,
        r.cumUsd, r.unpriced ? 1 : 0]);
      if (queue.length >= 2000) flush();
    },
    flush,
    /** q: {from,to (ms), repo, agent, agent_id, session, model, group_by:[...]} */
    query(q) {
      flush();
      const by = (q.group_by || []).filter((g) => GROUPS[g]);
      const where = [], args = [];
      if (q.from) { where.push('ts >= ?'); args.push(q.from); }
      if (q.to) { where.push('ts <= ?'); args.push(q.to); }
      if (q.repo) { where.push('repo LIKE ?'); args.push(`%${q.repo}%`); }
      if (q.agent) { where.push("(COALESCE(agent_type,'main') LIKE ? OR agent_desc LIKE ?)"); args.push(`%${q.agent}%`, `%${q.agent}%`); }
      if (q.agent_id) { where.push('agent_id = ?'); args.push(q.agent_id); }
      if (q.session) { where.push('session_id LIKE ?'); args.push(`${q.session}%`); }
      if (q.model) { where.push('model LIKE ?'); args.push(`%${q.model}%`); }
      const sel = by.map((g) => `${GROUPS[g]} AS "${g}"`).concat(['COUNT(*) calls', 'SUM(input) input', 'SUM(output) output',
        'SUM(cache_read) cache_read', 'SUM(cache_write_5m+cache_write_1h) cache_write', 'ROUND(SUM(usd),4) usd',
        'SUM(unpriced) unpriced_calls', 'MIN(ts) first_ts', 'MAX(ts) last_ts']).join(', ');
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const limit = Math.min(Number(q.limit) || 200, 2000);
      const rows = db.prepare(`SELECT ${sel} FROM calls ${w} ${by.length ? 'GROUP BY ' + by.map((g) => `"${g}"`).join(',') : ''}
        ORDER BY ${by.length ? (by[0] === 'day' || by[0] === 'hour' ? `"${by[0]}" DESC` : 'usd DESC') : 'usd'} LIMIT ${limit}`).all(...args);
      const total = db.prepare(`SELECT COUNT(*) calls, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read,
        SUM(cache_write_5m+cache_write_1h) cache_write, ROUND(SUM(usd),4) usd FROM calls ${w}`).get(...args);
      return { group_by: by, rows: rows.map((r) => ({ key: by.map((g) => r[g]).join(' / '), ...r })), total: { ...total } };
    },
  };
}
