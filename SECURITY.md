# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting: **Security →
Report a vulnerability**.

Include what an attacker can *do*, the smallest reproduction you have, and the
commit you tested. Acknowledgement within 7 days. This is a personal project
maintained by one person — please assume good faith on timing rather than an SLA.

## What matters most here

This code can place real equity orders. Findings are roughly ranked by whether
they can move money without a human:

1. **Anything that places an order without a standing human approval.** The
   whole design is one claim: an order requires a recorded ✅ that is still valid
   at the moment of execution. Break that claim and everything else is decoration.
2. **Anything that turns one approval into two orders.** The `unknown` outcome
   and the replay guard exist because a "failed" message once invited a second
   tap that placed a second real order. Regressions here are severe.
3. **Anything that lets a capability tier grant more than it declares** — in
   particular, anything that gets `place_equity_order` into a tier that is
   supposed to be read-only, or `power` (unrestricted Bash) set from a web form.
4. **Prompt injection that escapes the prompt.** These agents read the open web.
   Reaching a secret, a file outside `/workspace`, or another agent's context is
   in scope. A model being merely *wrong* about a stock is not.
5. **Secret disclosure** — into a prompt, a log, `/proc/<pid>/cmdline`, a
   Telegram message, or an agent's output file.

## Out of scope

- **The model gives bad financial advice.** It is a language model. That is why a
  human has to tap ✅, and why the per-order cap exists.
- **A user configures a huge `MAX_TRADE_USD`.** That is a decision, not a defect.
- **Denial of service against your own NAS.**
- **The Windows test skips.** Documented and deliberate — see the README. Making
  the stub reachable would require `shell: true` or a binary-name override on the
  money path, which is a worse outcome than a skip.

## Deployment expectations

If you deploy differently from this, you own the difference:

- Broker credentials are scoped as tightly as the broker allows. The analyst
  tier is read-only (`get_*`); order-placing tools are granted **only** to the
  executor's per-run allowlist, never platform-wide.
- Options orders and cancels are hard-denied globally, re-applied on every boot.
- Secrets exist only as environment variables on the container that needs them.
  Never in a prompt file, never in a committed file, never echoed to a log.
- The dashboard or control surface is on a private network, behind a password.
  Serving an agent-creating UI unauthenticated is remote code execution.
- `agents/*/state/` is gitignored. If you fork this, keep it that way — it holds
  holdings, approvals, and account values.

## A note on the human gate

Several gates here look redundant. They are not: they fail in different ways.
The kill switch, the approval TTL, the thesis re-check, the replay guard and the
daily cap each assume the others might already be broken.

If you are proposing a change that removes one because another covers it, please
open an issue first and say which failure mode you believe is impossible.

## Supported versions

The `main` branch only. No releases have been cut.
