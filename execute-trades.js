#!/usr/bin/env node
// One-tap trade executor. Called once per scheduler pass by startup.sh.
//
// Scans every portfolio agent's state/execute_queue.json for entries the user
// approved (dashboard Yes button or Telegram ✅). For each pending entry it runs
// a tightly-scoped Claude call that places ONE equity market order capped at
// MAX_TRADE_USD (default $100), logs the result to state/trade_log.json, and
// reports the outcome over Telegram. Options orders and cancels stay deny-listed
// globally (startup.sh); this allowlist only opens place_equity_order.
//
// Kill switch: create /workspace/trading.paused (dashboard "Pause trading" button)
// and nothing executes; pending entries wait.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractJSON, propKey } = require('./notify-proposals.js');

const WS = process.env.WORKSPACE || '/workspace';
const AGENTS = WS + '/agents';
const CAP = Math.max(1, parseInt(process.env.MAX_TRADE_USD || '100', 10) || 100);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
const STALE_MS = 20 * 60 * 1000;
// Per-order wall clock for the claude call. Env-overridable ONLY so the test suite
// can exercise the killed-mid-order path without waiting 5 minutes; production uses
// the default.
const EXEC_TIMEOUT_MS = Math.max(1000, parseInt(process.env.EXEC_TIMEOUT_MS || '300000', 10) || 300000);

// NOTE (2026-08-02): mcp__robinhood__get_equity_orders is deliberately NOT here.
// Without it this executor cannot read back what it actually placed, so order_state
// and est_value are only ever the model's own claim, and an interrupted run can't be
// resolved to placed/not-placed (hence the 'unknown' status below). Adding it would
// be a read-only change that closes both gaps — but widening --allowedTools on the
// money path needs Francesco's sign-off, so it is proposed, not shipped.
const ALLOWED = [
  'mcp__robinhood__get_accounts', 'mcp__robinhood__get_portfolio',
  'mcp__robinhood__get_equity_positions', 'mcp__robinhood__get_equity_quotes',
  'mcp__robinhood__place_equity_order',
].join(' ');

// Deterministic gates (enforced in code, not prompt text):
// only a clean ticker + known action may reach the order prompt, the human Yes in
// decisions.json must still stand at execution time, and the same key can't be
// placed twice within REPLAY_GUARD_HOURS.
const TICKER_RE = /^[A-Z][A-Z.\-]{0,9}$/;
const TRADE_ACTIONS = new Set(['buy', 'add', 'sell', 'trim']);
const REPLAY_HOURS = Math.max(1, parseInt(process.env.REPLAY_GUARD_HOURS || '48', 10) || 48);
const REPLAY_MS = REPLAY_HOURS * 3600 * 1000;

// A recorded Yes expires. The staleness gate below already requires the proposal to
// still stand in the analyst's CURRENT output, but that depends on latest_output.txt
// being intact; this is an independent clock so an approval that sat through a long
// trading.paused window can't fire on a stale thesis. 0 disables.
const APPROVAL_TTL_HOURS = Math.max(0, parseInt(process.env.APPROVAL_TTL_HOURS || '48', 10) || 0);

// Aggregate brakes. MAX_TRADE_USD caps a single order; nothing previously capped how
// many orders one pass (or one day) could place, and the queue holds 50.
const MAX_PER_PASS = Math.max(1, parseInt(process.env.MAX_TRADES_PER_PASS || '3', 10) || 3);
const MAX_PER_DAY = Math.max(1, parseInt(process.env.MAX_TRADES_PER_DAY || '5', 10) || 5);

// Outcomes we may have MOVED MONEY under. 'unknown' means the executor could not
// establish whether an order was placed, so it must block a retry exactly like a
// confirmed placement — see runOne().
const VALID_STATUS = new Set(['placed', 'skipped', 'failed']);
const BLOCKING_STATUS = new Set(['placed', 'unknown']);

