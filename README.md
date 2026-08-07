# nas-trading-agents

**A scheduler that runs LLM agents on a home NAS, and a one-tap trade executor
that places an equity order only after a human has approved that exact trade.**

An agent is a folder: an `agent.json` and a `prompt.md`. No registry, no
database, no control plane — the filesystem *is* the state, so "what is this
thing about to do?" is answerable with `cat`. Two shell scripts and ~380 lines
of JavaScript run the whole thing.

Published because the interesting engineering is not "an LLM can call a broker
API" — that part is easy and mostly a bad idea. The interesting part is
everything built to stop it going wrong.

> **Nothing here trades on its own.** The model analyses and proposes. A human taps
> ✅. Only then does a separate, tightly-scoped process place a single order, capped
> in dollars, capped per pass, capped per day, and re-checked against the approval
> at the moment of execution. If any check cannot be satisfied, it does not trade.

## What is interesting in here

Most of this is reusable whether or not you care about trading:

- **Capability tiers as a real boundary.** An agent's `agent.json` names a tier;
  `run-agent.sh` maps it to an explicit `--allowedTools` list. The analyst tier
  is read-only *by construction* — no analyst, however confused or prompt-injected,
  can place an order, because the tool is not in its process.
- **Four execution outcomes, not three.** `placed`, `skipped`, `failed`, and
  **`unknown`** — the one that matters. See [the bug this design is really
  about](#the-bug-this-design-is-really-about); it is the difference between one
  order and two.
- **Prompt-injection hardening that was earned, not designed.** `{{ENV:}}`
  substitution is allowlisted per agent and platform secrets are never injectable;
  `{{FILE:}}` is scanned from `prompt.md` only, because scanning the *substituted*
  text made a model able to trigger a file read on the **next** run by emitting a
  literal placeholder. Prompts go in on **stdin, not argv** — as an argument they
  were readable via `/proc/<pid>/cmdline` by every other process in the container.
- **A scheduler that tolerates its own agents.** Window-matching rather than
  exact-minute firing, because a long agent run used to block the loop past the
  target minute and silently skip the schedule for that day.
- **Circuit breakers.** An agent that fails `CIRCUIT_BREAKER_FAILS` times in a row
  pauses itself instead of failing loudly forever.
- **Tests that SKIP loudly rather than lie.** On Windows a large part of the suite
  cannot run, and it says so — see [Running the tests](#running-the-tests) for why
  making it "work" would put an arbitrary-command vector on the money path.

## Run it yourself

**What you need:** Docker, a [Claude Code](https://claude.com/claude-code) OAuth
token or API key, a Telegram bot (for the approval buttons), and — only if you
want the executor to do anything — a broker MCP server. This repo deliberately
ships **no** broker credentials and no MCP server; you supply your own.

This is an extract of the money path from a larger platform, so there is no
`docker-compose.yml` here. The container contract is small enough to state in
full:

1. Mount this repo at **`/workspace`** (the paths in `startup.sh` are absolute).
2. Run on Node 20+ with the `claude` CLI available — `startup.sh` will
   `npm install -g @anthropic-ai/claude-code` if it is missing.
3. Set the environment (see [Configuration](#configuration)); at minimum
   `CLAUDE_CODE_OAUTH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
4. `bash /workspace/startup.sh`

Roughly:

```bash
docker run -d --name agents \
  -v "$PWD:/workspace" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  -e TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" \
  -e TELEGRAM_CHAT_ID="$TELEGRAM_CHAT_ID" \
  -e MAX_TRADE_USD=100 \
  node:20 bash /workspace/startup.sh
```

**Start with the executor disarmed.** Every shipped agent is read-only analysis;
nothing places an order until you wire a broker MCP server *and* tap ✅. To watch
the machinery without any broker at all, set every agent to `"enabled": true` and
read the Telegram proposals — the executor simply finds no approvals to act on.

### Your first agent

```bash
mkdir -p agents/my-agent/state
cat > agents/my-agent/agent.json <<'JSON'
{
  "name": "My Agent",
  "description": "What it does, in one line",
  "schedule": "daily 08:30",
  "enabled": true,
  "delivery": "telegram",
  "tools": "read",
  "max_failures": 3
}
JSON
echo "Summarise today's market open in five bullets." > agents/my-agent/prompt.md
```

The scheduler picks it up within ~20 seconds. Things worth knowing before you
wonder why nothing happened:

- **Schedules** are `daily HH:MM`, `weekly Mon,Tue,… HH:MM`, or `interval N`
  (minutes). **`interval` skips its first sighting** — on first sight the
  scheduler only records the timestamp, so a new interval agent fires one full
  interval later, not immediately.
- **`delivery` is push-or-nothing here.** Only `"telegram"` sends anything. Any
  other value (the upstream platform uses `"dashboard"`) means the run is
  recorded to `state/` and nothing is pushed — correct for that platform, silent
  in this repo, which ships no dashboard. Start a new agent on `telegram` so you
  can see it working.
- **Reply `SKIP` for quiet success.** An agent whose entire output is `SKIP`
  counts as a successful run with no delivery and no alert. It is how a
  "tell me only if something changed" agent stays silent without looking broken.
- **State lives in `agents/<name>/state/`** — `last_run.json`, `runs.csv`,
  `latest_output.txt`, and per-agent extras like `value_history.csv`. Raw model
  transcripts go to `agents/<name>/logs/`, *beside* `state/`, not inside it.
  `state/` is gitignored and stays that way — it holds holdings and approvals.

---

## Why this exists

An LLM that can both decide *and* execute is one hallucination away from an
expensive afternoon. So decision and execution are different processes, with
different permissions, and a human in between:

| | analyst agents | executor |
|---|---|---|
| what it is | `claude -p` with a prompt | `execute-trades.js` |
| broker access | **read-only** (`get_*` only) | one tool: `place_equity_order` |
| can place an order | no | yes, if a human said yes |
| runs | on a schedule | once per scheduler pass |

The analyst physically cannot place an order — the capability tier it runs under
does not grant the tool. The executor can, but it will not start without finding a
recorded human approval that still stands.

## The gates

Every one of these is enforced in code, not in prompt text. A prompt is a
suggestion; this is the part that has to be true.

**Before an order is attempted**

1. **Kill switch.** `trading.paused` exists → nothing runs. Re-checked before
   *every* order, not once per pass — with a queue of 50 and a 300s cap per order,
   a single pass can run for hours, and "Pause" has to mean now.
2. **Shape.** Ticker must match `^[A-Z][A-Z.\-]{0,9}$`; action must be one of
   buy / add / sell / trim. Anything else is rejected without reaching the model.
3. **The approval still stands.** `decisions.json` is re-read at execution time.
   An approval that was withdrawn between the tap and the order is skipped.
4. **The approval has not gone stale.** A recorded yes expires (default 48h).
   Unparseable or missing timestamps fail **closed** — an approval of unknown age
   is not an approval.
5. **The thesis still stands.** The proposal must still be present in the
   analyst's *current* output. Yesterday's reasoning does not authorise today's
   order. Unreadable output fails closed.
6. **Not a replay.** The same proposal key cannot execute twice inside the replay
   window (default 48h).
7. **Aggregate brakes.** ≤ `MAX_TRADES_PER_PASS` (3) and ≤ `MAX_TRADES_PER_DAY`
   (5), counted across every agent. Unreadable state counts as *over* the cap.
8. **Per-order cap.** `MAX_TRADE_USD` (default $100).

**Ordering.** Sells and trims run before buys and adds within a pass, so an
approved sell frees the cash before the buy it funds is attempted.

## The bug this design is really about

An order either happened or it did not, and sometimes you cannot tell.

`claude` can be killed by the 300s timeout *after* `place_equity_order` returned.
It can exit 0 having placed an order and then describe it in prose instead of
JSON. Both used to be recorded as `failed` — and because the replay guard only
matched `placed`, the natural human response to "🔴 Trade failed" was to tap ✅
again, which placed **a second real order**.

So there is a fourth outcome, `unknown`, and it blocks retries exactly like a
confirmed placement:

```
placed   → order confirmed. Blocks retry.
skipped  → deliberately not placed. Does not block.
failed   → broker rejected it. Does not block.
unknown  → we cannot establish what happened. BLOCKS RETRY until a human looks.
```

The executor has no read-back tool, on purpose — see the note above `ALLOWED` in
`execute-trades.js`. Adding `get_equity_orders` would close this gap and is a
read-only change, but widening the tool allowlist on the money path is a decision
that belongs to a person, so it is proposed in a comment rather than shipped.

## Layout

```
startup.sh              scheduler; walks every agent ~every 20s, fires the due ones
run-agent.sh            renders one agent's prompt, runs it under a capability tier
execute-trades.js       the only thing here that can place an order
notify-proposals.js     pushes new proposals to Telegram with Yes/No buttons
track-proposals.js      records proposals and refreshes prices (the track record)
telegram-control.js     handles button callbacks; writes the human decision
agents/
  portfolio-monitor/    read-only analyst, every 30 min
  trade-ideas/          3 proposals each market morning
  portfolio-review/     weekly self-grading; its lessons feed back into the prompt
tests/
  execute-trades.test.js
```

Agents are folders. An agent is an `agent.json` (schedule, delivery, capability
tier) plus a `prompt.md`. There is no registry and no database — the filesystem is
the state, which makes "what is this thing about to do" answerable with `cat`.

### Capability tiers

`run-agent.sh` maps a tier to an explicit `--allowedTools` list:

| tier | grants |
|---|---|
| `read` | `WebSearch WebFetch` — also the fallback for any unrecognised value |
| `actions` | + `Bash(curl:*)` |
| `portfolio` | + read-only broker tools (`get_*` only) |
| `google` | + `mcp__google` (Workspace), **not** the broker tools |
| `power` | + `Bash Read Write Edit` — unrestricted; never set from a web form |

`portfolio` is read-only by construction. No analyst, however confused, can place
an order.

Tiers are additive in capability but not cumulative in code — each is an explicit
list in `run-agent.sh`, so reading that `case` statement tells you exactly what an
agent can do. An unknown tier falls back to `read` rather than erroring, which is
the safe direction to fail: a typo in `agent.json` costs you a web search, not a
broker session.

## Prompt-injection hardening

These agents read the open web, so the prompt is hostile input.

- `{{ENV:VAR}}` substitution is **allowlisted per agent** and platform secrets are
  never injectable at all, whatever the prompt says.
- `{{FILE:...}}` reads only `/workspace`, refuses `..`, and refuses
  credential-shaped paths outright. It is scanned from `prompt.md` **only** — an
  earlier version scanned the already-substituted text, so a model that emitted
  the literal string `{{FILE:...}}` into its own output made the *next* run read
  that file. A self-propagating file read, reachable from any page a web-capable
  agent visited.
- The rendered prompt goes in on **stdin, not argv** — as an argument it was
  readable in `/proc/<pid>/cmdline` by every other process in the container, so
  one agent could read another's injected secrets.

## Running the tests

```bash
node tests/execute-trades.test.js
```

**On Windows a large part of the suite SKIPs, and says so loudly.** The test
replaces `claude` with a stub on `PATH`; `execute-trades.js` calls
`spawnSync('claude', …)` with no shell, and Windows resolves a bare command only
to `.exe`, while Node has refused to spawn `.cmd` directly since the
CVE-2024-27980 fix. Making it work would mean giving the executor `shell: true` or
an env-var override of the binary name — either of which puts an arbitrary-command
vector on the one code path that moves money. A SKIP is the correct answer.

Run on Linux, macOS, or in the container for full coverage. A skipped run never
reports as a clean one.

## Configuration

| variable | default | what it does |
|---|---|---|
| `MAX_TRADE_USD` | `100` | per-order cap |
| `MAX_TRADES_PER_PASS` | `3` | orders per scheduler pass |
| `MAX_TRADES_PER_DAY` | `5` | orders per day, across all agents |
| `APPROVAL_TTL_HOURS` | `48` | how long a recorded yes stays valid (`0` disables) |
| `REPLAY_GUARD_HOURS` | `48` | window in which a key cannot execute twice |
| `EXEC_TIMEOUT_MS` | `300000` | wall clock per order |
| `QUIET_HOURS` | unset | `HH:MM-HH:MM`; queue non-urgent messages |
| `CIRCUIT_BREAKER_FAILS` | `3` | consecutive failures before an agent auto-pauses |
| `TELEGRAM_BOT_TOKEN` | — | required for approvals and alerts |
| `TELEGRAM_CHAT_ID` | — | required for approvals and alerts |

Secrets live only as environment variables on the container that needs them. They
are never written into a prompt file or a log.

## Tips and tricks

**Retire an agent with `"enabled": false`, never by deleting the folder.** The
folder holds `state/runs.csv` — the entire history of what that agent did and
whether it worked. Deleting it destroys the track record, which is the one thing
you cannot reconstruct.

**Everything is answerable with `cat` and `tail`.** There is no admin UI to log
into and no database to query:

```bash
cat  agents/trade-ideas/state/last_run.json      # did the last run succeed?
tail agents/trade-ideas/state/runs.csv           # the track record
tail agents/trade-ideas/logs/*.log               # what the model actually said
```

Note `logs/` sits beside `state/`, not inside it.

**A failing agent pauses itself.** After N consecutive failures `run-agent.sh`
rewrites `agent.json` to `"enabled": false` and notifies once, rather than
retrying forever. N is the agent's own `max_failures`, falling back to
`CIRCUIT_BREAKER_FAILS`, then to 3 — and `"max_failures": 0` turns the breaker
off for that agent. **If an agent "stopped working", check `enabled` before you
debug the prompt**: it may have disabled itself days ago.

**Set `QUIET_HOURS` before you add a chatty agent.** Format `HH:MM-HH:MM`.
Non-urgent messages queue to `.msgqueue/` and flush afterwards rather than
waking you at 03:00.

**`MAX_TRADES_PER_DAY` counts across every agent, not per agent.** Adding a
second proposing agent does not double your ceiling — that is deliberate.

**Unreadable state counts as over the cap.** Every aggregate brake fails
*closed*: if the executor cannot parse its own counters, it treats itself as
having hit the limit. Same for approval timestamps — an approval of unknown age
is not an approval.

**Test prompt changes against a disabled agent first.** Set `"enabled": false`,
edit `prompt.md`, then run one pass by hand:

```bash
bash run-agent.sh agents/my-agent
```

That is the same entry point the scheduler uses, so what you see is what it will
do.

**Never set `tools: "power"` on anything that reads the open web.** It grants
`Bash Read Write Edit` with no restriction, and these agents treat web content as
hostile input for good reason. If a prompt is reachable from a web form or a chat
command, `power` turns a prompt injection into arbitrary code execution.

**A skipped test run is not a passing one.** On Windows much of the suite SKIPs
by design (see below). Read the summary line, not the exit code.

## What is deliberately not here

- **The dashboard.** It belongs to a wider platform with unrelated projects in it.
- **Any account state.** No holdings, balances, decisions, or track record — the
  machinery is the point, not one person's positions.
- **Broker credentials or an MCP server.** You supply your own.

## Status and honesty

This runs on one person's NAS against one brokerage account with a $100 per-order
cap. It is not a product, it is not audited, and it has not been run by anyone
else. **It is published as an engineering artifact, not as something to point at
your own money.** If you do anyway, read `execute-trades.js` end to end first —
it is 380 lines and the comments explain what each gate is defending against and
which bug motivated it.

Nothing here is financial advice.

## Licence

MIT — see [LICENSE](LICENSE), including the financial-risk notice.
