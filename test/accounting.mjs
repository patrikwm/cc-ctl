// Accounting/tailer/hook assertions. Run: node test/accounting.mjs   (exit code 1 if anything fails)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { Tailer } from '../lib/tail.mjs';
import { lookupPrice, normalizeModelId, costOf, PRICES } from '../lib/prices.mjs';
import { toPayload } from '../hook.mjs';

const EPS = 1e-9;
const near = (a, b, m) => assert.ok(Math.abs(a - b) < EPS, `${m ?? 'cost'}: got ${a}, want ${b}`);

// ---- fixture helpers -------------------------------------------------------
let tsN = 0;
const line = (id, out, { model = 'claude-opus-4-8', inp = 1000, cr = 0, w5, w1, cc, cwd = '/proj' } = {}) => {
  const usage = { input_tokens: inp, output_tokens: out, cache_read_input_tokens: cr };
  if (cc !== undefined) usage.cache_creation_input_tokens = cc;
  if (w5 !== undefined || w1 !== undefined) {
    usage.cache_creation = { ephemeral_5m_input_tokens: w5 ?? 0, ephemeral_1h_input_tokens: w1 ?? 0 };
    usage.cache_creation_input_tokens = (w5 ?? 0) + (w1 ?? 0);
  }
  return { type: 'assistant', cwd, timestamp: new Date(1700000000000 + 1000 * tsN++).toISOString(),
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage } };
};
const jl = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ctl-'));
const proj = (root, name = 'p1') => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
const snap = (st) => JSON.stringify([...st.sessions.values()].map((s) => [s.id, s.tokens, +s.usd.toFixed(9), s.apiCalls]).sort());

const results = [];
const test = (name, fn) => {
  try { fn(); results.push([name, true, '']); }
  catch (e) { results.push([name, false, String(e.message).split('\n')[0]]); }
};

// ---- a) one call across 3 lines -------------------------------------------
test('a) 3 lines, output 40/80/100 -> output 100, apiCalls 1', () => {
  const st = new Store();
  const kinds = [40, 80, 100].map((o) => st.ingest('S1', line('msg_A', o)));
  assert.deepEqual(kinds, ['charged', 'delta', 'delta']);
  const s = st.session('S1');
  assert.equal(s.tokens.output, 100);
  assert.equal(s.tokens.input, 1000, 'input must not be tripled');
  assert.equal(s.apiCalls, 1);
  near(s.usd, (1000 * 5 + 100 * 25) / 1e6);
  // lower/equal output afterwards is ignored
  assert.equal(st.ingest('S1', line('msg_A', 100)), 'ignored');
  assert.equal(st.ingest('S1', line('msg_A', 60)), 'ignored');
  assert.equal(st.session('S1').tokens.output, 100);
});

// ---- b) two distinct ids ----------------------------------------------------
test('b) two message ids -> output 200, apiCalls 2', () => {
  const st = new Store();
  st.ingest('S1', line('msg_A', 100)); st.ingest('S1', line('msg_B', 100));
  assert.equal(st.session('S1').tokens.output, 200);
  assert.equal(st.session('S1').apiCalls, 2);
});

// ---- c) fork ---------------------------------------------------------------
test('c) fork replaying (a) charges 0, parent unchanged', () => {
  const st = new Store();
  const L = [40, 80, 100].map((o) => line('msg_A', o));
  L.forEach((l) => st.ingest('PARENT', l));
  const before = snap(st);
  const parentUsd = st.session('PARENT').usd;
  L.forEach((l) => assert.equal(st.ingest('FORK', l), 'dupe'));
  assert.equal(st.session('FORK').tokens.output, 0);
  assert.equal(st.session('FORK').apiCalls, 0);
  assert.equal(st.session('FORK').usd, 0);
  assert.equal(st.session('PARENT').usd, parentUsd);
  const parentOnly = JSON.parse(before).filter((r) => r[0] === 'PARENT');
  assert.deepEqual(JSON.parse(snap(st)).filter((r) => r[0] === 'PARENT'), parentOnly);
});

