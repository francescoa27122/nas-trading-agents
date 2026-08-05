#!/usr/bin/env node
// Tests for execute-trades.js — the money path.
//   node tests/execute-trades.test.js <dir-with-execute-trades.js>
//
// `claude` is replaced by a stub on PATH, so NO real order can be placed. Telegram
// is disabled by leaving TELEGRAM_BOT_TOKEN unset (tg() returns immediately).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = process.argv[2] || path.join(__dirname, '..');
const EXEC = path.join(SRC, 'execute-trades.js');
if (!fs.existsSync(EXEC)) { console.error('no execute-trades.js in ' + SRC); process.exit(1); }

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ett-'));
const WS = path.join(T, 'ws');
const AG = path.join(WS, 'agents', 'portfolio-monitor');
const STUB = path.join(T, 'stub');
const MODEF = path.join(T, 'mode');

let fails = 0;
// Assertions that need the `claude` stub to actually execute cannot run on
// Windows — see STUB_RUNNABLE below. They SKIP loudly rather than FAIL, because
// 11 red lines that are really "wrong operating system" train you to ignore red
// lines, and this is the suite guarding the money path.
let skips = 0;
let needStub = true;          // flipped false before the pure-logic sections
function ck(label, cond, detail) {
  if (needStub && !STUB_RUNNABLE) { skips++; console.log('  SKIP  ' + label + '  (needs an executable `claude` stub)'); return; }
  if (cond) console.log('  PASS  ' + label);
  else { fails++; console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); }
}

