#!/usr/bin/env node
// Two-way Telegram control for the agent platform. (v2)
// Single-pass poller: called once per scheduler iteration by startup.sh.
// Reads incoming messages (getUpdates), acts on commands from the OWNER chat only,
// and replies. No daemon, no extra deps — uses Node's built-in fetch (node >= 18).
//
// v2 additions:
//  - Commands registered with Telegram (autocomplete menu)
//  - /agents is interactive: tap an agent -> card with Run/Pause/Mute/Output/Delete buttons
//  - Agent management: /schedule /prompt /new /delete /mute /unmute
//  - Natural language: any non-command text is answered by claude (via chat.sh) with
//    live agent status as context; actions are suggested as commands, never executed by the model
//  - Quiet-hours queue flush (messages queued by run-agent.sh during QUIET_HOURS)
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT  = String(process.env.TELEGRAM_CHAT_ID || '');
const WS    = process.env.WORKSPACE || '/workspace';
const AGENTS = WS + '/agents';
const OFFSET_FILE = WS + '/.tg_offset';
const CMDS_STAMP  = WS + '/.tg_cmds_version';
const CMDS_VERSION = '3';   // bump to re-register the menu (v3 added /halt, /qd)
const MSGQ = WS + '/.msgqueue';
const API = `https://api.telegram.org/bot${TOKEN}`;

// ---- Telegram I/O (overridable for tests) ----
async function realTg(method, params) {
  try {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(10000),   // a hung connection must not stall the scheduler pass
    });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}
let SEND = async (text, kb) => {
  const p = { chat_id: CHAT, text: String(text).slice(0, 4000) };
  if (kb) p.reply_markup = { inline_keyboard: kb };
  await realTg('sendMessage', p);
};
function setSend(fn) { SEND = fn; }            // test hook
function setSpawn(fn) { SPAWN = fn; }          // test hook
let SPAWN = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
async function editMsg(cq, text, kb) {
  if (!cq || !cq.message) return;
  const p = { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: String(text).slice(0, 4000) };
  if (kb) p.reply_markup = { inline_keyboard: kb };
  await realTg('editMessageText', p);
}
// Swap only the buttons under a message, leaving its text untouched (used on the
// daily brief — its text must never be re-sent or truncated by an edit).
async function editKb(cq, kb) {
  if (!cq || !cq.message) return;
  await realTg('editMessageReplyMarkup', {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    reply_markup: { inline_keyboard: kb },
  });
}

// ---- helpers ----
function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function writeJSON(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); }
// Atomic variant for files the dashboard and executor also read/write
// (decisions.json, execute_queue.json) — a torn write there loses an approval.
function writeFileAtomic(p, data) { const t = p + '.tmp'; fs.writeFileSync(t, data); fs.renameSync(t, p); }
const TICKER_RE = /^[A-Z][A-Z.\-]{0,9}$/;
const TRADE_ACTIONS = new Set(['buy', 'add', 'sell', 'trim']);
function listAgents() {
  try { return fs.readdirSync(AGENTS).filter(n => fs.existsSync(`${AGENTS}/${n}/agent.json`)).sort(); }
  catch (e) { return []; }
}
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function findAgent(q) {
  q = (q || '').trim(); const want = slug(q); const names = listAgents();
  for (const n of names) if (n.toLowerCase() === q.toLowerCase() || slug(n) === want) return n;
  for (const n of names) { const m = readJSON(`${AGENTS}/${n}/agent.json`, {}); if (slug(m.name) === want) return n; }
  for (const n of names) { const m = readJSON(`${AGENTS}/${n}/agent.json`, {}); if (n.toLowerCase().includes(q.toLowerCase()) || slug(m.name).includes(want)) return n; }
  return null;
}
function statusDot(n) {
  const m = readJSON(`${AGENTS}/${n}/agent.json`, {});
  const last = readJSON(`${AGENTS}/${n}/state/last_run.json`, null);
  return m.enabled === false ? '⏸' : (last ? (last.ok ? '🟢' : '🔴') : '⚪');
}
function agentLine(n) {
  const m = readJSON(`${AGENTS}/${n}/agent.json`, {});
  const paused = m.enabled === false;
  return `${statusDot(n)} ${n} — ${m.name || ''}${paused ? ' (paused)' : ''}${m.muted ? ' 🔕' : ''}`;
}
function nameHint() { const n = listAgents(); return n.length ? 'Agents: ' + n.join(', ') : 'No agents yet.'; }
const SCHED_RE = /^(daily \d{1,2}:\d{2}(,\d{1,2}:\d{2})*|weekly [A-Za-z]{3}(,[A-Za-z]{3})* \d{1,2}:\d{2}|interval \d+)$/;

