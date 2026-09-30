#!/usr/bin/env node
// CLI for the running cc-ctl server. Examples:
//   node query.mjs --since 3d --repo fleet --group agent
//   node query.mjs --since 7d --group day,repo
//   node query.mjs state            (current sessions + quota, compact JSON)
// Flags: --since/--from/--to (3d, 12h, ISO), --repo, --agent, --agent_id, --session, --model, --group a,b, --limit, --json
// group names: day hour repo agent agent_id session model cwd
const a = process.argv.slice(2), get = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
const base = `http://127.0.0.1:${process.env.CC_CTL_PORT || 8080}`;
try {
  if (a[0] === 'state') {
    const s = await (await fetch(base + '/api/state')).json();
    console.log(JSON.stringify({ quota: s.quota.buckets, sessions: s.sessions.filter((x) => x.status !== 'unknown').map((x) => ({ id: x.id.slice(0, 8), repo: x.repo, status: x.status, usd: +x.usd.toFixed(2), tool: x.tool, model: x.model })) }, null, 1));
  } else {
    const qs = new URLSearchParams();
    for (const k of ['since', 'from', 'to', 'repo', 'agent', 'agent_id', 'session', 'model', 'limit']) if (get(k)) qs.set(k, get(k));
    if (get('group')) qs.set('group_by', get('group'));
    const r = await (await fetch(`${base}/api/query?${qs}`)).json();
    if (r.error) throw new Error(r.error);
    if (a.includes('--json')) console.log(JSON.stringify(r, null, 1));
    else {
      const f = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n ?? 0));
      for (const x of [...r.rows, { ...Object.fromEntries(r.group_by.map((g) => [g, 'TOTAL'])), ...r.total }])
        console.log([...r.group_by.map((g) => String(x[g]).slice(0, 38).padEnd(38)), `calls ${String(x.calls).padStart(6)}`, `in ${f(x.input).padStart(7)}`, `out ${f(x.output).padStart(7)}`, `cr ${f(x.cache_read).padStart(8)}`, `cw ${f(x.cache_write).padStart(7)}`, `$${x.usd}`].join('  '));
    }
  }
} catch (e) { console.error('query failed (is `node server.mjs` running?):', e.message); process.exit(1); }