// ---- stub `claude` -----------------------------------------------------------
// Written in Node, not /bin/sh, and shipped with a .cmd launcher on Windows.
//
// This stub used to be a `#!/bin/sh` script chmod'd 755. That is unrunnable on
// Windows: spawnSync() resolves a bare command through PATHEXT and cannot honour
// a shebang, so `claude` returned ENOENT, execute-trades.js correctly recorded
// every order as 'unknown', and the suite reported 11 failures that looked like
// product defects and were not. Only the two pure-logic sections passed.
//
// The npm-bin pattern below (a .js payload plus a per-platform launcher) runs
// identically on Linux, macOS and Windows, so a contributor can actually verify
// a change to the money path on the machine they have.
fs.mkdirSync(STUB, { recursive: true });
const PAYLOAD = path.join(STUB, 'claude-stub.js');
fs.writeFileSync(PAYLOAD, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
let mode = '';
try { mode = fs.readFileSync(${JSON.stringify(MODEF)}, 'utf8').trim(); } catch (e) {}
try { fs.appendFileSync(${JSON.stringify(path.join(T, 'calls.log'))}, mode + '\\n'); } catch (e) {}
const R = {
  placed:  '{"status":"placed","symbol":"AAPL","side":"buy","quantity":1,"est_value":90,"order_state":"filled","note":"ok"}',
  over:    '{"status":"placed","symbol":"AAPL","side":"buy","quantity":9,"est_value":900,"order_state":"filled","note":"oops"}',
  skipped: '{"status":"skipped","symbol":"AAPL","side":"","quantity":0,"est_value":0,"order_state":"","note":"no cash"}',
  failed:  '{"status":"failed","symbol":"AAPL","side":"","quantity":0,"est_value":0,"order_state":"","note":"broker rejected"}',
  prose:   'I have placed the order for you.',
};
if (mode === 'exit1') { process.stderr.write('boom\\n'); process.exit(1); }
if (mode === 'hang') {
  // Block the thread for 30s without a 'sleep' binary — exercises the executor's
  // EXEC_TIMEOUT_MS kill path, which is the one that produces 'unknown'.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  process.exit(0);
}
if (mode === 'pause') {
  fs.writeFileSync(${JSON.stringify(path.join(WS, 'trading.paused'))}, '');
  process.stdout.write('{"status":"placed","symbol":"AAPL","side":"buy","quantity":1,"est_value":50,"order_state":"filled","note":"ok"}\\n');
  process.exit(0);
}
if (R[mode]) process.stdout.write(R[mode] + '\\n');
process.exit(0);
`);
// Can the executor actually reach this stub? On Windows, no — and deliberately so.
// execute-trades.js calls spawnSync('claude', ...) with no shell. Windows resolves a
// bare command via CreateProcess, which appends .exe and nothing else, so an
// extensionless launcher is ENOENT; and Node has refused to spawn .cmd/.bat directly
// since the CVE-2024-27980 fix, so a .cmd launcher is EINVAL. Both verified, not
// assumed. The only things that would make it work are giving the executor
// `shell: true` or an env-var override of the binary name — and either one puts an
// arbitrary-command vector on the one code path in this repo that moves money. Not
// a trade worth making to turn a SKIP into a PASS.
//
// Full verification therefore requires Linux, macOS, or the node-1 container, which
// is where this actually runs. CI runs ubuntu-latest for exactly this reason.
const STUB_RUNNABLE = process.platform !== 'win32';
if (STUB_RUNNABLE) {
  fs.writeFileSync(path.join(STUB, 'claude'),
    '#!/bin/sh\nexec "' + process.execPath + '" "$(dirname "$0")/claude-stub.js" "$@"\n');
  fs.chmodSync(path.join(STUB, 'claude'), 0o755);
} else {
  console.log('');
  console.log('  ! ' + process.platform + ': the `claude` stub cannot be executed here.');
  console.log('    Order-placing assertions will SKIP. Pure-logic checks still run.');
  console.log('    Run on Linux/macOS or in the container for full coverage.');
}
const setMode = (m) => fs.writeFileSync(MODEF, m);

// ---- fixture -----------------------------------------------------------------
function seed(opts) {
  const o = opts || {};
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(path.join(AG, 'state'), { recursive: true });
  fs.writeFileSync(path.join(AG, 'agent.json'), JSON.stringify({ name: 'PM', tools: 'portfolio' }));
  fs.writeFileSync(path.join(AG, 'state', 'latest_output.txt'),
    JSON.stringify({ proposals: (o.proposals || [{ symbol: 'AAPL', action: 'buy' }]) }));
  fs.writeFileSync(path.join(AG, 'state', 'decisions.json'),
    JSON.stringify(o.decisions || { 'AAPL|buy': { decision: 'yes', at: new Date().toISOString() } }));
  fs.writeFileSync(path.join(AG, 'state', 'execute_queue.json'),
    JSON.stringify(o.queue || [{ key: 'AAPL|buy', symbol: 'AAPL', action: 'buy',
      requested_at: new Date().toISOString(), status: 'pending', via: 'test' }]));
  fs.writeFileSync(path.join(AG, 'state', 'trade_log.json'), JSON.stringify(o.tradeLog || []));
  fs.rmSync(path.join(T, 'calls.log'), { force: true });
}
const queue = () => JSON.parse(fs.readFileSync(path.join(AG, 'state', 'execute_queue.json'), 'utf8'));
const tlog = () => JSON.parse(fs.readFileSync(path.join(AG, 'state', 'trade_log.json'), 'utf8'));
const calls = () => { try { return fs.readFileSync(path.join(T, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean); } catch (e) { return []; } };

function runExec(env) {
  execFileSync(process.execPath, [EXEC], {
    env: Object.assign({}, process.env, {
      PATH: STUB + path.delimiter + process.env.PATH,
      WORKSPACE: WS,
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
      EXEC_TIMEOUT_MS: '1500',
    }, env || {}),
    encoding: 'utf8', stdio: 'pipe',
  });
}
const st = () => (queue()[0] || {}).status;

console.log('[1] happy path — a clean verdict is trusted');
seed(); setMode('placed'); runExec();
ck('status placed', st() === 'placed', st());
ck('trade logged', tlog().length === 1 && tlog()[0].status === 'placed');
ck('claude called once', calls().length === 1, JSON.stringify(calls()));

console.log('[2] model-reported failed/skipped are trusted verbatim');
seed(); setMode('failed'); runExec();
ck('failed stays failed', st() === 'failed', st());
seed(); setMode('skipped'); runExec();
ck('skipped stays skipped', st() === 'skipped', st());

console.log('[3] THE DOUBLE-ORDER BUG: no verdict must be UNKNOWN, never failed');
seed(); setMode('prose'); runExec();
ck('exit 0 + unparsable -> unknown', st() === 'unknown', st());
ck('note says unverified', /UNVERIFIED/.test((queue()[0] || {}).note || ''), (queue()[0] || {}).note);
seed(); setMode('exit1'); runExec();
ck('non-zero exit -> unknown', st() === 'unknown', st());
seed(); setMode('hang'); runExec();
ck('killed at timeout -> unknown', st() === 'unknown', st());
ck('note names the cap', /cap/.test((queue()[0] || {}).note || ''), (queue()[0] || {}).note);

console.log('[4] an UNKNOWN blocks any retry of the same key (one tap != two orders)');
seed({
  tradeLog: [{ at: new Date().toISOString().slice(0, 16).replace('T', ' '), key: 'AAPL|buy',
               symbol: 'AAPL', action: 'buy', status: 'unknown' }],
});
setMode('placed'); runExec();
ck('re-approval refused', st() === 'skipped', st());
ck('reason is duplicate', /duplicate/.test((queue()[0] || {}).note || ''), (queue()[0] || {}).note);
ck('claude NEVER invoked', calls().length === 0, JSON.stringify(calls()));

console.log('[5] a prior PLACED still blocks (pre-existing guard intact)');
seed({ tradeLog: [{ at: new Date().toISOString().slice(0, 16).replace('T', ' '), key: 'AAPL|buy', status: 'placed' }] });
setMode('placed'); runExec();
ck('blocked', st() === 'skipped' && calls().length === 0, st());

console.log('[6] stale running entry -> unknown, not failed');
seed({ queue: [{ key: 'AAPL|buy', symbol: 'AAPL', action: 'buy',
                 requested_at: new Date(Date.now() - 3600e3).toISOString(),
                 started_at: new Date(Date.now() - 3600e3).toISOString(), status: 'running' }] });
setMode('placed'); runExec();
ck('swept to unknown', st() === 'unknown', st());
ck('no new claude call', calls().length === 0, JSON.stringify(calls()));

console.log('[7] approval expiry');
seed({ decisions: { 'AAPL|buy': { decision: 'yes', at: new Date(Date.now() - 100 * 3600e3).toISOString() } } });
setMode('placed'); runExec({ APPROVAL_TTL_HOURS: '48' });
ck('100h-old Yes refused', st() === 'skipped', st());
ck('reason is expiry', /expired/.test((queue()[0] || {}).note || ''), (queue()[0] || {}).note);
ck('claude not invoked', calls().length === 0);

seed({ decisions: { 'AAPL|buy': { decision: 'yes', at: 'not a date at all' } } });
setMode('placed'); runExec({ APPROVAL_TTL_HOURS: '48' });
ck('unreadable timestamp fails CLOSED', st() === 'skipped', st());

seed({ decisions: { 'AAPL|buy': { decision: 'yes', at: new Date(Date.now() - 2 * 3600e3).toISOString() } } });
setMode('placed'); runExec({ APPROVAL_TTL_HOURS: '48' });
ck('2h-old Yes still executes', st() === 'placed', st());

console.log('[8] aggregate brakes');
const many = ['AAPL', 'MSFT', 'NVDA', 'AMD'].map((s) => ({
  key: s + '|buy', symbol: s, action: 'buy',
  requested_at: new Date().toISOString(), status: 'pending', via: 'test' }));
const manyDec = {}; many.forEach((e) => { manyDec[e.key] = { decision: 'yes', at: new Date().toISOString() }; });
seed({ queue: many, decisions: manyDec, proposals: many.map((e) => ({ symbol: e.symbol, action: 'buy' })) });
setMode('placed'); runExec({ MAX_TRADES_PER_PASS: '2', MAX_TRADES_PER_DAY: '99' });
ck('only 2 orders attempted', calls().length === 2, JSON.stringify(calls()));
ck('remainder left PENDING (not skipped)',
   queue().filter((e) => e.status === 'pending').length === 2,
   JSON.stringify(queue().map((e) => e.status)));

const todayStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
seed({ tradeLog: [{ at: todayStr, key: 'X|buy', status: 'placed' }, { at: todayStr, key: 'Y|buy', status: 'placed' }] });
setMode('placed'); runExec({ MAX_TRADES_PER_DAY: '2' });
ck('daily cap blocks', calls().length === 0 && st() === 'pending', st() + ' calls=' + calls().length);

console.log('[9] kill switch is honoured mid-pass, not just at the start');
seed({ queue: many, decisions: manyDec, proposals: many.map((e) => ({ symbol: e.symbol, action: 'buy' })) });
setMode('pause'); runExec({ MAX_TRADES_PER_PASS: '9', MAX_TRADES_PER_DAY: '9' });
ck('stopped after the order that paused it', calls().length === 1, JSON.stringify(calls()));
ck('rest still pending', queue().filter((e) => e.status === 'pending').length === 3,
   JSON.stringify(queue().map((e) => e.status)));
fs.rmSync(path.join(WS, 'trading.paused'), { force: true });

console.log('[10] pre-existing gates still hold');
seed({ decisions: { 'AAPL|buy': { decision: 'no', at: new Date().toISOString() } } });
setMode('placed'); runExec();
ck('withdrawn approval refused', st() === 'skipped' && calls().length === 0, st());

seed({ proposals: [{ symbol: 'TSLA', action: 'buy' }] });   // AAPL no longer proposed
setMode('placed'); runExec();
ck('stale thesis refused', st() === 'skipped' && calls().length === 0, st());

seed({ queue: [{ key: 'BAD;RM|buy', symbol: 'BAD;RM', action: 'buy',
                 requested_at: new Date().toISOString(), status: 'pending' }] });
setMode('placed'); runExec();
ck('invalid ticker refused', st() === 'failed' && calls().length === 0, st());

console.log('[11] cap tripwire still trips and halts trading');
seed(); setMode('over'); runExec({ MAX_TRADE_USD: '100' });
ck('over-cap report pauses trading', fs.existsSync(path.join(WS, 'trading.paused')));
fs.rmSync(path.join(WS, 'trading.paused'), { force: true });

// From here on nothing spawns a process — these exercise exported pure functions,
// so they must run everywhere, including on Windows.
needStub = false;

console.log('[12] parseWhen handles every format the platform writes');
const et = require(EXEC);
const pw = et.parseWhen;
ck('ISO with Z', isFinite(pw('2026-08-02T19:30:00.000Z')));
ck('"YYYY-MM-DD HH:MM"', isFinite(pw('2026-08-02 19:30')));
ck('legacy "Jul 27 10:01"', isFinite(pw('Jul 27 10:01')));
ck('garbage -> NaN', !isFinite(pw('not a date')));
ck('empty -> NaN', !isFinite(pw('')));

console.log('[13] notify-proposals: a legacy timestamp no longer gags forever');
const np = require(path.join(SRC, 'notify-proposals.js'));
const old = new Date(Date.now() - 30 * 86400e3);
const mon = old.toUTCString().slice(8, 11);
const legacyOld = `${mon} ${old.getUTCDate()} 10:01`;
ck('30-day-old legacy decision no longer suppresses', np.withinTTL(legacyOld) === false, legacyOld);
ck('fresh ISO decision still suppresses', np.withinTTL(new Date().toISOString()) === true);
ck('unparseable no longer means "recent"', np.withinTTL('Jul 99 99:99') === false);

fs.rmSync(T, { recursive: true, force: true });
console.log();
if (skips) {
  // Never let a skipped run read as a clean one. The whole point of this suite is
  // that somebody believes it before approving a trade.
  console.log(`${skips} CHECK(S) SKIPPED — order placement was NOT verified on this platform.`);
  console.log('Run on Linux/macOS or in the node-1 container before trusting a change to the money path.');
}
console.log(fails ? `${fails} FAILURE(S)`
                  : (skips ? 'No failures, but coverage was INCOMPLETE (see above).'
                           : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