// ---- interactive agent list / card ----
function agentsKeyboard() {
  const rows = listAgents().map(n => {
    const m = readJSON(`${AGENTS}/${n}/agent.json`, {});
    return [{ text: `${statusDot(n)} ${m.name || n}`, callback_data: `ag:${n}:menu` }];
  });
  return rows.length ? rows : null;
}
function agentCard(n) {
  const m = readJSON(`${AGENTS}/${n}/agent.json`, {});
  const last = readJSON(`${AGENTS}/${n}/state/last_run.json`, null);
  return [
    `${statusDot(n)} ${m.name || n}  (${n})`,
    m.description ? m.description : null,
    `schedule: ${m.schedule || '?'}   tools: ${m.tools || 'read'}   delivery: ${m.delivery || '?'}`,
    `enabled: ${m.enabled !== false}   muted: ${!!m.muted}`,
    last ? `last run: ${last.ok ? '✓' : '✗'} ${last.started_at || ''} — ${last.summary || ''}` : 'last run: never',
  ].filter(Boolean).join('\n');
}
function agentMenuKeyboard(n) {
  const m = readJSON(`${AGENTS}/${n}/agent.json`, {});
  const paused = m.enabled === false;
  return [
    [{ text: '▶ Run now', callback_data: `ag:${n}:run` },
     paused ? { text: '▶ Resume', callback_data: `ag:${n}:resume` }
            : { text: '⏸ Pause', callback_data: `ag:${n}:pause` }],
    [m.muted ? { text: '🔔 Unmute', callback_data: `ag:${n}:unmute` }
             : { text: '🔕 Mute', callback_data: `ag:${n}:mute` },
     { text: '📄 Last output', callback_data: `ag:${n}:out` }],
    [{ text: '🗑 Delete…', callback_data: `ag:${n}:delask` },
     { text: '⬅ All agents', callback_data: `ag:_:list` }],
  ];
}
// ---- daily-brief tuning (⚙ Tune brief button on compose-brief.sh's message) ----
// Prefs file: { "<agent-slug>": 0|1|2 } — 0 hidden, 1 normal, 2 detailed.
// compose-brief.sh reads it next morning; missing key = 1.
const BRIEF_PREFS = WS + '/.brief_prefs.json';
const BRIEF_LEVELS = ['hidden', 'normal', 'detailed'];
function briefAgents() {
  return listAgents().filter(n => readJSON(`${AGENTS}/${n}/agent.json`, {}).brief === true);
}
function briefLevel(prefs, n) {
  const v = prefs[n];
  return (v === 0 || v === 1 || v === 2) ? v : 1;
}
function briefTuneKeyboard() {
  const prefs = readJSON(BRIEF_PREFS, {}) || {};
  const rows = briefAgents().map(n => {
    const m = readJSON(`${AGENTS}/${n}/agent.json`, {});
    const lvl = briefLevel(prefs, n);
    return [
      { text: `${m.name || n}: ${BRIEF_LEVELS[lvl]}`, callback_data: `br:_:noop` },
      { text: '−', callback_data: `br:${n}:less` },
      { text: '+', callback_data: `br:${n}:more` },
    ];
  });
  rows.push([{ text: '✓ Done', callback_data: 'br:_:done' }]);
  return rows;
}
async function handleBriefCallback(cq, data) {
  const parts = data.split(':');                 // br:<slug>:<action>
  const n = parts[1]; const action = parts[2] || '';
  const ack = (text) => realTg('answerCallbackQuery', text ? { callback_query_id: cq.id, text } : { callback_query_id: cq.id });

  if (action === 'menu') { await ack(); return editKb(cq, briefTuneKeyboard()); }
  if (action === 'done') { await ack(); return editKb(cq, [[{ text: '⚙ Tune brief', callback_data: 'br:_:menu' }]]); }
  if (action === 'noop') return ack();
  if (action !== 'less' && action !== 'more') return ack();
  if (!briefAgents().includes(n)) { await ack('Not in the brief anymore'); return editKb(cq, briefTuneKeyboard()); }
  const prefs = readJSON(BRIEF_PREFS, {}) || {};
  const cur = briefLevel(prefs, n);
  const next = Math.max(0, Math.min(2, cur + (action === 'more' ? 1 : -1)));
  if (next === cur) return ack(cur === 0 ? 'Already hidden' : 'Already at max detail');
  prefs[n] = next;
  try { writeFileAtomic(BRIEF_PREFS, JSON.stringify(prefs, null, 2) + '\n'); }
  catch (e) { return ack('Couldn\'t save'); }
  const m = readJSON(`${AGENTS}/${n}/agent.json`, {});
  await ack(`${m.name || n}: ${BRIEF_LEVELS[next]} from tomorrow`);
  return editKb(cq, briefTuneKeyboard());
}

