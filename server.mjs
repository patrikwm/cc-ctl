#!/usr/bin/env node
// cc-ctl: `node server.mjs [--port N] [--backfill-all]`. Default http://127.0.0.1:8080
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './lib/db.mjs';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { Tailer } from './lib/tail.mjs';
import { QuotaPoller } from './lib/quota.mjs';
import { PRICES_FETCHED } from './lib/prices.mjs';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const PORT = Number(arg('--port') || process.env.CC_CTL_PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1'; // Docker image sets 0.0.0.0; there is NO auth, expose only on trusted interfaces
const DAY = 864e5, BUCKET = 30e3, WINDOW = 6 * 3600e3;
const html = fs.readFileSync(fileURLToPath(new URL('./ui.html', import.meta.url)));

const store = new Store();
const db = await openDb();
if (!db.enabled) console.warn('history disabled:', db.reason);
const firstRun = db.enabled && db.query({ limit: 1 }).total.calls === 0; // empty DB: import all history once
const subParent = new Map(); // subagent owner id -> parent session id
const metaCache = new Map(), repoCache = new Map();
let cur = null;              // attribution of the line being ingested (ingest is synchronous)
function repoOf(cwd) {
  if (!cwd) return null;
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let r = path.basename(cwd), d = cwd;
  for (let i = 0; i < 12; i++) {
    const g = path.join(d, '.git');
    try {
      const st = fs.statSync(g);
      if (st.isFile()) { // worktree file: "gitdir: <main>/.git/worktrees/<name>"
        const m = /gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees/.exec(fs.readFileSync(g, 'utf8'));
        r = path.basename(m ? m[1] : d);
      } else r = path.basename(d);
      break;
    } catch { const up = path.dirname(d); if (up === d) break; d = up; }
  }
  repoCache.set(cwd, r); return r;
}
store.listeners.add((owner, i) => {
  if (!db.enabled || !cur) return;
  db.record({ mid: i.mid, ts: i.ts, session: cur.parent, agentId: cur.agentId, agentType: cur.agentType, agentDesc: cur.agentDesc,
    cwd: cur.cwd, repo: repoOf(cur.cwd), model: i.model, cum: i.cum, cumUsd: i.cumUsd, unpriced: i.unpriced });
});
const QUERY_PARAMS = ['since', 'from', 'to', 'repo', 'agent', 'agent_id', 'session', 'model', 'limit', 'group_by', 'group'];
const GROUP_NAMES = ['day', 'hour', 'repo', 'agent', 'agent_id', 'session', 'model', 'cwd'];
const json = (res, o, code = 200) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
/** "3d", "12h", "30m" => now - that; digits => epoch ms; else Date.parse. */
function tparse(v, now) {
  if (!v) return undefined;
  const m = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(v);
  if (m) return Math.round(now - m[1] * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2]]);
  return /^\d+$/.test(v) ? Number(v) : Date.parse(v) || undefined;
}
const meta = new Map();      // sessionId -> live info (hooks + transcript activity)
const files = new Map();     // sessionId -> transcript path
const logs = [];             // ring buffer
const clients = new Set();
const M = (id) => {
  let m = meta.get(id);
  if (!m) meta.set(id, (m = { turns: 0, lastDone: 0, lastHook: 0, lastFail: 0, lastOk: 0, ended: false, tool: null, toolSummary: '', host: null, ppid: null, cwd: null, agents: 0 }));
  return m;
};
const sse = (ev, data) => { const s = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); };
function log(session, level, text, ts = Date.now()) {
  const e = { ts, session, level, text: String(text).slice(0, 300) };
  logs.push(e); if (logs.length > 3000) logs.shift();
  sse('log', e);
}

