#!/usr/bin/env node
// Maintain state/proposal_history.json — the portfolio agent's track record.
// Called by run-agent.sh after a portfolio run: node track-proposals.js <AGENT_DIR>
//
// On every run it: records each NEW proposal with the price at proposal time,
// refreshes last_price / change_pct for every tracked symbol still held, and syncs
// the user's Yes/No decision from decisions.json. run-agent.sh injects this file
// back into the next prompt via {{PROPOSAL_HISTORY}}, so the agent follows up on
// its own past calls instead of proposing from a blank slate each run.
'use strict';
const fs = require('fs');
const path = require('path');
const { extractJSON, propKey } = require('./notify-proposals.js');

function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }

function run(dir) {
  if (!dir) return;
  const stateDir = path.join(dir, 'state');
  const outPath = path.join(stateDir, 'latest_output.txt');
  const data = extractJSON(fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '');
  if (!data) return;
  const histPath = path.join(stateDir, 'proposal_history.json');
  let hist = readJSON(histPath, []);
  if (!Array.isArray(hist)) hist = [];
  const decisions = readJSON(path.join(stateDir, 'decisions.json'), {}) || {};

  const prices = {};
  // Price sources, in order: holdings, follow_ups (the agent is instructed to quote
  // every symbol in its history — keeps dismissed/non-held proposals graded too),
  // and the proposals themselves.
  for (const src of [data.holdings, data.follow_ups, data.proposals]) {
    for (const h of (src || [])) {
      const s = String(h.symbol || '').toUpperCase();
      const p = Number(h.price);
      if (s && isFinite(p) && p > 0 && prices[s] == null) prices[s] = p;
    }
  }

  const known = new Set(hist.map(e => e.key));
  for (const p of (data.proposals || [])) {
    const key = propKey(p);
    if (!key || known.has(key)) continue;
    const sym = String(p.symbol || '').toUpperCase();
    hist.push({
      key, symbol: sym, action: String(p.action || ''),
      confidence: String(p.confidence || ''),
      rationale: String(p.rationale || '').slice(0, 160),
      proposed_at: String(data.as_of || new Date().toISOString()).slice(0, 16),
      price_at_proposal: prices[sym] != null ? prices[sym] : null,
      decision: null, last_price: null, change_pct: null,
    });
    known.add(key);
  }

  for (const e of hist) {
    const d = decisions[e.key];
    if (d && d.decision) e.decision = d.decision;
    const cur = prices[e.symbol];
    if (cur != null) {
      e.last_price = cur;
      if (e.price_at_proposal) {
        e.change_pct = Math.round(((cur - e.price_at_proposal) / e.price_at_proposal) * 1000) / 10;
      }
    }
  }

  hist = hist.slice(-50);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(histPath, JSON.stringify(hist, null, 1));
    fs.writeFileSync(path.join(stateDir, 'track_record.json'), JSON.stringify(grade(hist), null, 1));
  } catch (e) {}
}

// ---- grading: deterministic stats over the proposal history ----
// Directional return: a buy/add call is right when price rose since proposal;
// a sell/trim call is right when it fell (loss avoided). Holds are not graded.
function dirRet(e) {
  if (e.change_pct == null || e.price_at_proposal == null) return null;
  const a = String(e.action || '').toLowerCase();
  if (a === 'buy' || a === 'add') return e.change_pct;
  if (a === 'sell' || a === 'trim') return -e.change_pct;
  return null;
}
function bucket(entries) {
  const rets = entries.map(dirRet).filter(r => r != null);
  if (!rets.length) return { n: entries.length, graded: 0 };
  const wins = rets.filter(r => r > 0).length;
  return {
    n: entries.length, graded: rets.length,
    win_rate_pct: Math.round((wins / rets.length) * 100),
    avg_directional_return_pct: Math.round((rets.reduce((a, b) => a + b, 0) / rets.length) * 10) / 10,
  };
}
function grade(hist) {
  const graded = hist.filter(e => dirRet(e) != null);
  const byDec = (d) => hist.filter(e => (e.decision || 'pending') === d);
  const conf = (c) => hist.filter(e => String(e.confidence || '').toLowerCase() === c);
  const ranked = graded.slice().sort((a, b) => dirRet(b) - dirRet(a));
  const brief = (e) => ({ key: e.key, decision: e.decision || 'pending', confidence: e.confidence || '', directional_return_pct: dirRet(e), proposed_at: e.proposed_at });
  // Paper ledger: what the dismissed calls would have done.
  const dismissed = hist.filter(e => e.decision === 'no' && dirRet(e) != null);
  return {
    updated_at: new Date().toISOString().slice(0, 16),
    note: 'directional_return_pct is positive when the call was RIGHT (buy/add: price rose; sell/trim: price fell). Holds are not graded.',
    overall: bucket(hist),
    by_decision: { yes: bucket(byDec('yes')), no: bucket(byDec('no')), pending: bucket(byDec('pending')) },
    by_confidence: { high: bucket(conf('high')), medium: bucket(conf('medium')), low: bucket(conf('low')) },
    best_calls: ranked.slice(0, 3).map(brief),
    worst_calls: ranked.slice(-3).reverse().map(brief),
    paper_ledger: {
      note: 'dismissed proposals, graded as if approved',
      dismissed_that_would_have_won: dismissed.filter(e => dirRet(e) > 0).map(brief),
      dismissed_that_would_have_lost: dismissed.filter(e => dirRet(e) <= 0).map(brief),
    },
  };
}

module.exports = { run, grade, dirRet };

if (require.main === module) { try { run(process.argv[2]); } catch (e) {} process.exit(0); }