// ---- QuantDesk control ----
// node-1 has no docker socket and no mount into /volume1/docker/quantdesk, so this
// process cannot stop trading by itself. health-collector has both, and is the only
// thing on the box that does: we drop <id>.req into the shared workspace, it runs an
// allowlisted verb against qd-engine and writes <id>.out. See health/collector.sh.
//
// Until this existed, quantdesk/README.md listed "Telegram /halt" as one of three
// equivalent emergency stops and no such command was ever registered.
const QD_DIR = WS + '/health/qd-console';
const QD_WAIT_MS = 12000;   // collector polls ~1s; `qd halt` round-trips in ~2s
const QD_ACTIONS = new Set(['halt', 'resume', 'flatten', 'status', 'kill', 'unkill']);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function qdRequest(action) {
  if (!QD_ACTIONS.has(action)) return { ok: false, text: 'unknown action' };
  const id = `${Date.now()}-${process.pid}`;
  const req = `${QD_DIR}/${id}.req`, out = `${QD_DIR}/${id}.out`;
  try { fs.mkdirSync(QD_DIR, { recursive: true }); fs.writeFileSync(req, action); }
  catch (e) { return { ok: false, text: `control channel unreachable: ${e.message}` }; }

  const deadline = Date.now() + QD_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(400);
    let raw;
    try { raw = fs.readFileSync(out, 'utf8'); } catch (e) { continue; }  // not answered yet
    try { fs.unlinkSync(out); } catch (e) {}
    const m = raw.match(/^--exit:(-?\d+)\s*$/m);
    return { ok: m ? m[1] === '0' : false, code: m ? parseInt(m[1], 10) : -1,
             text: raw.replace(/^--exit:-?\d+\s*$/m, '').trim() };
  }
  try { fs.unlinkSync(req); } catch (e) {}
  return { ok: false, timeout: true, text: '' };
}

// Wording is deliberately precise about queued-vs-done, because the difference is
// real: `qd halt` inserts a control_commands row the engine applies on its next
// cycle, while the kill switch is a file the risk gate checks before every order.
// Saying "halted" when the engine has not yet read the row would be a lie at the
// exact moment it matters most.
const QD_DONE = {
  halt: '🛑 HALT queued.\nThe engine stops opening new positions on its next cycle (~20 s). '
      + 'Exits still work.\nTo block everything including exits: /qd kill',
  resume: '▶ Resume queued — the engine picks it up on its next cycle (~20 s).',
  flatten: '💥 Flatten queued.\nThe engine submits reduce-only market closes next cycle and reports '
         + 'FLATTEN_COMPLETE once the book is actually flat.',
  kill: '🔴 KILL SWITCH ENGAGED — in effect now.\nEvery order is blocked, exits included. '
      + 'Release with /qd unkill.',
  unkill: '🟢 Kill switch released. Normal risk gates apply again.',
};

function qdReply(action, r) {
  if (r.timeout) {
    return `⚠️ NO CONFIRMATION for "${action}".\nThe request was written but health-collector did not `
         + `answer in ${QD_WAIT_MS / 1000}s. Assume it did NOT take effect.\n\n`
         + 'Do it by hand now:\n'
         + `ssh nas 'docker exec qd-engine qd ${action}'\n`
         + 'Or the switch that needs nothing working: '
         + "ssh nas 'docker exec qd-engine touch /app/state/KILL'";
  }
  if (!r.ok) {
    return `⚠️ "${action}" FAILED (exit ${r.code}).\n${(r.text || '(no output)').slice(0, 1200)}\n\n`
         + "Fallback: ssh nas 'docker exec qd-engine touch /app/state/KILL'";
  }
  if (action === 'status') return '📊 QuantDesk\n\n' + (r.text || '(no output)').slice(0, 3500);
  return QD_DONE[action] || `✓ ${action} done.`;
}

function qdKeyboard() {
  return [
    [{ text: '🛑 Halt', callback_data: 'qd:halt' }, { text: '💥 Flatten', callback_data: 'qd:flatten' }],
    [{ text: '🔴 Kill switch', callback_data: 'qd:kill' }, { text: '▶ Resume…', callback_data: 'qd:resumeask' }],
    [{ text: '🔄 Refresh status', callback_data: 'qd:status' }],
  ];
}

