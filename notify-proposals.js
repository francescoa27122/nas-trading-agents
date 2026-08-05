#!/usr/bin/env node
// Push NEW portfolio proposals to Telegram with Yes/No inline buttons.
// Called by run-agent.sh after a portfolio run: node notify-proposals.js <AGENT_DIR>
// Never trades — tapping a button records a decision (shared with the dashboard)
// and the bot deep-links to Robinhood for you to execute yourself.
'use strict';
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = String(process.env.TELEGRAM_CHAT_ID || '');

function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function extractJSON(txt) {
  if (!txt) return null;
  let t = txt.trim();
  if (t.startsWith('```')) { t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim(); }
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}
function propKey(p) { return (String(p.symbol || '') + '|' + String(p.action || '')).replace(/^\|+|\|+$/g, ''); }

// A decision or a sent notification only suppresses re-notification for this
// long. Without a TTL each symbol|action could only ever be notified ONCE in
// the platform's life, and a June "no" would gag an August re-proposal forever.
const SUPPRESS_DAYS = Math.max(1, parseInt(process.env.PROPOSAL_SUPPRESS_DAYS || '7', 10) || 7);
const SUPPRESS_MS = SUPPRESS_DAYS * 86400 * 1000;
// Lenient parse: these timestamps come from three writers and have drifted in format
// (ISO with Z, "YYYY-MM-DD HH:MM" in UTC, and legacy dashboard "Jul 27 10:01").
function parseWhen(ts) {
  if (!ts) return NaN;
  const s = String(ts).trim();
  let t = Date.parse(s);
  if (isFinite(t)) return t;
  t = Date.parse(s.replace(' ', 'T') + 'Z');
  if (isFinite(t)) return t;
  const m = s.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const y = new Date().getUTCFullYear();
    const mk = (yy) => Date.parse(`${m[1]} ${m[2]}, ${yy} ${m[3]}:${m[4]} UTC`);
    const a = mk(y);
    if (isFinite(a)) return a <= Date.now() + 86400000 ? a : mk(y - 1);
  }
  return NaN;
}
function withinTTL(ts) { // ts: ISO string, "YYYY-MM-DD HH:MM", or legacy "Jul 27 10:01"
  if (!ts) return false;                                    // absent = never happened, never suppress
  const t = parseWhen(ts);
  // Unparseable now means "do not suppress" (was: "assume recent"). The old choice
  // was permanent silence: the dashboard wrote "Jul 27 10:01", Date.parse returned
  // NaN, and every dashboard-decided proposal was treated as just-decided FOREVER,
  // so it could never be re-proposed. This only gates a NOTIFICATION — the Yes/No
  // buttons still gate execution — so an extra prompt is the cheap failure direction.
  if (!isFinite(t)) return false;
  return (Date.now() - t) < SUPPRESS_MS;
}
function decisionActive(d) { return !!d && (!d.at || withinTTL(d.at)); } // decision missing its timestamp = assume active

// Returns true ONLY when Telegram confirms the send — a proposal is never marked
// notified on a failed/timed-out send, so it retries next run instead of vanishing.
async function sendProposal(agent, text, key) {
  const body = {
    chat_id: CHAT, text: String(text).slice(0, 3900),
    reply_markup: { inline_keyboard: [[
      { text: '✅ Yes', callback_data: `pf:${agent}:${key}:yes` },
      { text: '❌ No',  callback_data: `pf:${agent}:${key}:no` },
    ]] },
  };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => null);
    return !!(j && j.ok);
  } catch (e) { return false; }
}

async function run(dir) {
  if (!TOKEN || !CHAT || !dir) return;
  const agent = path.basename(String(dir).replace(/\/+$/, ''));
  const stateDir = path.join(dir, 'state');
  const data = extractJSON(fs.existsSync(path.join(stateDir, 'latest_output.txt'))
    ? fs.readFileSync(path.join(stateDir, 'latest_output.txt'), 'utf8') : '');
  const proposals = (data && Array.isArray(data.proposals)) ? data.proposals : [];
  if (!proposals.length) return;
  const decided = readJSON(path.join(stateDir, 'decisions.json'), {}) || {};
  const notified = readJSON(path.join(stateDir, 'notified_props.json'), {}) || {};
  let changed = false;
  for (const p of proposals) {
    const key = propKey(p);
    if (!key || decisionActive(decided[key]) || withinTTL(notified[key])) continue; // skip empty / recently decided / recently sent
    const sym = String(p.symbol || '').toUpperCase();
    const act = String(p.action || '').toUpperCase();
    const conf = p.confidence ? ` · conf ${p.confidence}` : '';
    const text = `💡 Proposal — ${act} ${sym}${conf}\n${p.rationale || ''}\n\nTap ✅ to place it automatically (market order, ≤ $${process.env.MAX_TRADE_USD || 100}). ❌ just dismisses.`;
    if (await sendProposal(agent, text, key)) {
      notified[key] = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) {
    // keep the newest 100 entries so the file never grows without bound
    const keys = Object.keys(notified).sort((a, b) => String(notified[a]).localeCompare(String(notified[b])));
    for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete notified[k];
    try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, 'notified_props.json'), JSON.stringify(notified, null, 2)); } catch (e) {}
  }
}

module.exports = { run, propKey, extractJSON, withinTTL, parseWhen, decisionActive };

if (require.main === module) {
  run(process.argv[2]).then(() => process.exit(0)).catch(() => process.exit(0));
}
