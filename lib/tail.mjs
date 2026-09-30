// Incremental JSONL tailer over <config>/projects/*/*.jsonl.
// Polling-based on purpose: fs.watch is unreliable for appends on some platforms, and the
// periodic scan is required anyway to discover files that existed before the daemon started.
// Survives: partial trailing lines, truncation, rotation (inode change), deletion, bad JSON.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export class Tailer {
  /**
   * @param {object} o
   * @param {string} [o.projectsDir]  default <config>/projects
   * @param {(file:string, sessionId:string, obj:object)=>void} o.onLine
   * @param {number} [o.intervalMs]   scan period (default 2000)
   * @param {boolean} [o.backfill]    read pre-existing files from byte 0 on first sight
   */
  constructor({ projectsDir, onLine, intervalMs = 2000, backfill = false, onError = () => {} }) {
    this.dir = projectsDir || path.join(claudeConfigDir(), 'projects');
    this.onLine = onLine;
    this.intervalMs = intervalMs;
    this.backfill = backfill;
    this.onError = onError;
    this.files = new Map(); // file -> { offset, pending:Buffer, ino }
    this.timer = null;
    this.firstScan = true;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  discover() {
    const found = [];
    let projects;
    try { projects = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return found; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const pd = path.join(this.dir, p.name);
      let entries;
      try { entries = fs.readdirSync(pd, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) found.push(path.join(pd, e.name));
        else if (e.isDirectory()) { // <session>/subagents/agent-*.jsonl
          const sd = path.join(pd, e.name, 'subagents');
          try {
            if (typeof this.backfill === 'number' && Date.now() - fs.statSync(path.join(pd, e.name)).mtimeMs > this.backfill) continue;
            for (const f of fs.readdirSync(sd)) if (f.endsWith('.jsonl')) found.push(path.join(sd, f));
          } catch { /* no subagents */ }
        }
      }
    }
    return found;
  }

  /** One scan + read pass. Synchronous so tests are deterministic. */
  poll() {
    const found = this.discover();
    const seen = new Set(found);

    // Deleted files: drop state (re-creation starts fresh; the store's owner map keeps totals idempotent).
    for (const f of [...this.files.keys()]) if (!seen.has(f)) this.files.delete(f);

    // Oldest-first so a parent transcript is ingested before the fork that copies it.
    const stats = [];
    for (const f of found) {
      try { stats.push([f, fs.statSync(f, { bigint: true })]); } catch { /* vanished */ }
    }
    stats.sort((a, b) => (a[1].birthtimeNs < b[1].birthtimeNs ? -1 : a[1].birthtimeNs > b[1].birthtimeNs ? 1
      : a[1].mtimeNs < b[1].mtimeNs ? -1 : 1));

    for (const [f, st] of stats) {
      try { this.readFile(f, st); } catch (err) { this.onError(f, err); }
    }
    this.firstScan = false;
  }

  readFile(file, st) {
    const size = Number(st.size);
    const ino = `${st.dev}:${st.ino}`;
    let s = this.files.get(file);
    if (!s) {
      const skip = this.firstScan && !(this.backfill === true || (this.backfill > 0 && Date.now() - Number(st.mtimeMs) < this.backfill));
      s = { offset: skip ? size : 0, pending: Buffer.alloc(0), ino };
      this.files.set(file, s);
    } else if (s.ino !== ino && st.ino !== 0n) {
      // rotation / replacement: a different file now lives at this path
      s.offset = 0; s.pending = Buffer.alloc(0); s.ino = ino;
    }
    if (size < s.offset) { s.offset = 0; s.pending = Buffer.alloc(0); } // truncation
    if (size === s.offset) return;

    const fd = fs.openSync(file, 'r');
    let chunk;
    try {
      chunk = Buffer.alloc(size - s.offset);
      const n = fs.readSync(fd, chunk, 0, chunk.length, s.offset);
      chunk = chunk.subarray(0, n);
    } finally { fs.closeSync(fd); }
    s.offset += chunk.length;

    let buf = s.pending.length ? Buffer.concat([s.pending, chunk]) : chunk;
    let start = 0, nl;
    const sessionId = path.basename(file, '.jsonl');
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      const text = buf.toString('utf8', start, nl).trim();
      start = nl + 1;
      if (!text) continue;
      let obj;
      try { obj = JSON.parse(text); } catch { continue; } // malformed line: skip
      if (obj === null || typeof obj !== 'object') continue;
      try { this.onLine(file, sessionId, obj); } catch (err) { this.onError(file, err); }
    }
    s.pending = Buffer.from(buf.subarray(start)); // partial trailing line, kept until its newline arrives
  }
}