function setFlag(n, key, val) {
  const p = `${AGENTS}/${n}/agent.json`; const m = readJSON(p, null);
  if (!m) return false;
  m[key] = val;
  try { writeJSON(p, m); return true; } catch (e) { return false; }
}

const HELP = [
  'Agent control:',
  '/agents — interactive agent list (tap for actions)',
  '/run /pause /resume /mute /unmute <name>',
  '/schedule <name> <daily HH:MM | weekly Mon,Wed HH:MM | interval N>',
  '/prompt <name> — show an agent\'s prompt',
  '/new <slug> | <schedule> | <what it should do>',
  '/delete <name> — delete an agent (asks to confirm)',
  '',
  'QuantDesk:',
  '/halt — 🛑 stop opening new positions (exits still work)',
  '/qd — status + control buttons',
  '/qd flatten — close everything at market',
  '/qd kill — block ALL orders, exits included',
  '/qd resume | /qd unkill — undo the above (asks to confirm)',
  '',
  '/health — reliability digest   /backup — config snapshot',
  '/ask <question> — one-off web question',
  '',
  'Or just type anything — I\'ll answer with your agents\' status in mind.',
].join('\n');

// ---- command handler ----
async function handle(text) {
  const t = String(text || '').trim();
  if (!t) return;

  // Natural language: anything that isn't a /command goes to claude with agent context.
  if (!t.startsWith('/')) {
    SPAWN('bash', [`${WS}/chat.sh`, t]);
    return SEND('🤔 Thinking…');
  }

  const sp = t.indexOf(' ');
  let cmd = (sp === -1 ? t : t.slice(0, sp)).toLowerCase().replace(/@[^ ]+$/, '');
  const arg = sp === -1 ? '' : t.slice(sp + 1).trim();

  if (cmd === '/start' || cmd === '/help') return SEND(HELP);

  if (cmd === '/agents' || cmd === '/status' || cmd === '/list') {
    const kb = agentsKeyboard();
    return kb ? SEND('Your agents — tap one to manage it:', kb) : SEND('No agents yet.');
  }
  if (cmd === '/run') {
    if (!arg) return SEND('Usage: /run <name>\n' + nameHint());
    const n = findAgent(arg); if (!n) return SEND(`No agent matches "${arg}".\n` + nameHint());
    try { fs.mkdirSync(`${AGENTS}/${n}/state`, { recursive: true }); fs.writeFileSync(`${AGENTS}/${n}/state/run.trigger`, '1'); }
    catch (e) { return SEND(`Couldn't trigger ${n}: ${e}`); }
    return SEND(`▶ Triggered ${n}. Results will arrive shortly.`);
  }
  if (cmd === '/pause' || cmd === '/resume') {
    if (!arg) return SEND(`Usage: ${cmd} <name>\n` + nameHint());
    const n = findAgent(arg); if (!n) return SEND(`No agent matches "${arg}".\n` + nameHint());
    if (!setFlag(n, 'enabled', cmd === '/resume')) return SEND(`Couldn't update ${n}.`);
    return SEND(`${cmd === '/resume' ? '▶ Resumed' : '⏸ Paused'} ${n}.`);
  }
  if (cmd === '/mute' || cmd === '/unmute') {
    if (!arg) return SEND(`Usage: ${cmd} <name>\n` + nameHint());
    const n = findAgent(arg); if (!n) return SEND(`No agent matches "${arg}".\n` + nameHint());
    if (!setFlag(n, 'muted', cmd === '/mute')) return SEND(`Couldn't update ${n}.`);
    return SEND(cmd === '/mute'
      ? `🔕 Muted ${n} — it still runs, but normal output won't be sent here. Failure alerts still come through.`
      : `🔔 Unmuted ${n}.`);
  }
  if (cmd === '/schedule') {
    const m2 = arg.match(/^(\S+)\s+(.+)$/);
    if (!m2) return SEND('Usage: /schedule <name> <daily HH:MM | weekly Mon,Wed HH:MM | interval N>\nExamples:\n/schedule news-digest daily 19:00\n/schedule market-close weekly Mon,Tue,Wed,Thu,Fri 15:30\n/schedule portfolio-monitor interval 30');
    const n = findAgent(m2[1]); if (!n) return SEND(`No agent matches "${m2[1]}".\n` + nameHint());
    const sched = m2[2].trim();
    if (!SCHED_RE.test(sched)) return SEND(`"${sched}" isn't a valid schedule.\nFormats: daily HH:MM[,HH:MM…] | weekly Mon,Wed,Fri HH:MM | interval N (minutes)`);
    if (!setFlag(n, 'schedule', sched)) return SEND(`Couldn't update ${n}.`);
    return SEND(`⏰ ${n} now runs: ${sched}`);
  }
  if (cmd === '/prompt') {
    if (!arg) return SEND('Usage: /prompt <name>\n' + nameHint());
    const n = findAgent(arg); if (!n) return SEND(`No agent matches "${arg}".\n` + nameHint());
    let p = '';
    try { p = fs.readFileSync(`${AGENTS}/${n}/prompt.md`, 'utf8'); } catch (e) { return SEND(`${n} has no prompt.md.`); }
    return SEND(`Prompt for ${n}:\n\n${p.slice(0, 3600)}${p.length > 3600 ? '\n…(truncated)' : ''}`);
  }
  if (cmd === '/new') {
    const parts = arg.split('|').map(s => s.trim());
    if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2])
      return SEND('Usage: /new <slug> | <schedule> | <what it should do>\nExample:\n/new water-reminder | daily 10:00,15:00 | Remind me to drink water with a different short fun fact about hydration each time.');
    const s = slug(parts[0]);
    if (!s) return SEND('That slug is empty after cleanup — use letters/numbers/dashes.');
    if (listAgents().includes(s)) return SEND(`Agent "${s}" already exists.`);
    const sched = parts[1];
    if (!SCHED_RE.test(sched)) return SEND(`"${sched}" isn't a valid schedule.\nFormats: daily HH:MM[,HH:MM…] | weekly Mon,Wed,Fri HH:MM | interval N (minutes)`);
    const desc = parts.slice(2).join(' | ');
    const title = s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    try {
      fs.mkdirSync(`${AGENTS}/${s}/state`, { recursive: true });
      fs.mkdirSync(`${AGENTS}/${s}/logs`, { recursive: true });
      writeJSON(`${AGENTS}/${s}/agent.json`, {
        name: title, description: desc, schedule: sched,
        enabled: false, delivery: 'telegram', tools: 'read',
      });
      fs.writeFileSync(`${AGENTS}/${s}/prompt.md`,
        `${desc}\n\nRules:\n- Reply in plain text only (no markdown), under 3500 characters.\n- If there is genuinely nothing to report this run, reply with exactly SKIP.\n`);
    } catch (e) { return SEND(`Couldn't create ${s}: ${e}`); }
    return SEND(`✨ Created ${s} (paused, read-only tools).\n• Check the prompt: /prompt ${s}\n• Test it: /run ${s}\n• Turn it on: /resume ${s}`);
  }
  if (cmd === '/delete') {
    if (!arg) return SEND('Usage: /delete <name>\n' + nameHint());
    const n = findAgent(arg); if (!n) return SEND(`No agent matches "${arg}".\n` + nameHint());
    return SEND(`Delete ${n} permanently? This removes its config, prompt, and history.`,
      [[{ text: '🗑 Yes, delete', callback_data: `ag:${n}:delyes` }, { text: 'Cancel', callback_data: `ag:${n}:delno` }]]);
  }
  // ---- QuantDesk ----
  // `/halt` is top-level and unprefixed on purpose: it is the one command typed
  // in a hurry, and quantdesk's README has always promised it by that name.
  // Note `/resume` is NOT overloaded here — it still resumes an agent, as it
  // always has. Resuming the trading engine is `/qd resume`, behind a confirm.
  if (cmd === '/halt') {
    await SEND('🛑 Halting QuantDesk…');
    return SEND(qdReply('halt', await qdRequest('halt')));
  }
  if (cmd === '/qd') {
    const sub = arg.toLowerCase().trim();
    if (!sub) {
      const r = await qdRequest('status');
      return SEND(qdReply('status', r), qdKeyboard());
    }
    // Stopping is never gated (quantdesk ARCHITECTURE.md §9) — halt, flatten and
    // kill go straight through. Resume and unkill add risk back, so they confirm.
    if (sub === 'halt' || sub === 'flatten' || sub === 'kill' || sub === 'status') {
      if (sub !== 'status') await SEND(`Sending ${sub}…`);
      return SEND(qdReply(sub, await qdRequest(sub)), sub === 'status' ? qdKeyboard() : null);
    }
    if (sub === 'resume' || sub === 'unkill') {
      return SEND(sub === 'resume'
        ? 'Resume trading? The engine will start opening positions again.'
        : 'Release the kill switch? Orders will be allowed again.',
        [[{ text: `✓ Yes, ${sub}`, callback_data: `qd:${sub}:yes` },
          { text: 'Cancel', callback_data: 'qd:_:no' }]]);
    }
    return SEND('Usage: /qd [halt | resume | flatten | kill | unkill]\nNo argument shows status with buttons.');
  }
  if (cmd === '/health') {
    SPAWN('bash', [`${WS}/digest.sh`]);
    return SEND('📊 Health digest sent.');
  }
  if (cmd === '/backup') {
    SPAWN('bash', [`${WS}/backup.sh`]);
    return SEND('💾 Backup started — saving a config snapshot to /workspace/backups.');
  }
  if (cmd === '/ask') {
    if (!arg) return SEND('Usage: /ask <question>');
    SPAWN('bash', [`${WS}/ask.sh`, arg]);
    return SEND('🤔 Thinking… (answer will follow)');
  }
  return SEND('Unknown command. Send /help for options — or just type your question in plain words.');
}