// ---- transcript ingestion --------------------------------------------------
const tailer = new Tailer({
  backfill: process.argv.includes('--backfill-all') || firstRun ? true : 2 * DAY,
  onError: (f, e) => log('-', 'warn', `tail ${f}: ${e.message}`),
  onLine(file, sid, o) {
    files.set(sid, file);
    const sub = path.basename(path.dirname(file)) === 'subagents';
    const parent = sub ? path.basename(path.dirname(path.dirname(file))) : sid;
    let am = {};
    if (sub) {
      subParent.set(sid, parent);
      if (!metaCache.has(file)) { try { metaCache.set(file, JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'))); } catch { metaCache.set(file, {}); } }
      am = metaCache.get(file);
    }
    cur = { parent, agentId: sub ? sid.replace(/^agent-/, '') : null, agentType: sub ? am.agentType || 'subagent' : null,
      agentDesc: sub ? am.description || null : null, cwd: o.cwd || meta.get(parent)?.cwd || null };
    store.ingest(sid, o);
    cur = null;
    if (sub) { const pm = M(parent); pm.lastDone = Math.max(pm.lastDone, Date.parse(o.timestamp) || 0); return; }
    const m = M(sid), ts = Date.parse(o.timestamp) || 0;
    if (o.cwd && !m.cwd) m.cwd = o.cwd;
    const c = o.message?.content, arr = Array.isArray(c) ? c : [];
    if (o.type === 'user') {
      const tr = arr.filter((b) => b.type === 'tool_result');
      if (tr.length) {
        for (const b of tr) {
          if (b.is_error) { m.lastFail = Math.max(m.lastFail, ts); if (Date.now() - ts < 6e5) log(sid, 'error', `tool error: ${txt(b.content).slice(0, 200)}`, ts); }
          else m.lastOk = Math.max(m.lastOk, ts);
        }
      } else if (!o.isMeta && !o.isSidechain) m.turns++;
      m.lastDone = Math.max(m.lastDone, ts);
    } else if (o.type === 'assistant' && !arr.some((b) => b.type === 'tool_use')) m.lastDone = Math.max(m.lastDone, ts);
  },
});
const txt = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text || '').join(' ') : JSON.stringify(c ?? ''));

// ---- hooks -------------------------------------------------------------------
function ingestHook(p) {
  if (!p || !p.session_id) return;
  const m = M(p.session_id), now = p.ts || Date.now();
  m.lastHook = now; m.host = p.host || m.host; m.ppid = p.ppid || m.ppid; m.cwd = p.cwd || m.cwd;
  if (p.transcript_path && !files.has(p.session_id)) files.set(p.session_id, p.transcript_path);
  const ev = p.event;
  if (ev === 'SessionStart') m.ended = false;
  if (ev === 'SessionEnd') { m.ended = true; m.tool = null; }
  if (ev === 'PreToolUse') { m.tool = p.tool; m.toolSummary = p.summary; }
  if (ev === 'PostToolUse') { m.tool = null; m.lastDone = now; m.lastOk = now; }
  if (ev === 'PostToolUseFailure') { m.tool = null; m.lastDone = now; m.lastFail = now; }
  if (ev === 'Stop' || ev === 'UserPromptSubmit') { m.tool = null; m.lastDone = now; m.ended = false; }
  if (ev === 'PermissionRequest') m.tool = `⏸ permission: ${p.tool || ''}`;
  const level = p.ok === false ? 'error' : ev === 'Notification' || ev === 'PermissionRequest' || ev === 'StopFailure' ? 'warn' : 'info';
  if (ev !== 'PreToolUse') log(p.session_id, level, `${ev}${p.tool ? ' ' + p.tool : ''} ${p.summary || ''}`.trim(), now);
}

// ---- status ------------------------------------------------------------------
function status(m, now) {
  if (m.ended) return 'suspended';
  const last = Math.max(m.lastDone, m.lastHook);
  if (!last || now - last > 15 * 60e3) return 'unknown';
  if (m.lastFail > m.lastOk && now - m.lastFail < 5 * 60e3) return 'degraded';
  const done = m.lastDone || last;
  return now - done < 30e3 ? 'healthy' : 'idle';
}

// ---- state snapshot ------------------------------------------------------------
const quota = new QuotaPoller({ onUpdate: (q) => sse('quota', q) });
function snapshot() {
  const now = Date.now(), t0 = now - WINDOW, nb = WINDOW / BUCKET;
  const total = new Array(nb).fill(0), per = new Map(), w5 = new Map();
  for (let i = store.charges.length - 1; i >= 0; i--) {
    const c = store.charges[i];
    if (c.ts < t0) continue;   // charges are ~time ordered; scan all, cheap enough
    const b = Math.min(nb - 1, Math.floor((c.ts - t0) / BUCKET));
    total[b] += c.usd;
    let a = per.get(c.sessionId); if (!a) per.set(c.sessionId, (a = new Array(20).fill(0)));
    const sb = Math.floor((c.ts - (now - 20 * BUCKET)) / BUCKET); if (sb >= 0 && sb < 20) a[sb] += c.usd;
    if (c.ts > now - 5 * 3600e3) w5.set(c.sessionId, (w5.get(c.sessionId) || 0) + c.usd);
  }
  const sub = new Map(); // parent -> aggregate of its subagents
  for (const [sid, par] of subParent) {
    const ss = store.sessions.get(sid); if (!ss) continue;
    let a = sub.get(par); if (!a) sub.set(par, (a = { usd: 0, n: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }));
    a.usd += ss.usd; a.n++; for (const k in a.tokens) a.tokens[k] += ss.tokens[k];
  }
  const ids = new Set([...[...store.sessions.keys()].filter((k) => !subParent.has(k)), ...meta.keys()]);
  const sessions = [];
  for (const id of ids) {
    const s = store.sessions.get(id), m = M(id), sb = sub.get(id);
    const last = Math.max(m.lastDone, m.lastHook, 0);
    sessions.push({
      id, cwd: s?.cwd || m.cwd, status: status(m, now), model: s ? [...s.models].pop() : null,
      tool: m.tool, toolSummary: m.toolSummary, turns: m.turns,
      tokens: sb ? Object.fromEntries(Object.keys(sb.tokens).map((k) => [k, (s?.tokens[k] || 0) + sb.tokens[k]])) : s?.tokens,
      usd: (s?.usd || 0) + (sb?.usd || 0), subagents: sb?.n || 0, repo: repoOf(s?.cwd || m.cwd),
      apiCalls: s?.apiCalls || 0, unpriced: s ? [...s.unpricedModels] : [], last, host: m.host, ppid: m.ppid,
      spark: per.get(id) || null, w5: w5.get(id) || 0,
    });
  }
  sessions.sort((a, b) => b.last - a.last);
  return { now, sessions, totals: store.totals(), chart: { t0, bucket: BUCKET, total }, quota: quota.state, pricesFetched: PRICES_FETCHED };
}

// ---- timeline ------------------------------------------------------------------
function timeline(id) {
  const f = files.get(id); if (!f) return [];
  let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch { return []; }
  const out = [], lines = raw.split('\n');
  const cut = (s, n = 1500) => (s.length > n ? s.slice(0, n) + '…' : s);
  for (const l of lines.slice(-1500)) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(o.timestamp) || 0, c = o.message?.content;
    if (o.type === 'user') {
      if (typeof c === 'string') out.push({ ts, k: 'user', t: cut(c) });
      else for (const b of c || []) {
        if (b.type === 'tool_result') out.push({ ts, k: b.is_error ? 'error' : 'result', t: cut(txt(b.content), 800) });
        else if (b.type === 'text') out.push({ ts, k: 'user', t: cut(b.text) });
      }
    } else if (o.type === 'assistant') {
      for (const b of Array.isArray(c) ? c : []) {
        if (b.type === 'text') out.push({ ts, k: 'assistant', t: cut(b.text) });
        else if (b.type === 'tool_use') out.push({ ts, k: 'tool', tool: b.name, t: cut(JSON.stringify(b.input), 600) });
      }
    }
  }
  return out.slice(-400);
}

