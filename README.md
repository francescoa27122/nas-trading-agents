# nas-trading-agents

A scheduler that runs LLM agents on a home NAS, and a one-tap trade executor that
places equity orders **only** after a human has explicitly approved that specific
trade.

This is the part of a larger self-hosted agent platform that deals with money. It
is published because the interesting engineering is not "an LLM can call a broker
API" — that part is easy and mostly a bad idea. The interesting part is everything
built to stop it going wrong.

> **Nothing here trades on its own.** The model analyses and proposes. A human taps
> ✅. Only then does a separate, tightly-scoped process place a single order, capped
> in dollars, capped per pass, capped per day, and re-checked against the approval
> at the moment of execution. If any check cannot be satisfied, it does not trade.

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
| `read` | `WebSearch WebFetch` |
| `actions` | + `Bash(curl:*)` |
| `portfolio` | + read-only broker tools (`get_*` only) |
| `power` | + `Bash Read Write Edit` — unrestricted; never set from a web form |

`portfolio` is read-only by construction. No analyst, however confused, can place
an order.

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