// ---- inline-button callback handlers ----
async function handleAgentCallback(cq, data) {
  const parts = data.split(':');                 // ag:<slug>:<action>
  const n = parts[1]; const action = parts[2] || '';
  const ack = (text) => realTg('answerCallbackQuery', text ? { callback_query_id: cq.id, text } : { callback_query_id: cq.id });

  if (action === 'list' || n === '_') {
    await ack();
    const kb = agentsKeyboard();
    return kb ? editMsg(cq, 'Your agents — tap one to manage it:', kb) : editMsg(cq, 'No agents yet.');
  }
  if (!listAgents().includes(n)) { await ack('Agent not found'); return; }

  if (action === 'menu') { await ack(); return editMsg(cq, agentCard(n), agentMenuKeyboard(n)); }
  if (action === 'run') {
    try { fs.mkdirSync(`${AGENTS}/${n}/state`, { recursive: true }); fs.writeFileSync(`${AGENTS}/${n}/state/run.trigger`, '1'); await ack('Triggered ▶'); }
    catch (e) { await ack('Failed to trigger'); }
    return editMsg(cq, agentCard(n) + '\n\n▶ Triggered — results will arrive shortly.', agentMenuKeyboard(n));
  }
  if (action === 'pause' || action === 'resume') {
    setFlag(n, 'enabled', action === 'resume'); await ack(action === 'resume' ? 'Resumed ▶' : 'Paused ⏸');
    return editMsg(cq, agentCard(n), agentMenuKeyboard(n));
  }
  if (action === 'mute' || action === 'unmute') {
    setFlag(n, 'muted', action === 'mute'); await ack(action === 'mute' ? 'Muted 🔕' : 'Unmuted 🔔');
    return editMsg(cq, agentCard(n), agentMenuKeyboard(n));
  }
  if (action === 'out') {
    await ack();
    let out = '';
    try { out = fs.readFileSync(`${AGENTS}/${n}/state/latest_output.txt`, 'utf8'); } catch (e) {}
    return SEND(out ? `📄 Last output of ${n}:\n\n${out.slice(-3500)}` : `${n} has no output yet.`);
  }
  if (action === 'delask') {
    await ack();
    return editMsg(cq, `Delete ${n} permanently? This removes its config, prompt, and history.`,
      [[{ text: '🗑 Yes, delete', callback_data: `ag:${n}:delyes` }, { text: 'Cancel', callback_data: `ag:${n}:delno` }]]);
  }
  if (action === 'delyes') {
    try { fs.rmSync(`${AGENTS}/${n}`, { recursive: true, force: true }); await ack('Deleted'); }
    catch (e) { await ack('Delete failed'); return editMsg(cq, `Couldn't delete ${n}: ${e}`); }
    return editMsg(cq, `🗑 Deleted ${n}.`);
  }
  if (action === 'delno') { await ack('Kept'); return editMsg(cq, agentCard(n), agentMenuKeyboard(n)); }
  await ack();
}