// ---- http ------------------------------------------------------------------------
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname === '/ingest') {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { ingestHook(JSON.parse(b)); } catch { /* ignore */ } res.writeHead(204).end(); });
    return;
  }
  if (u.pathname === '/api/state') {
    const n = Number(u.searchParams.get('logs')) || 0;
    return json(res, { ...snapshot(), history: db.enabled ? db.path : null, logs: n ? logs.slice(-n) : undefined });
  }
  if (u.pathname === '/api' || u.pathname === '/api/help') {
    return json(res, {
      endpoints: { '/api/state': 'current sessions, status, tokens, usd, quota. ?logs=N adds recent log lines',
        '/api/query': 'history aggregates from SQLite', '/events': 'SSE stream used by the UI' },
      query_params: QUERY_PARAMS, group_names: GROUP_NAMES,
      time_formats: '3d 12h 30m 2w, ISO date, or epoch ms', filters: 'repo/agent/model are substring matches; session is a prefix; agent matches type or description',
      row_shape: 'grouped rows have "key" (group values joined by " / ") plus one field per group name, then calls, input, output, cache_read, cache_write, usd',
      cli: `node ${fileURLToPath(new URL('./query.mjs', import.meta.url))} --since 3d --repo X --group agent`,
      history_db: db.enabled ? db.path : null });
  }
  if (u.pathname === '/api/query') {
    if (!db.enabled) return json(res, { error: db.reason }, 503);
    const bad = [...u.searchParams.keys()].filter((k) => !QUERY_PARAMS.includes(k));
    if (bad.length) return json(res, { error: `unknown parameter(s): ${bad.join(', ')}`, allowed: QUERY_PARAMS }, 400);
    const g = (k) => u.searchParams.get(k) || undefined, now = Date.now();
    const q = { from: tparse(g('from') || g('since'), now), to: tparse(g('to'), now), repo: g('repo'), agent: g('agent'), agent_id: g('agent_id'),
      session: g('session'), model: g('model'), limit: g('limit'), group_by: (g('group_by') || g('group') || '').split(',').filter(Boolean) };
    const badGroup = q.group_by.filter((x) => !GROUP_NAMES.includes(x));
    if (badGroup.length) return json(res, { error: `unknown group: ${badGroup.join(', ')}`, allowed: GROUP_NAMES }, 400);
    try { return json(res, { query: q, ...db.query(q) }); } catch (e) { return json(res, { error: e.message }, 400); }
  }
  if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: init\ndata: ${JSON.stringify({ logs: logs.slice(-500), state: snapshot() })}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (u.pathname.startsWith('/api/session/')) {
    const body = JSON.stringify(timeline(decodeURIComponent(u.pathname.slice(13))));
    return res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  }
  if (u.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  res.writeHead(404).end();
}).on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `port ${PORT} in use` : e.message); process.exit(1); })
  .listen(PORT, HOST, () => {
    console.log(`cc-ctl on http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
    tailer.start(); quota.start();
    setInterval(() => clients.size && sse('state', snapshot()), 2000).unref?.();
  });
