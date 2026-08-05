# Contributing

Thanks for looking. Read this before writing code — it will save you time.

This runs against one person's real brokerage account. It is published because
the safety engineering may be useful to read, not because it wants features.
**Bug reports, security findings and documentation corrections are very welcome.
Feature PRs mostly are not** — open an issue first.

## Setup

Node 20+. No dependencies to install.

```bash
node tests/execute-trades.test.js
```

On Linux/macOS everything runs. **On Windows a large part of the suite SKIPs and
says so** — see the README for why that is the correct behaviour rather than
something to fix. If you are changing anything in `execute-trades.js`, verify on
Linux, macOS, or in a container. A skipped run is not a passing run, and the
output tells you so.

Before pushing:

```bash
for f in *.js tests/*.js; do node --check "$f"; done
for f in *.sh; do bash -n "$f"; done
shellcheck --severity=warning startup.sh run-agent.sh
```

`startup.sh` and `run-agent.sh` are load-bearing for every agent. A quoting error
in either takes the whole platform down, quietly, at the next boot.

## The bar

1. **Tests exist for the new behaviour, you ran them, and you report the real
   result** — including failures, and including whether anything skipped.
2. **Failure paths are handled**: empty input, dead network, killed mid-order,
   duplicate event, unreadable state. On this code path, "unreadable state" must
   fail *closed*.
3. **It logs enough to diagnose at 3 a.m.** without the source in front of you.
4. **Comments say why, not what.** The convention here is that a comment records
   the defect that motivated the code. Read the `unknown` status discussion in
   `execute-trades.js` for the house style.

## Will be declined

- **Anything that lets an order be placed without a standing human approval.**
  Including "just for paper mode", "behind a flag", or "only when confident".
  This is the invariant the repo exists to demonstrate.
- **Automating the ✅ tap.** Same rule, said again because it gets proposed.
- **Widening the executor's `--allowedTools`.** Even read-only additions. There
  is a comment in `execute-trades.js` proposing exactly one such addition and
  explaining why it was not shipped; that is the process.
- **Removing a gate because another one covers it.** They fail differently and
  each assumes the others may already be broken. If you think one is genuinely
  redundant, open an issue and name the failure mode you believe is impossible.
- **Giving the executor `shell: true`** or an env-var override of the binary
  name to make the Windows tests pass. That puts an arbitrary-command vector on
  the money path to turn a SKIP into a PASS.
- **New runtime dependencies.** This is deliberately dependency-free Node and
  POSIX sh.

## Pull requests

One logical change each. Say what you ran and what it printed. If you think the
approach is wrong, say so in a sentence — that is inside the contract.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