async function handleQdCallback(cq, data) {
  const parts = data.split(':');                 // qd:<action>[:yes]
  const action = parts[1] || '';
  const ack = (text) => realTg('answerCallbackQuery',
    text ? { callback_query_id: cq.id, text } : { callback_query_id: cq.id });

  if (action === '_' ) { await ack('Cancelled'); return editMsg(cq, 'Cancelled — nothing changed.'); }
  if (action === 'resumeask') {
    await ack();
    return SEND('Resume trading? The engine will start opening positions again.',
      [[{ text: '✓ Yes, resume', callback_data: 'qd:resume:yes' },
        { text: 'Cancel', callback_data: 'qd:_:no' }]]);
  }
  // resume/unkill only ever arrive here with the :yes suffix from the confirm
  // keyboard; a bare qd:resume would skip the gate, so require it explicitly.
  if ((action === 'resume' || action === 'unkill') && parts[2] !== 'yes') return ack();
  if (!QD_ACTIONS.has(action)) return ack();

  // Answer the tap before the work: Telegram greys the button out after ~10s and
  // qdRequest can legitimately take 12.
  await ack(action === 'status' ? 'Refreshing…' : `Sending ${action}…`);
  const r = await qdRequest(action);
  if (action === 'status') return editMsg(cq, qdReply('status', r), qdKeyboard());
  return SEND(qdReply(action, r));
}

