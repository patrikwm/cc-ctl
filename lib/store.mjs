// Token accounting. See README for the exact/estimated breakdown.
//
// TRAP 1: one API call = several JSONL lines sharing message.id; input/cache are identical,
//         output_tokens grows. => first sighting charges everything, later sightings charge
//         only the output delta, equal/lower output is ignored.
// TRAP 2: --fork-session copies the parent transcript. A global Map<messageId, owner> means a
//         message already owned by another session charges nothing, and re-reading a whole file
//         (daemon restart, truncation, rotation) is idempotent.
//
// Owner session = the session id derived from the transcript FILE NAME (passed in by the caller),
// not the sessionId field inside the line, because forks may keep the parent's in-line id.
// Known limit: if a fork file is ingested BEFORE its parent, the fork owns the shared messages.
// The tailer backfills files oldest-first to make that unlikely.

import { costOf } from './prices.mjs';

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

export function usageFrom(u) {
  const out = {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
  const total = num(u.cache_creation_input_tokens);
  const cc = u.cache_creation;
  if (cc && (Number.isFinite(cc.ephemeral_5m_input_tokens) || Number.isFinite(cc.ephemeral_1h_input_tokens))) {
    out.cacheWrite5m = num(cc.ephemeral_5m_input_tokens);
    out.cacheWrite1h = num(cc.ephemeral_1h_input_tokens);
    // Any remainder not attributed to a TTL is assumed 5m.
    const rest = total - out.cacheWrite5m - out.cacheWrite1h;
    if (rest > 0) out.cacheWrite5m += rest;
  } else {
    out.cacheWrite5m = total; // no breakdown: assume all 5m
  }
  return out;
}

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

export class Store {
  constructor({ maxCharges = 100000 } = {}) {
    this.owners = new Map();      // messageId -> { sessionId, lastOutput }
    this.sessions = new Map();    // sessionId -> session summary
    this.charges = [];            // [{ts, sessionId, usd}] for charts/sparklines
    this.maxCharges = maxCharges;
    this.listeners = new Set();   // fn(sessionId, chargeInfo)
    this.stats = { lines: 0, charged: 0, deltas: 0, dupes: 0, ignored: 0 };
  }

  session(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id, cwd: null, models: new Set(), tokens: zero(), usd: 0, apiCalls: 0,
        unpricedModels: new Set(), unpriced: false, firstTs: null, lastTs: null,
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Returns 'charged' | 'delta' | 'dupe' | 'ignored'. Never throws on odd input. */
  ingest(ownerSessionId, line) {
    this.stats.lines++;
    const msg = line && line.message;
    const usage = msg && msg.usage;
    const mid = msg && msg.id;
    if (!usage || typeof usage !== 'object' || typeof mid !== 'string' || !mid
        || msg.model === '<synthetic>') {
      this.stats.ignored++;
      return 'ignored';
    }
    const ts = Date.parse(line.timestamp) || Date.now();
    const s = this.session(ownerSessionId);
    if (line.cwd && !s.cwd) s.cwd = line.cwd;
    if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
    if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;

    const u = usageFrom(usage);
    const owner = this.owners.get(mid);
    let charge, kind, owner_new;
    if (!owner) {
      owner_new = { sessionId: ownerSessionId, lastOutput: u.output, usage: zero(), usd: 0 };
      this.owners.set(mid, owner_new);
      charge = u; kind = 'charged';
      s.apiCalls++;
      this.stats.charged++;
    } else if (owner.sessionId !== ownerSessionId) {
      this.stats.dupes++;
      return 'dupe';
    } else if (u.output > owner.lastOutput) {
      charge = { ...zero(), output: u.output - owner.lastOutput };
      owner.lastOutput = u.output;
      kind = 'delta';
      this.stats.deltas++;
    } else {
      this.stats.ignored++;
      return 'ignored';
    }

    const model = msg.model || 'unknown';
    s.models.add(model);
    const { usd, priced } = costOf(model, charge);
    if (!priced) { s.unpriced = true; s.unpricedModels.add(model); }
    s.usd += usd;
    for (const k of Object.keys(charge)) s.tokens[k] += charge[k];
    const ow = owner_new || owner;
    for (const k of Object.keys(charge)) ow.usage[k] += charge[k];
    ow.usd += usd;

    if (usd > 0) {
      this.charges.push({ ts, sessionId: ownerSessionId, usd });
      if (this.charges.length > this.maxCharges) this.charges.splice(0, this.charges.length - this.maxCharges);
    }
    for (const fn of this.listeners) { try { fn(ownerSessionId, { kind, usd, ts, mid, model, line, cum: ow.usage, cumUsd: ow.usd, unpriced: !priced }); } catch { /* listener bugs must not break ingestion */ } }
    return kind;
  }

  totals() {
    const t = { tokens: zero(), usd: 0, apiCalls: 0, sessions: this.sessions.size };
    for (const s of this.sessions.values()) {
      for (const k of Object.keys(t.tokens)) t.tokens[k] += s.tokens[k];
      t.usd += s.usd; t.apiCalls += s.apiCalls;
    }
    return t;
  }
}