// Timestamps in this platform come from three writers in two languages and have
// drifted in format. Parse leniently rather than silently yielding NaN:
//   "2026-08-02T19:30:00.000Z"  telegram-control / started_at   (correct)
//   "2026-08-02 19:30"          telegram-control decisions.json (UTC, no zone)
//   "Jul 27 10:01"              legacy dashboard decisions.json (no year at all)
// The legacy form is why re-proposals were silently suppressed forever: Date.parse
// returned NaN and the TTL check treated NaN as "just decided".
function parseWhen(s) {
  if (!s) return NaN;
  const str = String(s).trim();
  let t = Date.parse(str);
  if (isFinite(t)) return t;
  t = Date.parse(str.replace(' ', 'T') + 'Z');            // "YYYY-MM-DD HH:MM" as UTC
  if (isFinite(t)) return t;
  const m = str.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/);  // "Jul 27 10:01"
  if (m) {
    const y = new Date().getUTCFullYear();
    const mk = (yy) => Date.parse(`${m[1]} ${m[2]}, ${yy} ${m[3]}:${m[4]} UTC`);
    const a = mk(y);
    if (isFinite(a)) return a <= Date.now() + 86400000 ? a : mk(y - 1);
  }
  return NaN;
}

function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function writeJSON(p, v) { try { const t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, p); } catch (e) {} }

// Persist one entry's new state by re-reading the live queue and merging, so an
// approval appended by telegram-control.js/dashboard while we were executing is
// never clobbered by a stale in-memory copy.
function mergePersist(qp, entry) {
  let cur = readJSON(qp, []);
  if (!Array.isArray(cur)) cur = [];
  const i = cur.findIndex(x => x && x.key === entry.key && x.requested_at === entry.requested_at);
  if (i >= 0) cur[i] = entry; else cur.push(entry);
  writeJSON(qp, cur.slice(-50));
}

// The set of proposal keys the analyst holds RIGHT NOW (from latest_output.txt).
// Returns null when the output is missing/unparsable — callers must fail safe.
// An output that parses but proposes nothing is a valid empty set.
function currentProposalKeys(dir) {
  let txt;
  try { txt = fs.readFileSync(path.join(dir, 'state', 'latest_output.txt'), 'utf8'); } catch (e) { return null; }
  const data = extractJSON(txt);
  if (!data) return null;
  const props = Array.isArray(data.proposals) ? data.proposals : [];
  return new Set(props.map(propKey).filter(Boolean));
}

function rearmNotification(dir, key) {
  const np = path.join(dir, 'state', 'notified_props.json');
  const n = readJSON(np, {}) || {};
  if (n[key]) { delete n[key]; writeJSON(np, n); }
}

// Replay guard, CROSS-AGENT: the same symbol|action must not place twice within
// REPLAY_GUARD_HOURS even when the second Yes arrives through a different
// portfolio agent's button (two analysts can propose the same trade). Scans every
// portfolio agent's queue + trade log, not just this dir's. Returns the folder
// name of the agent that already placed it, or null.
function recentlyPlaced(dir, key, q) {
  const cutoff = Date.now() - REPLAY_MS;
  const hit = (ts) => { const t = parseWhen(ts); return !isFinite(t) || t > cutoff; }; // unparseable = assume recent (fail safe)
  // BLOCKING_STATUS, not just 'placed': an 'unknown' outcome may already have moved
  // money. Treating it as retryable is how one tap could become two real orders.
  const scan = (list, tsOf) => {
    for (const x of (Array.isArray(list) ? list : [])) if (x && x.key === key && BLOCKING_STATUS.has(x.status) && hit(tsOf(x))) return true;
    return false;
  };
  if (scan(q, x => x.started_at || x.requested_at)) return path.basename(dir);
  let names = [];
  try { names = fs.readdirSync(AGENTS); } catch (e) { return 'unknown'; } // cannot verify -> fail safe, block
  for (const n of names) {
    const d = path.join(AGENTS, n);
    if (((readJSON(path.join(d, 'agent.json'), {}) || {}).tools) !== 'portfolio') continue;
    if (d !== dir && scan(readJSON(path.join(d, 'state', 'execute_queue.json'), []), x => x.started_at || x.requested_at)) return n;
    if (scan(readJSON(path.join(d, 'state', 'trade_log.json'), []), x => x.at)) return n;
  }
  return null;
}

function logTrade(dir, e, res) {
  const lp = path.join(dir, 'state', 'trade_log.json');
  let log = readJSON(lp, []);
  if (!Array.isArray(log)) log = [];
  log.push({
    at: new Date().toISOString().slice(0, 16).replace('T', ' '),
    key: e.key, symbol: res.symbol || e.symbol, action: e.action, side: res.side || '',
    quantity: res.quantity || 0, est_value: res.est_value || 0,
    status: e.status, order_state: res.order_state || '', note: e.note, via: e.via || '',
  });
  writeJSON(lp, log.slice(-100));
}
async function tg(text) {
  if (!TOKEN || !CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text: String(text).slice(0, 4000) }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {}
}

