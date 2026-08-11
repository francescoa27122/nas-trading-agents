#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
AGENT_DIR="${1%/}"
[ -f "$AGENT_DIR/agent.json" ] || exit 1
mkdir -p "$AGENT_DIR/state" "$AGENT_DIR/logs"
START=$(date -Iseconds)
LOG="$AGENT_DIR/logs/$(date +%Y%m%d-%H%M%S).log"

TOOLS=$(grep -o '"tools"[[:space:]]*:[[:space:]]*"[^"]*"' "$AGENT_DIR/agent.json" | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')
case "$TOOLS" in
  actions) ALLOWED="WebSearch WebFetch Bash(curl:*)";;
  power)   ALLOWED="WebSearch WebFetch Bash Read Write Edit";;
  google)  ALLOWED="WebSearch WebFetch mcp__google";;
  portfolio) ALLOWED="WebSearch WebFetch mcp__robinhood__get_accounts mcp__robinhood__get_portfolio mcp__robinhood__get_equity_positions mcp__robinhood__get_option_positions mcp__robinhood__get_equity_orders mcp__robinhood__get_option_orders mcp__robinhood__get_equity_quotes mcp__robinhood__get_realized_pnl mcp__robinhood__get_equity_fundamentals mcp__robinhood__get_equity_historicals mcp__robinhood__get_earnings_calendar mcp__robinhood__get_earnings_results mcp__robinhood__search mcp__robinhood__run_scan mcp__robinhood__get_index_quotes";;
  *)       ALLOWED="WebSearch WebFetch";;
esac

# Render the prompt, substituting any {{ENV:VARNAME}} placeholders with the
# worker's environment values (e.g. HA_URL/HA_TOKEN). This avoids relying on the
# agent's shell to expand env vars, and keeps secrets out of the prompt files.
#
# Substitution is ALLOWLISTED (hardened 2026-08-02): a variable is injected only if
# the agent declares it in agent.json's "env" array, and a fixed set of platform
# secrets is never injectable at all. Before this gate, {{ENV:CLAUDE_CODE_OAUTH_TOKEN}}
# in any prompt would render the Max token straight into the model's context — and
# prompts are writable from the dashboard, from Telegram /new, and by any agent
# holding Write/Edit. Refusals are logged and substitute empty, never the value.
ENV_DENY="CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID DASH_PASSWORD"
ENV_ALLOW=$(grep -o '"env"[[:space:]]*:[[:space:]]*\[[^]]*\]' "$AGENT_DIR/agent.json" 2>/dev/null \
  | sed 's/.*\[//; s/\]//' | grep -o '[A-Za-z_][A-Za-z0-9_]*' | sort -u)
