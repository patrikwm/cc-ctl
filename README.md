# cc-ctl

A local dashboard and usage history for your [Claude Code](https://claude.com/claude-code) sessions. It shows what each session (and each subagent) is doing, how many tokens it used, and what that is worth at list price, next to your real Max-plan quota gauges. Everything runs on your machine. Zero npm dependencies.

- Live session list: status, model, current tool, tokens, cost, sparkline. Click a session for its timeline.
- 5-hour / weekly quota gauges (server-reported, see caveats).
- **History in SQLite**, queryable by repo, agent, session, model, day: *"how many tokens did the `implementer` agent use on repo X three days ago?"*
- JSON API + CLI so Claude Code itself can answer usage questions.

## Run it

**Node (>= 22.13):**

    git clone https://github.com/patrikwm/cc-ctl && cd cc-ctl
    node server.mjs                      # http://localhost:8080

**Docker:**

    docker compose up -d                 # http://localhost:8080
    # Windows PowerShell: $env:CLAUDE_DIR="$env:USERPROFILE\.claude"; docker compose up -d
    # Linux/macOS: CC_UID=$(id -u) CC_GID=$(id -g) docker compose up -d   (lets the container read your 0600 credentials file)

The container mounts your Claude config read-only at `/claude` and keeps history in the `cc-ctl-data` volume. Limits in Docker: repo names fall back to the last folder of the cwd (no `.git` visible), `claude --version` is not available (set `CLAUDE_CODE_VERSION`), and on macOS the OAuth token lives in the Keychain, not a file, so the quota gauges will not work in a container.

The first start imports all existing transcripts (can take a little while); after that only the last 48h are re-read on start. `--backfill-all` forces a full re-import (safe, idempotent). `--port N` or `CC_CTL_PORT` changes the port; `HOST` the bind address (default `127.0.0.1`).

### Optional: live hooks
Transcripts alone give tokens, cost, turns and status. Hooks add the live tool, permission prompts and session end:

    node hook.mjs --print-settings       # paste the "hooks" block into ~/.claude/settings.json

`hook.mjs` never blocks Claude Code: no stdout, always exits 0, 800 ms cap, and it never sends tool input (only tool name and a short summary). It needs Node on the host even if the server runs in Docker.

## Ask questions (for you and for Claude Code)

    node query.mjs --since 3d --repo myrepo --group agent
    node query.mjs --since 7d --group day,repo
    node query.mjs state                 # current sessions + quota as JSON

Or over HTTP: `GET /api/state`, `GET /api/query?since=3d&repo=X&group=agent`, and `GET /api/help` for parameters and row shape. Tip for your `CLAUDE.md`: *"For usage questions run `node /path/to/cc-ctl/query.mjs --since 3d --group agent` or read http://localhost:8080/api/help."*

History lives in `~/.cc-ctl/history.db` (`CC_CTL_DB` to move), table `calls`, one row per API call (subagents included, attributed via their `.meta.json`). Needs Node >= 22.13 (`node:sqlite`); on older Node history is disabled and the rest works.

## Which numbers are what
| Number | Kind |
|---|---|
| Tokens (in / out / cache-read / cache-write), API calls | **Exact**, read from transcripts and de-duplicated by `message.id` (a call spans several lines; forked/resumed sessions and restarts never double count). |
| Cost ($) | **Estimate**: tokens x a hand-maintained list-price table (`lib/prices.mjs`). Not what a Max plan bills. Unknown models show "unpriced", never $0. **Update the table when models or prices change.** |
| 5-hour / weekly gauges | **Server-reported** by an **undocumented** endpoint (`/api/oauth/usage`) using Claude Code's own OAuth token. It may change or break; the last good value is kept and the error shown. Some buckets have no public name and are shown as "unnamed by server". It is the only authoritative view of allowance used; tokens or dollars cannot be converted to it. |
| Status | Derived from the last *completed* activity: healthy < 30 s, idle to 10 min, degraded after an unrecovered tool error, unknown after 15 min of silence. |

## Privacy and security
- Reads `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`). The UI and API show prompts, tool arguments and file paths from those transcripts.
- The only outbound request is the quota poll to `api.anthropic.com`, using your existing token. No telemetry, nothing is uploaded.
- **There is no authentication.** It binds to localhost by default; do not expose it to a network.

## Develop
`npm test` (or `node test/accounting.mjs`) runs the accounting, tailer, pricing and hook assertions. No install step.

MIT licensed.