function prompt(sym, act) {
  return [
    'You are a trade EXECUTOR, not an analyst. Execute exactly one pre-approved order. Do not reconsider whether it is a good idea.',
    `Order: ${act.toUpperCase()} ${sym}.`,
    'HARD RULES:',
    `- Equity MARKET order only. Maximum order value: $${CAP}.`,
    '- The portfolio is CLOSED: trade only with money already in the account. Never use margin buying power and never assume a deposit is coming.',
    `- BUY or ADD: first read the available CASH balance of my default Individual account (cash, NOT margin/instant buying power). The order value is the LOWER of $${CAP} and that cash. Buy that value of ${sym} (closest fractional/whole-share amount at or under it). If the lower value is under $5, place NO order and report status "skipped" with note "insufficient cash ($<amount> available) — execute a sell/trim first, then tap Yes again".`,
    `- SELL or TRIM: look up my position in ${sym} across accounts; sell up to $${CAP} worth from the account holding it, or the entire position if it is worth less than $${CAP}.`,
    `- HOLD, no position to sell, or anything ambiguous: place NO order and report status "skipped".`,
    '- Place at MOST one order. Never options. Never cancel or modify anything.',
    'Steps: get a current quote for the symbol, compute the quantity, place the order, then output ONLY this JSON (no markdown, no other text):',
    '{"status":"placed|skipped|failed","symbol":"","side":"buy|sell","quantity":0,"est_value":0,"order_state":"<state reported by the API>","note":"<one concise line>"}',
  ].join('\n');
}

// A parsed verdict is trustworthy even if the process later died: the executor had
// already printed its final JSON. What is NOT trustworthy is the absence of one —
// the 300s timeout can kill claude AFTER place_equity_order returned, and a model can
// exit 0 having placed an order but emitted prose instead of JSON. Both used to be
// recorded 'failed', and because the replay guard only matched 'placed', the natural
// response to "🔴 Trade failed" — tapping ✅ again — placed a SECOND real order.
// There is no read-back available here (see the get_equity_orders note in ALLOWED),
// so the honest answer is 'unknown', and 'unknown' blocks retries until a human looks.
function runOne(entry) {
  const r = spawnSync('claude', ['-p', prompt(entry.symbol, entry.action), '--allowedTools', ALLOWED],
                      { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS });
  const out = (r.stdout || '') + '';
  const res = extractJSON(out);
  if (res && VALID_STATUS.has(String(res.status))) return res;
  // Node reports a spawnSync timeout as error.ETIMEDOUT, not as a signal — so check
  // both, or the most likely mid-order death gets the vaguest message.
  const timedOut = !!r.signal
    || (r.error && (r.error.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(String(r.error.message || r.error))));
  const why = timedOut ? ('timed out at the ' + Math.round(EXEC_TIMEOUT_MS / 1000) + 's cap'
                          + (r.signal ? ' (killed by ' + r.signal + ')' : ''))
            : r.error ? ('spawn error: ' + (r.error.message || r.error))
            : (r.status !== 0 ? ('exited ' + r.status + ' with no verdict')
                              : 'no parsable result');
  return { status: 'unknown', symbol: entry.symbol, side: '', quantity: 0, est_value: 0,
           order_state: '',
           note: ('UNVERIFIED — ' + why + '. The order may or may not have been placed; '
                  + 'check Robinhood before approving this again.').slice(0, 200) };
}

// Orders already placed (or unverifiable) today, across every portfolio agent.
// Unreadable state means we cannot prove we are under the cap -> fail closed.
function placedToday() {
  const today = new Date().toISOString().slice(0, 10);
  let names = [];
  try { names = fs.readdirSync(AGENTS); } catch (e) { return Infinity; }
  let n = 0;
  for (const nm of names) {
    const d = path.join(AGENTS, nm);
    if (((readJSON(path.join(d, 'agent.json'), {}) || {}).tools) !== 'portfolio') continue;
    for (const x of (readJSON(path.join(d, 'state', 'trade_log.json'), []) || [])) {
      if (x && BLOCKING_STATUS.has(x.status) && String(x.at || '').slice(0, 10) === today) n++;
    }
  }
  return n;
}