// ---- d) replay / restart ----------------------------------------------------
test('d) whole-file replay into fresh store -> identical; restart on same store -> no change', () => {
  const root = tmp(); const pd = proj(root);
  fs.writeFileSync(path.join(pd, 'S1.jsonl'),
    jl([40, 80, 100].map((o) => line('msg_A', o)).concat([line('msg_B', 70, { cr: 5000, w5: 300 })]))
    + 'this is not json\n');
  const run = (store) => { const t = new Tailer({ projectsDir: root, backfill: true, onLine: (f, sid, o) => store.ingest(sid, o) }); t.poll(); return t; };
  const s1 = new Store(); run(s1);
  const s2 = new Store(); run(s2);
  assert.equal(snap(s1), snap(s2));
  assert.equal(s1.session('S1').tokens.output, 170);
  // daemon restart against an already-tailed file: a brand-new tailer re-reads from byte 0 into the SAME store
  const before = snap(s1);
  run(s1);
  assert.equal(snap(s1), before);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- e) partial line --------------------------------------------------------
test('e) partial trailing line buffered until newline (incl. split UTF-8)', () => {
  const root = tmp(); const pd = proj(root); const f = path.join(pd, 'S1.jsonl');
  const st = new Store();
  const t = new Tailer({ projectsDir: root, backfill: true, onLine: (_f, sid, o) => st.ingest(sid, o) });
  const full = JSON.stringify(line('msg_A', 50, { cwd: '/projé/日本' })) + '\n';
  const buf = Buffer.from(full);
  const cut = buf.indexOf(Buffer.from('é')) + 1; // split inside the 2-byte 'é'
  fs.writeFileSync(f, buf.subarray(0, cut));
  t.poll();
  assert.equal(st.stats.lines, 0, 'must not ingest a partial line');
  fs.appendFileSync(f, buf.subarray(cut));
  t.poll();
  assert.equal(st.session('S1').tokens.output, 50);
  assert.equal(st.session('S1').cwd, '/projé/日本');
  t.poll();
  assert.equal(st.session('S1').apiCalls, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- f) truncation / rotation / deletion -----------------------------------
test('f) truncation, rotation, deletion, malformed line survive', () => {
  const root = tmp(); const pd = proj(root); const f = path.join(pd, 'S1.jsonl');
  const st = new Store();
  const t = new Tailer({ projectsDir: root, backfill: true, onLine: (_f, sid, o) => st.ingest(sid, o) });
  fs.writeFileSync(f, jl([line('msg_A', 100), line('msg_B', 100)]));
  t.poll();
  assert.equal(st.session('S1').tokens.output, 200);
  // truncation: file rewritten SHORTER (only msg_C) -> offset > size
  fs.writeFileSync(f, jl([line('msg_C', 10)]));
  t.poll();
  assert.equal(st.session('S1').tokens.output, 210, 'new line after truncation read from byte 0');
  // truncate then re-append the old content: replays charge nothing
  fs.writeFileSync(f, jl([line('msg_A', 100)]).slice(0, 0));
  fs.appendFileSync(f, 'garbage{{{\n' + jl([line('msg_C', 10)]));
  t.poll();
  assert.equal(st.session('S1').tokens.output, 210);
  // rotation: unlink + recreate with new content
  fs.unlinkSync(f); t.poll();
  fs.writeFileSync(f, jl([line('msg_D', 5)]));
  t.poll();
  assert.equal(st.session('S1').tokens.output, 215);
  // deletion must not throw
  fs.unlinkSync(f);
  assert.doesNotThrow(() => t.poll());
  assert.equal(t.files.size, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('f2) no backfill: pre-existing content skipped, later appends read', () => {
  const root = tmp(); const pd = proj(root); const f = path.join(pd, 'S1.jsonl');
  fs.writeFileSync(f, jl([line('msg_OLD', 999)]));
  const st = new Store();
  const t = new Tailer({ projectsDir: root, backfill: false, onLine: (_f, sid, o) => st.ingest(sid, o) });
  t.poll(); assert.equal(st.stats.lines, 0);
  fs.appendFileSync(f, jl([line('msg_NEW', 7)])); t.poll();
  assert.equal(st.session('S1').tokens.output, 7);
  // a file that appears AFTER the first scan is read from byte 0
  fs.writeFileSync(path.join(pd, 'S2.jsonl'), jl([line('msg_X', 3)])); t.poll();
  assert.equal(st.session('S2').tokens.output, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- g) cache pricing -------------------------------------------------------
test('g) cache read / 5m write / 1h write priced at own rates', () => {
  const M = 1e6, opus = 'claude-opus-4-8'; // $5 in, $25 out, read 0.5, 5m 6.25, 1h 10
  const z = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  near(costOf(opus, { ...z, cacheRead: M }).usd, 0.5, 'cache read 0.1x');
  near(costOf(opus, { ...z, cacheWrite5m: M }).usd, 6.25, '5m write 1.25x');
  near(costOf(opus, { ...z, cacheWrite1h: M }).usd, 10, '1h write 2x base input');
  near(costOf(opus, { ...z, input: M }).usd * 2, costOf(opus, { ...z, cacheWrite1h: M }).usd, '1h == 2x BASE input');
  // through the store, with ephemeral breakdown + unattributed remainder assumed 5m
  const st = new Store();
  st.ingest('S', line('m1', 0, { inp: 0, cr: 2 * M, w5: M, w1: M }));
  near(st.session('S').usd, 2 * 0.5 + 6.25 + 10);
  st.ingest('S2', line('m2', 0, { inp: 0, cc: M })); // no breakdown -> all 5m
  assert.equal(st.session('S2').tokens.cacheWrite5m, M);
  assert.equal(st.session('S2').tokens.cacheWrite1h, 0);
  near(st.session('S2').usd, 6.25);
  // per-model cache-read multipliers differ from 0.1x
  near(costOf('claude-opus-5-5', { ...z, cacheRead: M }).usd, 0.2, 'Opus 5.5 read = 0.05x of $4');
  near(costOf('claude-fable-5-1', { ...z, cacheRead: M }).usd, 0.25, 'Fable 5.1 read = 0.025x of $10');
});

// ---- model matching / unpriced ---------------------------------------------
test('model ids: date stamp, [1m], longest prefix, unpriced never $0-silent', () => {
  assert.equal(lookupPrice('claude-opus-4-8-20260528').key, 'claude-opus-4-8');
  assert.equal(lookupPrice('claude-opus-4-8').key, 'claude-opus-4-8');
  assert.equal(lookupPrice('claude-opus-4-8[1m]').key, 'claude-opus-4-8');
  assert.equal(lookupPrice('claude-sonnet-4-5-20250929[1m]').key, 'claude-sonnet-4-5');
  assert.equal(lookupPrice('claude-opus-5-5').key, 'claude-opus-5-5');
  assert.equal(lookupPrice('claude-opus-5').key, 'claude-opus-5');
  assert.equal(lookupPrice('claude-opus-5-20260101').key, 'claude-opus-5');
  assert.equal(lookupPrice('claude-haiku-4-5-20251001').key, 'claude-haiku-4-5');
  assert.equal(lookupPrice('claude-opus-45'), null, 'must respect the - boundary');
  assert.equal(lookupPrice('claude-opus-6-0'), null);
  assert.equal(normalizeModelId('Claude-Opus-4-8-20260528[1m]'), 'claude-opus-4-8');
  const st = new Store();
  st.ingest('S', line('mx', 10, { model: 'claude-future-9' }));
  assert.equal(st.session('S').unpriced, true);
  assert.ok(st.session('S').unpricedModels.has('claude-future-9'));
  assert.equal(st.session('S').tokens.output, 10, 'tokens still counted');
  assert.ok(Object.keys(PRICES).length > 10);
});

test('store ignores junk (no id, no usage, synthetic, null) without throwing', () => {
  const st = new Store();
  for (const j of [null, {}, { message: {} }, { message: { id: 'x' } }, { message: { id: 'x', usage: {}, model: '<synthetic>' } }, 'str', 5])
    assert.doesNotThrow(() => st.ingest('S', j));
  assert.equal(st.totals().apiCalls, 0);
});

// ---- hook payload -----------------------------------------------------------
test('hook: strips tool_input/tool_response, adds host+ppid, short summary', () => {
  const big = 'x'.repeat(2_000_000);
  const p = toPayload({ hook_event_name: 'PostToolUse', session_id: 'S', cwd: '/c', tool_name: 'Write',
    tool_input: { file_path: '/a/b.txt', content: big }, tool_response: { success: true, content: big } });
  const s = JSON.stringify(p);
  assert.ok(s.length < 1000, `payload ${s.length} bytes`);
  assert.equal(p.tool, 'Write'); assert.equal(p.summary, '/a/b.txt'); assert.equal(p.ok, true);
  assert.ok(p.host && p.ppid);
  assert.ok(!('tool_input' in p) && !('tool_response' in p));
  assert.equal(toPayload({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }).ok, false);
  assert.equal(toPayload({ hook_event_name: 'PostToolUse', tool_response: { is_error: true } }).ok, false);
});

// ---- report -----------------------------------------------------------------
const w = Math.max(...results.map((r) => r[0].length));
console.log('\n' + 'TEST'.padEnd(w) + '  RESULT');
console.log('-'.repeat(w + 10));
for (const [n, ok, msg] of results) console.log(n.padEnd(w) + '  ' + (ok ? 'PASS' : 'FAIL  ' + msg));
const failed = results.filter((r) => !r[1]).length;
console.log('-'.repeat(w + 10));
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