PROMPT=$(cat "$AGENT_DIR/prompt.md")
for var in $(grep -o '{{ENV:[A-Za-z_][A-Za-z0-9_]*}}' "$AGENT_DIR/prompt.md" | sed 's/{{ENV:\(.*\)}}/\1/' | sort -u); do
  val=""
  case " $ENV_DENY " in
    *" $var "*)
      echo "run-agent: refused {{ENV:$var}} (platform secret, never injectable)" >> "$LOG";;
    *)
      if printf '%s\n' $ENV_ALLOW | grep -qx "$var"; then
        val=$(printenv "$var" 2>/dev/null)
      else
        echo "run-agent: refused {{ENV:$var}} (not declared in agent.json \"env\")" >> "$LOG"
      fi;;
  esac
  PROMPT=${PROMPT//\{\{ENV:$var\}\}/$val}
done

# Cross-agent file injection: {{FILE:/workspace/...}} -> file contents.
# .json files inject the FIRST 16000 chars (a tail-truncated JSON is a malformed
# fragment; growing history files were silently corrupting their readers' input);
# everything else keeps the last-4000-chars tail. /workspace paths only.
#
# Placeholders are read from prompt.md ONLY, and this runs BEFORE the model-authored
# {{PREVIOUS_OUTPUT}}/{{PROPOSAL_HISTORY}} text is injected (hardened 2026-08-02).
# Previously the scan ran over the already-substituted prompt, so a model that emitted
# the literal string {{FILE:/workspace/kept.env}} into its own output made the NEXT run
# inject that file — a self-propagating file read reachable from any page a web-capable
# agent fetched. Credential-shaped paths are refused outright: /workspace holds
# kept.env and umami.env (KEPT_ADMIN_TOKEN, UMAMI_PASSWORD).
for ph in $(grep -o '{{FILE:/workspace/[^}]*}}' "$AGENT_DIR/prompt.md" 2>/dev/null | sort -u); do
  fp=${ph#\{\{FILE:}; fp=${fp%\}\}}
  case "$fp" in
    *..*)
      echo "run-agent: refused $ph (path traversal)" >> "$LOG"
      PROMPT=${PROMPT//"$ph"/(refused: path traversal)}
      continue;;
  esac
  fpl=$(printf '%s' "$fp" | tr 'A-Z' 'a-z')
  case "$fpl" in
    *.env|*.env.*|*token*|*secret*|*credential*|*password*|*.pem|*.key|*id_rsa*)
      echo "run-agent: refused $ph (credential-shaped path)" >> "$LOG"
      PROMPT=${PROMPT//"$ph"/(refused: credential-shaped path)}
      continue;;
  esac
  case "$fp" in
    *.json) fc=$(head -c 16000 "$fp" 2>/dev/null);;
    *)      fc=$(tail -c 4000 "$fp" 2>/dev/null);;
  esac
  [ -z "$fc" ] && fc="(no data yet)"
  PROMPT=${PROMPT//"$ph"/$fc}
done

# "What changed since last run" memory: where {{PREVIOUS_OUTPUT}} appears, inject the
# prior run's output (latest_output.txt still holds it until we overwrite it below).
case "$PROMPT" in
  *'{{PREVIOUS_OUTPUT}}'*)
    PREV=$(tail -c 4000 "$AGENT_DIR/state/latest_output.txt" 2>/dev/null)
    [ -z "$PREV" ] && PREV="(no previous run yet)"
    PROMPT=${PROMPT//\{\{PREVIOUS_OUTPUT\}\}/$PREV}
    ;;
esac

# Track record: where {{PROPOSAL_HISTORY}} appears, inject the agent's own past
# proposals (maintained by track-proposals.js) so it follows up instead of re-proposing.
case "$PROMPT" in
  *'{{PROPOSAL_HISTORY}}'*)
    PH=$(tail -c 3500 "$AGENT_DIR/state/proposal_history.json" 2>/dev/null)
    [ -z "$PH" ] && PH="(no proposal history yet)"
    PROMPT=${PROMPT//\{\{PROPOSAL_HISTORY\}\}/$PH}
    ;;
esac

# Prompt goes in on STDIN, not argv (hardened 2026-08-02). As an argument the fully
# rendered prompt — including any {{ENV:}} value substituted into it — was readable in
# /proc/<pid>/cmdline by every other process in this container, so a concurrently
# running agent could read another agent's injected secrets. Piping also removes an
# ARG_MAX ceiling on large {{FILE:}}/{{PREVIOUS_OUTPUT}} injections. $? after a
# pipeline is the exit status of the rightmost command, so CODE still means claude's.
OUTPUT=$(printf '%s' "$PROMPT" | timeout 600 claude -p --allowedTools "$ALLOWED" 2>>"$LOG")
CODE=$?

printf '%s' "$OUTPUT" > "$AGENT_DIR/state/latest_output.txt"
printf '%s\n' "$OUTPUT" >> "$LOG"

DELIVERY=$(grep -o '"delivery"[[:space:]]*:[[:space:]]*"[^"]*"' "$AGENT_DIR/agent.json" | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')
END=$(date -Iseconds)
TRIMMED=$(printf '%s' "$OUTPUT" | tr -d '[:space:]')

# "Quiet success" convention: an agent may reply with exactly SKIP to mean
# "nothing to report" -> counts as a successful run, but no delivery and no alert.
if [ "$TRIMMED" = "SKIP" ] && [ "$CODE" -eq 0 ]; then
  OK=true; SUMMARY="Skipped (nothing to report)"
  printf '{"started_at":"%s","finished_at":"%s","exit_code":%s,"ok":%s,"summary":"%s"}\n' "$START" "$END" "$CODE" "$OK" "$SUMMARY" > "$AGENT_DIR/state/last_run.json"
  echo "$START|$OK|$SUMMARY" >> "$AGENT_DIR/state/runs.csv"
  tail -n 200 "$AGENT_DIR/state/runs.csv" > "$AGENT_DIR/state/runs.csv.tmp" 2>/dev/null && mv "$AGENT_DIR/state/runs.csv.tmp" "$AGENT_DIR/state/runs.csv"
  exit 0
fi

# Content-level failure detection: a run can exit 0 with non-empty output and still be
# broken (e.g. every tool call denied, MCP server missing). Catch the telltale signs so
# the failure alert and circuit breaker fire instead of logging "Ran OK" for days.
# The "error" field rule applies ONLY to JSON-shaped output (starts with "{") — a
# narrative agent that quotes an error body (e.g. prospect-scout reporting a broken
# site) must not be marked failed and circuit-broken for doing its job.
CONTENT_ERR=""
if [ "${TRIMMED#\{}" != "$TRIMMED" ] && printf '%s' "$OUTPUT" | grep -qE '"error"[[:space:]]*:[[:space:]]*"[^"]'; then
  CONTENT_ERR="output contains an error field"
elif printf '%s' "$OUTPUT" | grep -q 'mcp__' && printf '%s' "$OUTPUT" | grep -qiE 'denied|not permitted|permission'; then
  CONTENT_ERR="output reports a tool permission problem"
elif printf '%s' "$OUTPUT" | grep -qiE '(tool|mcp|connector)[^.]{0,80}(connected|available) (in|to) this session|no [A-Za-z/ ]*tools? (is|are) connected'; then
  CONTENT_ERR="output reports missing tools"
fi

# Delivery extras: agent-name header, per-agent mute ("muted": true in agent.json),
# and quiet hours (env QUIET_HOURS="HH:MM-HH:MM": queue messages, telegram-control.js
# flushes them once quiet hours end). Failure alerts and circuit-breaker messages
# below are intentionally NOT muted or queued.
AGENT_NAME=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$AGENT_DIR/agent.json" | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')
MUTED=false
grep -q '"muted"[[:space:]]*:[[:space:]]*true' "$AGENT_DIR/agent.json" && MUTED=true
in_quiet_hours() {
  case "$QUIET_HOURS" in *:*-*:*) ;; *) return 1;; esac
  local s e now
  s=$(echo "${QUIET_HOURS%-*}" | tr -d ':'); e=$(echo "${QUIET_HOURS#*-}" | tr -d ':'); now=$(date +%H%M)
  s=$((10#$s)); e=$((10#$e)); now=$((10#$now))
  if [ "$s" -le "$e" ]; then [ "$now" -ge "$s" ] && [ "$now" -lt "$e" ]
  else [ "$now" -ge "$s" ] || [ "$now" -lt "$e" ]; fi
}
# Chunked Telegram send: messages over the ~4096 limit were silently rejected before.
# Sends up to 3 chunks of ≤3900 chars (remainder noted as truncated), 15s cap per call.
tg_send() {
  local rest="$1" chunk n=0
  while [ -n "$rest" ] && [ "$n" -lt 3 ]; do
    chunk="${rest:0:3900}"; rest="${rest:3900}"
    n=$((n+1))
    if [ -n "$rest" ] && [ "$n" -eq 3 ]; then
      chunk="$chunk
…(truncated — full output on the dashboard)"
      rest=""
    fi
    curl -s --max-time 15 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" -d chat_id="${TELEGRAM_CHAT_ID}" --data-urlencode text="${chunk}" > /dev/null
  done
}
if [ -n "$OUTPUT" ] && [ -z "$CONTENT_ERR" ] && [ "$DELIVERY" = "telegram" ] && [ "$MUTED" = "false" ] && [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
  MSG="📨 ${AGENT_NAME:-agent}
${OUTPUT}"
  if in_quiet_hours; then
    mkdir -p /workspace/.msgqueue
    printf '%s' "$MSG" > "/workspace/.msgqueue/$(date +%s%N)-$(basename "$AGENT_DIR").msg"
  else
    tg_send "$MSG"
  fi
fi

if [ -n "$OUTPUT" ] && [ "$CODE" -eq 0 ] && [ -z "$CONTENT_ERR" ]; then
  OK=true; SUMMARY="Ran OK"
elif [ -n "$CONTENT_ERR" ]; then
  OK=false; SUMMARY="Failed: $CONTENT_ERR"
else
  OK=false; SUMMARY="Run failed, timed out, or empty output"
fi
printf '{"started_at":"%s","finished_at":"%s","exit_code":%s,"ok":%s,"summary":"%s"}\n' "$START" "$END" "$CODE" "$OK" "$SUMMARY" > "$AGENT_DIR/state/last_run.json"

if [ "$TOOLS" = "portfolio" ]; then
  VAL=$(grep -o '"account_value"[[:space:]]*:[[:space:]]*[0-9.]*' "$AGENT_DIR/state/latest_output.txt" 2>/dev/null | grep -o '[0-9.]*$' | head -1)
  [ -n "$VAL" ] && echo "$(date -Iseconds),$VAL" >> "$AGENT_DIR/state/value_history.csv"
  # Record proposals + refresh prices in the track record (feeds {{PROPOSAL_HISTORY}}).
  [ -f /workspace/track-proposals.js ] && command -v node >/dev/null 2>&1 && node /workspace/track-proposals.js "$AGENT_DIR" >/dev/null 2>&1
  # Push any new proposals to Telegram with Yes/No buttons (never trades).
  [ -f /workspace/notify-proposals.js ] && command -v node >/dev/null 2>&1 && node /workspace/notify-proposals.js "$AGENT_DIR" >/dev/null 2>&1
fi

# YouTube coach: persist the recommendation JSON the coach emitted into /workspace/youtube/
# (keeps the LLM itself read-only — the deterministic post-processor does the file write).
if [ "$(basename "$AGENT_DIR")" = "youtube-coach" ]; then
  [ -f /workspace/youtube-coach.js ] && command -v node >/dev/null 2>&1 && node /workspace/youtube-coach.js "$AGENT_DIR" >/dev/null 2>&1
fi

# run history (keep last 200)
echo "$START|$OK|$SUMMARY" >> "$AGENT_DIR/state/runs.csv"
tail -n 200 "$AGENT_DIR/state/runs.csv" > "$AGENT_DIR/state/runs.csv.tmp" 2>/dev/null && mv "$AGENT_DIR/state/runs.csv.tmp" "$AGENT_DIR/state/runs.csv"

# failure alert (all delivery modes since 2026-07-26 — dashboard-delivery failures
# were silent until the circuit breaker). Deduped to the FIRST failure in a streak so
# a flapping agent doesn't spam; the circuit breaker below still sends its own pause
# notice. runs.csv already contains this run's line, so "previous" = second-to-last.
if [ "$OK" = "false" ] && [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
  RLINES=$(wc -l < "$AGENT_DIR/state/runs.csv" 2>/dev/null)
  PREV_OK=""
  [ "${RLINES:-0}" -ge 2 ] && PREV_OK=$(tail -n 2 "$AGENT_DIR/state/runs.csv" | head -n 1 | cut -d'|' -f2)
  if [ "$PREV_OK" != "false" ]; then
    ALERT_MSG="⚠ Agent ${AGENT_NAME:-$(basename "$AGENT_DIR")} run failed: ${SUMMARY}"
    curl -s --max-time 15 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" -d chat_id="${TELEGRAM_CHAT_ID}" --data-urlencode text="${ALERT_MSG}" > /dev/null
  fi
fi

# Circuit breaker: after N consecutive failures, auto-pause the agent and notify once.
# Threshold = agent.json "max_failures" if present (0 disables), else env CIRCUIT_BREAKER_FAILS, else 3.
if [ "$OK" = "false" ]; then
  THRESH=$(grep -o '"max_failures"[[:space:]]*:[[:space:]]*[0-9]*' "$AGENT_DIR/agent.json" | grep -o '[0-9]*$')
  [ -z "$THRESH" ] && THRESH="${CIRCUIT_BREAKER_FAILS:-3}"
  if [ "$THRESH" -gt 0 ] 2>/dev/null; then
    CONSEC=0
    while IFS='|' read -r _ts _ok _rest; do
      if [ "$_ok" = "false" ]; then CONSEC=$((CONSEC+1)); elif [ -n "$_ok" ]; then break; fi
    done < <(tac "$AGENT_DIR/state/runs.csv" 2>/dev/null)
    ENABLED=$(grep -o '"enabled"[[:space:]]*:[[:space:]]*[a-z]*' "$AGENT_DIR/agent.json" | grep -o 'true\|false')
    if [ "$CONSEC" -ge "$THRESH" ] && [ "$ENABLED" = "true" ]; then
      sed -i 's/"enabled"[[:space:]]*:[[:space:]]*true/"enabled": false/' "$AGENT_DIR/agent.json"
      if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
        CB_NAME=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$AGENT_DIR/agent.json" | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')
        curl -s --max-time 15 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" -d chat_id="${TELEGRAM_CHAT_ID}" --data-urlencode text="⏸ Auto-paused ${CB_NAME} after ${CONSEC} consecutive failures — check it and /resume when fixed." > /dev/null
      fi
    fi
  fi
fi
