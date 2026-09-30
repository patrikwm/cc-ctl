# cc-ctl

A local dashboard and usage history for your [Claude Code](https://claude.com/claude-code) sessions.

It answers questions like:

- What is each of my sessions (and each subagent) doing right now?
- How many tokens did it use, and what is that worth at list price?
- How much of my Max-plan allowance is gone?
- *How many tokens did the `implementer` agent use on repo X three days ago?*

Everything runs on your machine. One Node process, **zero npm dependencies**, no build step.

**Contents:** [Quick start](#quick-start) · [What you see](#what-you-see) · [How it works](#how-it-works) · [Token accounting](#token-accounting-the-part-that-must-be-right) · [Cost](#cost) · [Status](#session-status) · [Quota](#quota-gauges) · [History](#history-database) · [Query API](#query-api-and-cli) · [Configuration](#configuration) · [Hooks](#hooks) · [Docker](#docker) · [Numbers: exact vs estimated](#which-numbers-are-exact-estimated-or-server-reported) · [Privacy](#privacy-and-security) · [Troubleshooting](#troubleshooting) · [Limitations](#known-limitations) · [Project layout](#project-layout) · [Development](#development)

---

## Quick start

**Node (>= 22.13):**

```sh
git clone https://github.com/patrikwm/cc-ctl
cd cc-ctl
node server.mjs            # then open http://localhost:8080
```

**Docker:**

```sh
docker compose up -d       # then open http://localhost:8080
```

That is all you need. The first start imports every transcript Claude Code has already written on this machine, so you see your history immediately. After that, only the last 48 hours are re-read on start (the rest is already in the history database).

Optional extras: [live hooks](#hooks) for the current tool and permission prompts, and the [CLI](#query-api-and-cli) for asking usage questions from a terminal or from Claude Code itself.

---

## What you see

Open `http://localhost:8080`.

| Area | What it shows |
|---|---|
| **Gauges (top)** | The 5-hour and weekly quota percentages reported by Anthropic, time until reset, and how old the reading is. Any error from the last fetch is shown here too. |
| **Cost chart** | Cost per 30 s bucket across all sessions for the last 6 hours. |
| **"What is this correlating?"** | Each session's share of *local dollar spend* over the last 5 hours, with an on-screen explanation of why that is **not** the same as the metered window percentage (see [Quota](#quota-gauges)). |
| **Sessions table** | One row per session: working folder, status chip, model, live tool, turns, tokens split into in / out / cache-read / cache-write, cost, idle time, and a spend sparkline (last 10 minutes). A session's numbers include its subagents. Tick "show unknown/old" to include stale sessions. |
| **Side panel** | Click a session to see its timeline from the transcript: your prompts, assistant text, tool calls with arguments, tool results and errors. |
| **Log** | Live event stream (hook events and tool errors), filterable by session and by level (warn / error). |

The page is a single HTML file served from memory and updated over Server-Sent Events. No framework, no build.

---

## How it works

```
 ~/.claude/projects/**/*.jsonl  (transcripts Claude Code already writes)
            │  poll every 2 s, read only new bytes
            ▼
        Tailer  ───────────────►  Store (token accounting, in memory)
   lib/tail.mjs                    lib/store.mjs  + lib/prices.mjs
                                        │                    │
 Claude Code hooks (optional)           │ one row per API    │ per-session totals,
   hook.mjs ──POST /ingest──►           │ call               │ charges for charts
                                        ▼                    ▼
                                 SQLite history         server.mjs  ──SSE + JSON──►  browser UI
                                 lib/db.mjs                  ▲                        /api/state
                                 ~/.cc-ctl/history.db        │                        /api/query
                                                             │
                              Quota poller (every 4 min) ────┘
                              lib/quota.mjs → api.anthropic.com
```

1. **Claude Code writes transcripts.** Every session appends JSON lines to `~/.claude/projects/<project>/<session-id>.jsonl`. Subagents write to `<session-id>/subagents/agent-<id>.jsonl` with a small `.meta.json` beside it (agent type and description). cc-ctl only **reads** these files.
2. **The tailer** scans that directory every 2 seconds, remembers a byte offset per file, and reads only what was appended. It copes with partial last lines, truncation, rotation, deleted files and malformed lines (skipped, never fatal). Files are read oldest first so a parent session is seen before any fork of it.
3. **The store** turns transcript lines into token counts and cost, de-duplicating API calls (next section).
4. **The server** combines the store with live hook events and the quota reading into one state object, pushes it to the browser every 2 seconds, and writes every API call to SQLite.
5. **Hooks are optional.** Without them you still get tokens, cost, turns and status, all derived from transcripts. With them you also get the live tool name, permission prompts and explicit session end.

State in memory is rebuilt from transcripts on every start, so nothing is lost if you stop the server. The SQLite history persists on disk.

---

## Token accounting (the part that must be right)

Two traps make naive counting wrong. cc-ctl handles both and has tests for them (`test/accounting.mjs`).

### Trap 1: one API call becomes several transcript lines

Claude Code writes one JSON line per *content block* (thinking, text, each tool call) of a single API response. All of them carry the same `message.id` and the same usage numbers. Some versions also write growing `output_tokens` as the response streams.

- Summing every line **over-counts** (about 1.9x on real data).
- Ignoring repeats **under-counts** when output grows.

cc-ctl keeps a global map `message.id → { owner session, highest output seen }`:

| Situation | Action |
|---|---|
| First time this id is seen | Charge the full usage, count one API call. |
| Same session, higher `output_tokens` | Charge only the **difference**. |
| Same session, equal or lower output | Ignore. |
| Id already owned by a **different** session | Charge nothing (Trap 2). |

Lines with no `message.id`, no usage, or model `<synthetic>` are ignored.

### Trap 2: forks and restarts

`claude --fork-session` (and resuming) copies the parent transcript into a new file. The same global map means the copy charges **nothing**, and the parent's totals are unchanged. It also makes a server restart idempotent: re-reading a whole file changes no totals.

The owner of a message is the session id taken from the **file name**, not from the `sessionId` field inside the line (forks can keep the parent's in-line id).

---

## Cost

Cost is **computed locally**: tokens x a price table in `lib/prices.mjs`, in USD per million tokens.

- Each model has its own rates for input, output, cache read, 5-minute cache write and 1-hour cache write. Cache read is **not** always 0.1x of input (for example 0.05x on Opus 5.5, 0.025x on Fable 5.1), so each model carries its own cache-read price.
- If a line includes `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, each is priced at its own rate. If there is no breakdown, all cache creation is assumed to be 5-minute. Any unattributed remainder is treated as 5-minute.
- **Model matching** is by longest prefix on a `-` boundary, after stripping a trailing `-YYYYMMDD` date stamp and any `[1m]`-style suffix. So `claude-opus-4-8-20260528`, `claude-opus-4-8` and `claude-opus-4-8[1m]` all resolve to `claude-opus-4-8`, and `claude-opus-5-5` is not mistaken for `claude-opus-5`.
- **Unknown models are never priced at $0 silently.** The session gets an "unpriced" chip, the header lists the model ids, and tokens are still counted.
- The table records its source and fetch date at the top of the file. **It is hand-maintained.** When Anthropic ships a model or changes prices, add a row.

Not modelled (so real list-price cost can be higher): fast-mode premium pricing, the 1.1x US-only inference multiplier, and batch discounts. The figure is also list **API** price, not what your Max plan charges.

---

## Session status

Status is derived from the last **completed** activity, not the last hook. That matters: an agent stuck on a permission prompt fires hooks but has completed nothing, so it must not look busy.

"Completed activity" is any of: a user line in the transcript (your prompt or a tool result), an assistant line that contains no pending tool call, or (if hooks are installed) `PostToolUse`, `PostToolUseFailure`, `Stop`, `UserPromptSubmit`. Subagent activity also counts for its parent.

Rules, checked in this order:

| Status | Meaning |
|---|---|
| **Suspended** | A `SessionEnd` hook was received. |
| **Unknown** | No activity at all for 15 minutes (for example the daemon was down). |
| **Degraded** | The last tool call failed, nothing has succeeded since, and that failure is under 5 minutes old. |
| **Healthy** | Completed activity in the last 30 seconds. |
| **Idle** | Anything else (30 s up to 15 min since activity). |

There is no explicit "paused" hook in Claude Code. A `PermissionRequest` hook shows as a "⏸ permission" live tool, and the session ages toward Idle while it waits.

---

## Quota gauges

The 5-hour and weekly gauges come from an **undocumented** Anthropic endpoint (`GET https://api.anthropic.com/api/oauth/usage`) that Claude Code itself uses for `/usage`. It is the **only authoritative source** for "how much of my allowance is gone". It may change or break without notice.

- **Token:** cc-ctl reuses the OAuth access token Claude Code already stored. Lookup order: `$CLAUDE_CONFIG_DIR/.credentials.json`, then `~/.claude/.credentials.json`, then (macOS) the login Keychain entry `Claude Code-credentials` (with the `CLAUDE_SECURESTORAGE_CONFIG_DIR` suffix if set). The token is only ever sent to `api.anthropic.com`.
- **User agent:** every request sends `user-agent: claude-code/<version>` (from `claude --version`, or `CLAUDE_CODE_VERSION`). Without it the endpoint puts you in a heavily rate-limited bucket and returns persistent 429s.
- **Polling:** every 4 minutes. More often earns 429s.
- **Normaliser:** two response shapes have been seen and both are accepted: an object `{ five_hour: {utilization, resets_at}, seven_day: {...}, ... }` or an array `[{kind:'session', percent}, {kind:'weekly_scoped', percent, scope:{model:{display_name}}}]`. Model display names on scoped buckets are kept. Buckets the server gives no public name to are shown as "<id> (unnamed by server)".
- **On failure** the last good reading keeps being shown together with the error and its time. The UI never blocks on this.

**Why dollars cannot be converted to the gauge.** The gauge is computed on Anthropic's side over rolling windows. Two reasons the local dollar figure diverges from it:

1. The meter is server-computed and dollar spend is not proportional to it.
2. Cache reads are about 10x cheaper per token in dollars but **still consume metered quota**, so a session that looks nearly free in dollars can still be expensive against the meter.

That is why the dashboard shows the gauge and the local spend share separately and never merges them into one number.

---

## History database

Every API call is stored in SQLite (`node:sqlite`, built into Node 22.13+, so still no dependencies) at `~/.cc-ctl/history.db`. Set `CC_CTL_DB` to move it. On older Node, history is disabled with a warning and the rest of the app works.

One row per API call, table `calls`:

| Column | Meaning |
|---|---|
| `msg_id` (primary key) | The API `message.id`. |
| `ts` | Time of the call (epoch ms). |
| `session_id` | The **parent** session id (for subagents, the session that spawned them). |
| `agent_id`, `agent_type`, `agent_desc` | Set for subagent calls, from the agent's `.meta.json` (for example `implementer`). `NULL` for the main session. |
| `cwd`, `repo` | Working folder and repo name. Repo is the git root of the cwd; git worktrees resolve to the main repo. Falls back to the folder name when no `.git` is found. |
| `model` | Model id as written in the transcript. |
| `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h` | Token counts. |
| `usd` | Local cost estimate. |
| `unpriced` | 1 if the model had no price entry. |

Rows are upserted using each call's final, monotonically growing values (`MAX(...)`), so restarts, replays and partial streams never double count. Writes are batched every 500 ms.

You can also query it directly: `sqlite3 ~/.cc-ctl/history.db "select repo, round(sum(usd),2) from calls group by repo order by 2 desc"`.

---

## Query API and CLI

Meant for you and for Claude Code. Start with `GET /api/help`, which lists endpoints, parameters, group names, row shape and the CLI path.

### `GET /api/state`
The current situation as JSON: sessions (status, model, live tool, tokens, cost, subagent count, repo), totals, the chart series, and the quota buckets with `fetchedAt`/`error`. Add `?logs=50` to include the last 50 log lines.

### `GET /api/query`
Aggregates from the history database.

| Parameter | Meaning |
|---|---|
| `since`, `from`, `to` | Time range: `3d`, `12h`, `30m`, `2w`, an ISO date, or epoch ms. `since` and `from` are the same. |
| `repo` | Substring match on the repo name. |
| `agent` | Substring match on agent type **or** description. `main` is the main session. |
| `agent_id` | Exact agent id. |
| `session` | Session id **prefix**. |
| `model` | Substring match on model id. |
| `group_by` (alias `group`) | Comma list of: `day`, `hour`, `repo`, `agent`, `agent_id`, `session`, `model`, `cwd`. |
| `limit` | Max rows (default 200, max 2000). |

Unknown parameters or group names return HTTP 400 listing the allowed values. Each grouped row has a stable `key` (group values joined by ` / `) plus one field per group name, then `calls`, `input`, `output`, `cache_read`, `cache_write`, `usd`, `unpriced_calls`, `first_ts`, `last_ts`. The response also has a `total` row for the same filters.

```sh
curl "localhost:8080/api/query?since=3d&repo=myrepo&group=agent"
```

```json
{ "group_by": ["agent"],
  "rows": [ { "key": "implementer", "agent": "implementer", "calls": 7881, "input": 15762,
              "output": 4120000, "cache_read": 1400000000, "cache_write": 30000000, "usd": 435.1 } ],
  "total": { "calls": 13200, "usd": 873.0 } }
```

### CLI

```sh
node query.mjs --since 3d --repo myrepo --group agent      # the example question
node query.mjs --since 7d --group day,repo
node query.mjs --session 4f2a9c1e --group agent            # cost of one session incl. subagents
node query.mjs state                                       # sessions + quota as compact JSON
node query.mjs ... --json                                  # raw API response
```

Flags: `--since --from --to --repo --agent --agent_id --session --model --group --limit --json`. It talks to the running server (`CC_CTL_PORT` if you changed the port).

**Letting Claude Code use it:** add a line to your `CLAUDE.md`, for example:

> For usage questions run `node /path/to/cc-ctl/query.mjs --since 3d --group agent`, or read `http://localhost:8080/api/help`.

Note that a repo-level number covers **every** session working on that repo. Use `--session` to isolate one.

---

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `--port N` / `CC_CTL_PORT` | `8080` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address. The Docker image sets `0.0.0.0`. There is **no authentication**, so only expose it on trusted interfaces. |
| `--backfill-all` | off | Re-read every transcript ever written. Safe to repeat (idempotent). Runs automatically when the history database is empty. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where transcripts and credentials live. |
| `CC_CTL_DB` | `~/.cc-ctl/history.db` | History database path. |
| `CLAUDE_CODE_VERSION` | from `claude --version` | User-agent version for the quota poller (needed where `claude` is not installed, e.g. Docker). |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | unset | macOS Keychain service-name suffix, if you use one. |

---

## Hooks

Hooks are optional and only add liveness: the current tool, permission prompts, explicit session end, and faster "tool failed" detection.

```sh
node hook.mjs --print-settings
```

Paste the printed `"hooks"` block into `~/.claude/settings.json`. It registers `hook.mjs` for: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `PreCompact`, `PostCompact`, `SessionEnd`. (The current hooks reference lists 33 events; the rest carry no liveness signal. The reasoning is in `lib/events.mjs`.)

`hook.mjs` runs on **every tool call**, so it is built to be harmless:

- It prints nothing and **always exits 0**, even if the server is down, hung, or the input is garbage. It has a hard 800 ms cap. Claude Code is never blocked or broken by it.
- It **never forwards `tool_input` or `tool_response`** (a single Write can be megabytes). It sends only the tool name, a short derived summary (for example a command's first 80 characters), and small fields like session id, cwd, host name and parent pid.
- It posts to `http://127.0.0.1:8080/ingest` (`CC_CTL_PORT` to change). It needs Node on the machine running Claude Code, even if the server runs in Docker.

---

## Docker

```sh
docker compose up -d
```

- The compose file mounts your Claude config **read-only** at `/claude` and keeps history in the `cc-ctl-data` volume.
- The port is published on `127.0.0.1` only.
- Set `CLAUDE_DIR` if your config is not `~/.claude` (PowerShell: `$env:CLAUDE_DIR="$env:USERPROFILE\.claude"`).
- On Linux, pass `CC_UID=$(id -u) CC_GID=$(id -g)` so the container can read your `0600` credentials file.
- Set `CLAUDE_CODE_VERSION` to your `claude --version` for the quota poller.

Differences from running natively: repo names fall back to the last folder of the cwd (the container cannot see your `.git` folders), and on macOS the quota gauges will not work because the OAuth token is in the Keychain, not a file.

---

## Which numbers are exact, estimated, or server-reported

| Number | Kind | Notes |
|---|---|---|
| Tokens (in / out / cache-read / cache-write), API calls | **Exact** | From transcripts, de-duplicated by `message.id`. |
| Cost ($) | **Estimate** | Tokens x hand-maintained list prices. Not your plan's bill. |
| 5-hour / weekly gauges | **Server-reported** | Undocumented endpoint, may break. Only authoritative allowance figure. |
| Status | **Derived** | Heuristic from last completed activity. |
| Turns | **Derived** | Count of your prompts seen in transcripts. |
| Local spend share | **Estimate** | Dollar share, explicitly not the metered percentage. |

---

## Privacy and security

- It reads `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`). The dashboard and API **show prompts, tool arguments and file paths** from those transcripts, to anyone who can reach the port.
- The only outbound request is the quota poll to `api.anthropic.com`, using your existing token. No telemetry; nothing is uploaded anywhere.
- **There is no authentication.** It binds to localhost by default. Do not expose it to a network.
- The UI escapes all transcript content before rendering it.
- cc-ctl never writes to your Claude config or transcripts. It writes only its own SQLite file.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `port 8080 in use` | Another process has it. Use `--port 8090` (and `CC_CTL_PORT=8090` for the CLI and hooks). |
| Empty session list | Check `~/.claude/projects` exists (or set `CLAUDE_CONFIG_DIR`). Tick "show unknown/old". In Docker, check the `/claude` mount. |
| Sessions show as "unknown" | No activity for 15 minutes, or the session predates the server and was not backfilled. Run once with `--backfill-all`. |
| Gauges say "no quota data" | No token found (log in with `claude`), a 429 (it retries at the next 4-minute poll), or the endpoint changed. The error is shown next to the gauges. On macOS in Docker this is expected. |
| "unpriced" chip | The model is not in `lib/prices.mjs`. Add a row. Tokens are still counted. |
| `history disabled: node:sqlite unavailable` | Node is older than 22.13. Upgrade Node. |
| Live tool never appears | Hooks are not installed, or `hook.mjs` points at a moved path. Re-run `node hook.mjs --print-settings`. |
| Docker: cannot read credentials | Pass `CC_UID`/`CC_GID` (Linux) so the container matches the owner of the `0600` file. |
| `query failed (is node server.mjs running?)` | The CLI could not reach the server. Start it or set `CC_CTL_PORT`. |

---

## Known limitations

- **Fork ordering.** The owner of a shared message is whichever session file is read first. Files are read oldest first to make the parent win, but a fork read before its parent would keep the shared messages.
- **Recent subagents only.** Outside `--backfill-all` (and the automatic first-run import), subagent folders are only scanned for sessions touched in the last 48 hours.
- **Quota endpoint** is undocumented and its response shape has changed before.
- **Dollar figures** are list-price estimates and exclude fast mode, US-only inference and batch pricing effects.
- **Model ids** for some legacy or limited-availability models (Mythos, Haiku 3.5) are assumed, see comments in `lib/prices.mjs`.
- Live views (chart, log, sparklines) are kept in memory and reset on restart; totals and history come back from transcripts and SQLite.

---

## Project layout

| File | Role |
|---|---|
| `server.mjs` | HTTP server, SSE, `/ingest`, `/api/*`, status logic, timeline reader, glue between modules. |
| `ui.html` | The whole dashboard (HTML, CSS, JS in one file). |
| `lib/tail.mjs` | Incremental transcript tailer (offsets, partial lines, rotation, truncation, discovery). |
| `lib/store.mjs` | Token accounting with the `message.id` ownership map. |
| `lib/prices.mjs` | Hand-maintained price table, model-id matching, cost function. |
| `lib/quota.mjs` | Token lookup, quota polling, response normaliser. |
| `lib/db.mjs` | SQLite history and the query builder. |
| `lib/events.mjs` | The hook events cc-ctl registers for, with notes. |
| `hook.mjs` | Hook client (also prints the settings block). |
| `query.mjs` | CLI for the query API. |
| `test/accounting.mjs` | Assertions for accounting, tailer, pricing, hook payload. |
| `Dockerfile`, `docker-compose.yml` | Container image and compose file. |

---

## Development

```sh
npm test        # or: node test/accounting.mjs   (no install step)
```

The tests build synthetic transcripts with known answers and assert exact results: one call split over three lines (output 40/80/100 counts as exactly 100 with one API call), two distinct ids, a fork charging nothing, whole-file replay and daemon-restart idempotency, partial and split-UTF-8 lines, truncation, rotation and deletion, cache read / 5-minute / 1-hour write pricing, model-id matching, and the hook payload stripping. CI runs them on Node 22.13 and 24 and smoke-tests the Docker image.

MIT licensed.
