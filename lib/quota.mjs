// Quota poller. Endpoint is UNDOCUMENTED and may change; see README.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { exec, execFileSync } from 'node:child_process';

const cfgDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function tokenFromJson(txt) {
  try { return JSON.parse(txt)?.claudeAiOauth?.accessToken || null; } catch { return null; }
}

/** Order: $CLAUDE_CONFIG_DIR/.credentials.json, ~/.claude/.credentials.json, macOS keychain. */
export function resolveToken() {
  for (const d of [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean)) {
    try { const t = tokenFromJson(fs.readFileSync(path.join(d, '.credentials.json'), 'utf8')); if (t) return t; } catch { /* next */ }
  }
  if (process.platform === 'darwin') {
    const suffix = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ? `-${process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR}` : '';
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', `Claude Code-credentials${suffix}`, '-w'], { encoding: 'utf8', timeout: 5000 });
      const t = tokenFromJson(out); if (t) return t;
    } catch { /* none */ }
  }
  return null;
}

let versionCache = null;
function claudeVersion() {
  if (process.env.CLAUDE_CODE_VERSION) return Promise.resolve(process.env.CLAUDE_CODE_VERSION); // e.g. in Docker, where `claude` is not installed
  if (versionCache) return Promise.resolve(versionCache);
  return new Promise((res) => {
    exec('claude --version', { timeout: 8000 }, (err, out) => {
      const m = !err && /(\d+\.\d+\.\d+)/.exec(out || '');
      res(versionCache = m ? m[1] : '2.0.0'); // fallback keeps a plausible UA
    });
  });
}

const LABELS = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet', extra_usage: 'Extra usage' };

/** Accepts shape A (object of {utilization,resets_at}) and shape B (array of {kind,percent,scope}). */
export function normalise(raw) {
  const out = [];
  if (Array.isArray(raw)) {
    for (const b of raw) {
      if (!b || typeof b.percent !== 'number') continue;
      const dn = b.scope?.model?.display_name;
      const label = b.kind === 'session' ? '5-hour' : b.kind === 'weekly' ? 'Weekly'
        : b.kind === 'weekly_scoped' ? `Weekly · ${dn || 'scoped'}` : String(b.kind);
      out.push({ id: `${b.kind}${dn ? ':' + dn : ''}`, label, pct: b.percent, resetsAt: b.resets_at || b.resetsAt || null });
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object' || typeof v.utilization !== 'number') continue;
      out.push({ id: k, label: LABELS[k] || `${k.replace(/_/g, ' ')} (unnamed by server)`, known: !!LABELS[k], pct: v.utilization, resetsAt: v.resets_at || null });
    }
  }
  return out;
}

export class QuotaPoller {
  constructor({ intervalMs = 240000, onUpdate = () => {} } = {}) {
    this.intervalMs = intervalMs; this.onUpdate = onUpdate;
    this.state = { buckets: [], fetchedAt: null, error: null, errorAt: null };
  }
  start() { this.poll(); setInterval(() => this.poll(), this.intervalMs).unref?.(); }
  async poll() {
    try {
      const token = resolveToken();
      if (!token) throw new Error('no OAuth token found (run `claude` and log in)');
      const ver = await claudeVersion();
      const raw = await new Promise((resolve, reject) => {
        const req = https.get('https://api.anthropic.com/api/oauth/usage', {
          timeout: 10000,
          headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': `claude-code/${ver}`, accept: 'application/json' },
        }, (res) => {
          let b = ''; res.on('data', (c) => (b += c));
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${b.slice(0, 120)}`));
            try { resolve(JSON.parse(b)); } catch { reject(new Error('bad JSON')); }
          });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
      });
      const buckets = normalise(raw);
      if (!buckets.length) throw new Error('unrecognised response shape: ' + JSON.stringify(raw).slice(0, 150));
      this.state = { buckets, fetchedAt: Date.now(), error: null, errorAt: null };
    } catch (e) {
      // keep last good buckets; record error + when
      this.state = { ...this.state, error: String(e.message), errorAt: Date.now() };
    }
    this.onUpdate(this.state);
  }
}