async function handleCallback(cq) {
  if (!cq) return;
  // Must be the OWNER who tapped, not merely a button living in the owner's chat.
  // This was an OR until 2026-08-02: the second clause only proved "this message is
  // in TELEGRAM_CHAT_ID", so if that id were ever a group, every member of the group
  // could approve a trade, pause agents, or delete an agent. TELEGRAM_CHAT_ID is
  // currently a private chat, where chat.id == from.id, so this is a no-op today and
  // a real gate if the chat ever changes.
  const owner = String(cq.from && cq.from.id) === CHAT;
  const data = String(cq.data || '');
  if (!owner) { await realTg('answerCallbackQuery', { callback_query_id: cq.id }); return; }
  if (data.startsWith('ag:')) return handleAgentCallback(cq, data);
  if (data.startsWith('br:')) return handleBriefCallback(cq, data);
  if (data.startsWith('qd:')) return handleQdCallback(cq, data);
  if (!data.startsWith('pf:')) { await realTg('answerCallbackQuery', { callback_query_id: cq.id }); return; }
  const parts = data.split(':');                 // pf:<agent>:<symbol|action>:<yes|no>
  const agent = parts[1]; const dec = parts[parts.length - 1]; const key = parts.slice(2, -1).join(':');
  if (!agent || !key || (dec !== 'yes' && dec !== 'no')) { await realTg('answerCallbackQuery', { callback_query_id: cq.id }); return; }
  const decFile = `${AGENTS}/${agent}/state/decisions.json`;
  const decs = readJSON(decFile, {}) || {};
  decs[key] = { decision: dec, at: new Date().toISOString().slice(0, 16).replace('T', ' '), via: 'telegram' };
  try { fs.mkdirSync(`${AGENTS}/${agent}/state`, { recursive: true }); writeFileAtomic(decFile, JSON.stringify(decs, null, 2)); } catch (e) {}
  const sym = (key.split('|')[0] || '').toUpperCase().trim();
  const act = (key.split('|')[1] || '').toLowerCase().trim();
  const qFile = `${AGENTS}/${agent}/state/execute_queue.json`;
  // One-tap execute: queue the approved order for execute-trades.js (next scheduler pass).
  // Only a clean ticker + known action is ever queued (the executor re-checks too).
  if (dec === 'yes') {
    if (!TICKER_RE.test(sym) || !TRADE_ACTIONS.has(act)) {
      await realTg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Invalid symbol/action — not queued' });
      if (cq.message) await realTg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        text: `${(cq.message.text || 'Proposal').split('\n')[0]}\n🔴 Not queued — "${key.slice(0, 40)}" is not a valid symbol|action.` });
      return;
    }
    let q = readJSON(qFile, []); if (!Array.isArray(q)) q = [];
    if (!q.some(e => e.key === key && (e.status === 'pending' || e.status === 'running'))) {
      q.push({ key, symbol: sym, action: act, requested_at: new Date().toISOString().slice(0, 19),
               status: 'pending', via: 'telegram' });
      try { writeFileAtomic(qFile, JSON.stringify(q.slice(-50), null, 1)); } catch (e) {}
    }
  } else {
    // No = withdraw: mark any still-pending queued order for this key as skipped so
    // the executor never picks it up (it also re-checks decisions.json itself).
    let q = readJSON(qFile, []);
    if (Array.isArray(q)) {
      let ch = false;
      for (const e of q) if (e.key === key && e.status === 'pending') { e.status = 'skipped'; e.note = 'approval withdrawn'; ch = true; }
      if (ch) { try { writeFileAtomic(qFile, JSON.stringify(q, null, 1)); } catch (e) {} }
    }
  }
  await realTg('answerCallbackQuery', { callback_query_id: cq.id, text: dec === 'yes' ? 'Placing order…' : 'Recorded: No' });
  const base = (cq.message && cq.message.text) ? cq.message.text.split('\n')[0] : 'Proposal';
  const newText = dec === 'yes'
    ? `${base}\n⚡ Approved — placing the order automatically (market, ≤ $${process.env.MAX_TRADE_USD || 100}). Result will follow.`
    : `${base}\n❌ Dismissed.`;
  if (cq.message) await realTg('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: newText });
}

