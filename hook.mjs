#!/usr/bin/env node
// cc-ctl hook client. Runs on EVERY tool call, so: no stdout, always exit 0, hard 800ms cap,
// fire-and-forget, all failures swallowed. It never blocks or breaks Claude Code,
// whether or not the daemon is running.
//
// Usage: registered as a command hook:  node /path/to/hook.mjs
//        node hook.mjs --print-settings   prints a settings.json "hooks" block (the only stdout use)

import http from 'node:http';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { HOOK_EVENTS } from './lib/events.mjs';

// Hard deadline, covers a hung stdin as well as a hung socket.
setTimeout(() => process.exit(0), 800);

function printSettings() {
  const cmd = `node "${fileURLToPath(import.meta.url)}"`;
  const hooks = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: cmd, timeout: 2 }] }];
  process.stdout.write(JSON.stringify({ hooks }, null, 2) + '\n');
  process.exit(0);
}

const clip = (v, n = 80) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, n) : '');

/** Short derived summary. tool_input itself is NEVER forwarded (a Write can be megabytes). */
export function summarize(d) {
  const ti = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
  if (d.hook_event_name === 'UserPromptSubmit') return clip(d.prompt);
  if (d.hook_event_name === 'Notification') return clip(d.message);
  return clip(ti.command) || clip(ti.file_path) || clip(ti.path) || clip(ti.pattern)
    || clip(ti.url) || clip(ti.query) || clip(ti.description) || clip(ti.prompt) || '';
}

export function toPayload(d) {
  const ev = d.hook_event_name;
  const r = d.tool_response;
  let ok = true;
  if (ev === 'PostToolUseFailure' || ev === 'StopFailure') ok = false;
  else if (r && typeof r === 'object' && (r.is_error === true || r.success === false)) ok = false;
  return {
    event: ev,
    session_id: d.session_id,
    cwd: d.cwd,
    transcript_path: d.transcript_path,
    tool: d.tool_name || undefined,
    summary: summarize(d),
    ok,
    permission_mode: d.permission_mode,
    agent_id: d.agent_id,
    agent_type: d.agent_type,
    ts: Date.now(),
    host: os.hostname(),
    ppid: process.env.PPID ? Number(process.env.PPID) : process.ppid,
  };
}

function main() {
  if (process.argv.includes('--print-settings')) return printSettings();
  const port = Number(process.env.CC_CTL_PORT) || 8080;
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let body;
    try { body = JSON.stringify(toPayload(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
    catch { return process.exit(0); }
    try {
      const req = http.request({
        host: '127.0.0.1', port, path: '/ingest', method: 'POST', timeout: 800,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
      req.on('error', () => process.exit(0));
      req.on('timeout', () => process.exit(0));
      req.end(body);
    } catch { process.exit(0); }
  });
}

// Only run main when executed directly (lets tests import summarize/toPayload).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