async function run() {
  if (fs.existsSync(WS + '/trading.paused')) return;
  let dirs = [];
  try { dirs = fs.readdirSync(AGENTS); } catch (e) { return; }
  let thisPass = 0;
  let today = placedToday();
  for (const n of dirs) {
    const dir = path.join(AGENTS, n);
    const meta = readJSON(path.join(dir, 'agent.json'), null);
    if (!meta || meta.tools !== 'portfolio') continue;
    const qp = path.join(dir, 'state', 'execute_queue.json');
    let q = readJSON(qp, []);
    if (!Array.isArray(q) || !q.length) continue;
    // Funding order: sells/trims run before buys/adds within a pass, so an
    // approved sell frees the cash before the buy it funds is attempted
    // (closed portfolio — buys are capped at available cash, never margin).
    const isSell = (x) => { const a = String(x && x.action || '').toLowerCase(); return a === 'sell' || a === 'trim'; };
    const ordered = [...q].sort((a, b) => (isSell(a) ? 0 : 1) - (isSell(b) ? 0 : 1));
    for (const e of ordered) {
      // Kill switch re-checked before EVERY order, not once per pass. With up to 50
      // queued entries at 300s each, a single pass could run for hours, during which
      // the dashboard's Pause button had no effect at all.
      if (fs.existsSync(WS + '/trading.paused')) {
        await tg('⏸ Trading paused — any remaining approved orders are still pending and will resume when you unpause.');
        return;
      }
      // A 'running' entry older than STALE_MS means the executor died mid-order. We
      // cannot know whether the broker call completed, so this is 'unknown' (which
      // blocks retries), never 'failed' (which invites a second real order).
      if (e.status === 'running' && e.started_at && (Date.now() - parseWhen(e.started_at)) > STALE_MS) {
        e.status = 'unknown';
        e.note = 'UNVERIFIED — executor died mid-order; check Robinhood before approving again';
        mergePersist(qp, e); logTrade(dir, e, {});
        await tg(`🟠 Trade UNVERIFIED: ${String(e.action || '').toUpperCase()} ${e.symbol} — the executor died while the order was in flight. Check Robinhood: it may or may not have been placed.`);
        continue;
      }
      if (e.status !== 'pending') continue;

      const sym = String(e.symbol || '').toUpperCase().trim();
      const act = String(e.action || '').toLowerCase().trim();
      if (!TICKER_RE.test(sym) || !TRADE_ACTIONS.has(act)) {
        e.status = 'failed'; e.note = 'rejected: invalid symbol or action';
        mergePersist(qp, e); logTrade(dir, e, {});
        await tg(`🔴 Trade rejected: "${String(e.symbol).slice(0, 20)}" "${String(e.action).slice(0, 20)}" — invalid symbol or action.`);
        continue;
      }
      e.symbol = sym; e.action = act;

      const decs = readJSON(path.join(dir, 'state', 'decisions.json'), {}) || {};
      const d = decs[e.key];
      if (!d || d.decision !== 'yes') {
        e.status = 'skipped'; e.note = 'no active Yes at execution time (undone or cleared)';
        mergePersist(qp, e); logTrade(dir, e, {});
        await tg(`⚪ Trade skipped: ${act.toUpperCase()} ${sym} — approval was withdrawn before execution.`);
        continue;
      }

      // Approval expiry. d.at was previously ignored entirely, and decisions.json is
      // never pruned, so a months-old Yes stayed executable forever. Unparseable or
      // missing timestamps fail CLOSED: we cannot establish freshness, so we skip and
      // re-arm the notification rather than place on an approval of unknown age.
      if (APPROVAL_TTL_HOURS > 0) {
        const at = parseWhen(d.at);
        const ageH = isFinite(at) ? (Date.now() - at) / 3600000 : null;
        if (ageH === null || ageH > APPROVAL_TTL_HOURS) {
          e.status = 'skipped';
          e.note = ageH === null
            ? 'approval has no readable timestamp — re-approve to execute'
            : `approval expired (${Math.round(ageH)}h old, limit ${APPROVAL_TTL_HOURS}h)`;
          mergePersist(qp, e); logTrade(dir, e, {});
          try { rearmNotification(dir, e.key); } catch (err) {}
          await tg(`⚪ Trade skipped: ${act.toUpperCase()} ${sym} — ${e.note}. You'll get a fresh Yes/No if it's re-proposed.`);
          continue;
        }
      }

      // Staleness gate: the approved proposal must still stand in the analyst's
      // CURRENT output. A Yes tapped on a weeks-old Telegram button must never
      // fire on a thesis the monitor no longer holds; unreadable output = skip.
      // Skipping re-arms the notification so a re-proposal sends a fresh button.
      const liveKeys = currentProposalKeys(dir);
      if (!liveKeys || !liveKeys.has(e.key)) {
        e.status = 'skipped';
        e.note = liveKeys ? 'stale: proposal no longer in the latest analysis'
                          : 'skipped: latest analysis missing or unreadable';
        mergePersist(qp, e); logTrade(dir, e, {});
        try { rearmNotification(dir, e.key); } catch (err) {}
        await tg(`⚪ Trade skipped: ${act.toUpperCase()} ${sym} — proposal no longer stands in the latest analysis. If it's re-proposed you'll get a fresh Yes/No.`);
        continue;
      }

      const dupBy = recentlyPlaced(dir, e.key, q);
      if (dupBy) {
        const who = dupBy === n ? '' : ` by ${dupBy}`;
        e.status = 'skipped'; e.note = `duplicate: ${e.key} already placed within ${REPLAY_HOURS}h${who}`;
        mergePersist(qp, e); logTrade(dir, e, {});
        await tg(`⚪ Trade skipped: ${act.toUpperCase()} ${sym} — same order already placed within ${REPLAY_HOURS}h${who}.`);
        continue;
      }

      // Aggregate brakes, checked last so a capped pass leaves the entry PENDING
      // (not skipped) and it runs on the next pass / next day.
      if (thisPass >= MAX_PER_PASS || today >= MAX_PER_DAY) {
        const which = today >= MAX_PER_DAY
          ? `daily limit reached (${MAX_PER_DAY} orders)`
          : `per-pass limit reached (${MAX_PER_PASS} orders)`;
        await tg(`⏸ Trade executor stopped: ${which}. ${act.toUpperCase()} ${sym} and any others stay pending — they'll run once the limit resets.`);
        return;
      }

      e.status = 'running'; e.started_at = new Date().toISOString(); mergePersist(qp, e);

      const res = runOne(e);
      e.status = VALID_STATUS.has(String(res.status)) ? String(res.status) : 'unknown';
      e.note = String(res.note || '').slice(0, 200);
      mergePersist(qp, e);
      logTrade(dir, e, res);
      // Count anything that may have moved money against both brakes.
      if (BLOCKING_STATUS.has(e.status)) { thisPass++; today++; }

      // Cap tripwire: est_value is executor-reported, so this can't prevent an
      // over-cap fill — but it deterministically halts all further trading and
      // alerts the moment one is reported.
      if (e.status === 'placed' && Number(res.est_value) > CAP * 1.1) {
        try { fs.writeFileSync(WS + '/trading.paused', 'auto: cap tripwire — reported est_value over MAX_TRADE_USD\n'); } catch (err) {}
        await tg(`🛑 Cap tripwire: executor reported ~$${res.est_value} for ${act.toUpperCase()} ${sym}, over the $${CAP} cap. Trading paused — review the trade log, then unpause from the dashboard.`);
      }

      const icon = e.status === 'placed' ? '🟢'
                 : e.status === 'skipped' ? '⚪'
                 : e.status === 'unknown' ? '🟠' : '🔴';
      const label = e.status === 'unknown' ? 'UNVERIFIED' : e.status;
      await tg(`${icon} Trade ${label}: ${e.action.toUpperCase()} ${e.symbol}` +
               (res.est_value ? ` · ~$${res.est_value}` : '') +
               (res.order_state ? ` · ${res.order_state}` : '') +
               (e.note ? `\n${e.note}` : '') +
               (e.status === 'unknown'
                 ? `\n\nThis will NOT retry on its own — re-approving is blocked for ${REPLAY_HOURS}h so one tap can't become two orders.`
                 : ''));
    }
  }
}

module.exports = { run, parseWhen, placedToday };

if (require.main === module) { run().then(() => process.exit(0)).catch(() => process.exit(0)); }