// ---- command menu registration (once per CMDS_VERSION) ----
async function ensureCommands() {
  let cur = '';
  try { cur = fs.readFileSync(CMDS_STAMP, 'utf8').trim(); } catch (e) {}
  if (cur === CMDS_VERSION) return;
  const r = await realTg('setMyCommands', { commands: [
    { command: 'agents',   description: 'Agent list with buttons' },
    { command: 'run',      description: 'Run an agent now' },
    { command: 'pause',    description: 'Pause an agent' },
    { command: 'resume',   description: 'Resume an agent' },
    { command: 'mute',     description: 'Mute an agent\'s messages' },
    { command: 'unmute',   description: 'Unmute an agent' },
    { command: 'schedule', description: 'Change an agent\'s schedule' },
    { command: 'prompt',   description: 'Show an agent\'s prompt' },
    { command: 'new',      description: 'Create an agent: slug | schedule | task' },
    { command: 'delete',   description: 'Delete an agent' },
    { command: 'halt',     description: '🛑 STOP QuantDesk trading now' },
    { command: 'qd',       description: 'QuantDesk status + controls' },
    { command: 'health',   description: 'Reliability digest' },
    { command: 'backup',   description: 'Snapshot agent configs' },
    { command: 'ask',      description: 'One-off web question' },
    { command: 'help',     description: 'Show all commands' },
  ]});
  if (r && r.ok) { try { fs.writeFileSync(CMDS_STAMP, CMDS_VERSION); } catch (e) {} }
}

// ---- quiet-hours queue flush ----
function inQuietHours(now) {
  const qh = process.env.QUIET_HOURS || '';
  const m = qh.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const d = now || new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  const s = (+m[1]) * 60 + (+m[2]); const e = (+m[3]) * 60 + (+m[4]);
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}
async function flushQueue() {
  if (inQuietHours()) return;
  let files;
  try { files = fs.readdirSync(MSGQ).sort(); } catch (e) { return; }
  for (const f of files.slice(0, 20)) {
    const p = `${MSGQ}/${f}`;
    try {
      const txt = fs.readFileSync(p, 'utf8');
      if (txt.trim()) await SEND(txt);
      fs.unlinkSync(p);
    } catch (e) {}
  }
}

// ---- single polling pass ----
async function runOnce() {
  if (!TOKEN || !CHAT) return;
  await ensureCommands();
  await flushQueue();
  let init = false, offset = 0;
  if (fs.existsSync(OFFSET_FILE)) offset = parseInt(fs.readFileSync(OFFSET_FILE, 'utf8'), 10) || 0;
  else init = true;

  if (init) {
    // First run: skip any backlog so old messages aren't replayed. Ack up to the latest.
    const r = await realTg('getUpdates', { offset: -1, timeout: 0 });
    let off = 0;
    if (r && r.ok && Array.isArray(r.result) && r.result.length) off = r.result[r.result.length - 1].update_id + 1;
    try { fs.writeFileSync(OFFSET_FILE, String(off)); } catch (e) {}
    return;
  }

  const res = await realTg('getUpdates', { offset, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  if (!res || !res.ok || !Array.isArray(res.result) || !res.result.length) return;
  let maxId = offset - 1;
  for (const u of res.result) {
    if (u.update_id > maxId) maxId = u.update_id;
    if (u.callback_query) { try { await handleCallback(u.callback_query); } catch (e) {} continue; }
    const msg = u.message;
    if (!msg || !msg.text) continue;
    if (String(msg.chat && msg.chat.id) !== CHAT) continue; // OWNER ONLY
    try { await handle(msg.text); } catch (e) { /* ignore one bad command */ }
  }
  try { fs.writeFileSync(OFFSET_FILE, String(maxId + 1)); } catch (e) {}
}

module.exports = { handle, handleCallback, findAgent, listAgents, agentLine, slug, setSend, setSpawn, runOnce, inQuietHours, briefTuneKeyboard };

if (require.main === module) {
  runOnce().then(() => process.exit(0)).catch(() => process.exit(0));
}
