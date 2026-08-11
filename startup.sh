#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code
# Trade lockdown (survives a container recreate): options orders and cancels stay
# hard-denied for every Claude run. Equity placement is NOT denied globally — it is
# granted ONLY via execute-trades.js's per-run allowlist after the user taps Yes;
# no analyst agent's --allowedTools includes it.
mkdir -p /root/.claude
printf '%s\n' '{"permissions":{"deny":["mcp__robinhood__place_option_order","mcp__robinhood__cancel_equity_order","mcp__robinhood__cancel_option_order"]}}' > /root/.claude/settings.json
echo "Agent scheduler running. Managing agents in /workspace/agents."

run_agent() { bash /workspace/run-agent.sh "$1"; }

# Window-match firing: a daily/weekly slot fires when its time has been REACHED
# within the last SCHED_WINDOW_MIN minutes (default 360) and hasn't fired today.
# Replaces exact-minute matching, which silently skipped a schedule whenever a
# long agent run blocked the loop past that minute. .lastfire = "YYYYMMDD slot…"
# (one line, per-day slot list; legacy YYYYMMDDHHMM values are treated as stale).
fire_if_due() { # $1 = agent dir, $2 = HH:MM slot
  local dir="$1" t="$2" lf tn slot diff
  case "$t" in [0-9]:[0-9][0-9]|[0-9][0-9]:[0-9][0-9]) ;; *) return 1;; esac
  lf=$(cat "$dir/state/.lastfire" 2>/dev/null)
  case "$lf" in "$TODAYD"|"$TODAYD "*) ;; *) lf="$TODAYD";; esac
  tn=$((10#$(echo "$t" | tr -d ':')))
  slot=$(printf '%04d' "$tn")
  diff=$(( (NOWN/100)*60 + NOWN%100 - (tn/100)*60 - tn%100 ))
  { [ "$diff" -ge 0 ] && [ "$diff" -le "${SCHED_WINDOW_MIN:-360}" ]; } || return 1
  printf '%s' " $lf " | grep -q " $slot " && return 1
  echo "$lf $slot" > "$dir/state/.lastfire"
  run_agent "$dir"
}

while true; do
  NOW=$(date +%H:%M)
  DOW=$(date +%a)
  NOWSTAMP=$(date +%Y%m%d%H%M)
  EPOCH=$(date +%s)
  TODAYD=$(date +%Y%m%d)
  NOWN=$((10#$(echo "$NOW" | tr -d ':')))
  for dir in /workspace/agents/*/; do
    [ -f "$dir/agent.json" ] || continue
    mkdir -p "$dir/state"
    if [ -f "$dir/state/run.trigger" ]; then
      rm -f "$dir/state/run.trigger"; run_agent "$dir"; continue
    fi
    enabled=$(grep -o '"enabled"[[:space:]]*:[[:space:]]*[a-z]*' "$dir/agent.json" | grep -o 'true\|false')
    [ "$enabled" = "true" ] || continue
    sched=$(grep -o '"schedule"[[:space:]]*:[[:space:]]*"[^"]*"' "$dir/agent.json" | sed 's/.*"schedule"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    kind=$(echo "$sched" | awk '{print $1}')
    case "$kind" in
      daily)
        IFS=',' read -ra TS <<< "$(echo "$sched" | awk '{print $2}')"
        for t in "${TS[@]}"; do
          fire_if_due "$dir" "$t"
        done;;
      weekly)
        days=$(echo "$sched" | awk '{print $2}'); t=$(echo "$sched" | awk '{print $3}')
        if echo ",$days," | grep -iq ",$DOW,"; then
          fire_if_due "$dir" "$t"
        fi;;
      interval)
        mins=$(echo "$sched" | awk '{print $2}'); case "$mins" in ''|*[!0-9]*) mins=60;; esac
        stampf="$dir/state/.lastrun_epoch"
        if [ ! -f "$stampf" ]; then echo "$EPOCH" > "$stampf"
        else
          last=$(cat "$stampf" 2>/dev/null || echo 0)
          if [ $((EPOCH - last)) -ge $((mins * 60)) ]; then echo "$EPOCH" > "$stampf"; run_agent "$dir"; fi
        fi;;
    esac
  done

  # Weekly reliability digest (deterministic, no LLM) — Mondays only; the daily
  # one-pager below carries a one-line health summary the rest of the week.
  # Default 08:00; override with DIGEST_TIME env.
  DTIME="${DIGEST_TIME:-08:00}"
  if [ "$NOW" = "$DTIME" ] && [ "$DOW" = "Mon" ] && [ "$(cat /workspace/.digest.lastfire 2>/dev/null)" != "$NOWSTAMP" ]; then
    echo "$NOWSTAMP" > /workspace/.digest.lastfire
    bash /workspace/digest.sh >/dev/null 2>&1
  fi

  # Daily one-pager brief (compose-brief.sh): ONE silent Telegram message stitched
  # from every "brief": true agent. Fires at-or-AFTER BRIEF_TIME (default 07:30)
  # with a date-stamped dedupe — a long agent run blocking the loop past the exact
  # minute delays it instead of skipping the day.
  BRTIME="${BRIEF_TIME:-07:30}"
  TODAYSTAMP=$(date +%Y%m%d)
  if [ -f /workspace/compose-brief.sh ] && [ "$((10#$(echo "$NOW" | tr -d ':')))" -ge "$((10#$(echo "$BRTIME" | tr -d ':')))" ] && [ "$(cat /workspace/.brief.lastfire 2>/dev/null)" != "$TODAYSTAMP" ]; then
    echo "$TODAYSTAMP" > /workspace/.brief.lastfire
    bash /workspace/compose-brief.sh >/dev/null 2>&1
  fi

  # AI Workspace chat relay: keep chat-runner.sh alive as a background daemon
  # (spawned on the first pass, respawned if it ever dies). Fully guarded —
  # if the script is missing this is a no-op; if it crashes, agents are unaffected.
  if [ -f /workspace/chat-runner.sh ]; then
    CRPID=$(cat /workspace/chat/.runner.pid 2>/dev/null)
    case "$CRPID" in ''|*[!0-9]*) CRPID=0;; esac
    if [ "$CRPID" -eq 0 ] || ! kill -0 "$CRPID" 2>/dev/null; then
      mkdir -p /workspace/chat
      bash /workspace/chat-runner.sh >/dev/null 2>&1 &
      echo $! > /workspace/chat/.runner.pid
    fi
  fi

  # Autonomous jobs runner (AI Workspace Phase 3): same watchdog pattern as the
  # chat relay above. Fully guarded - missing script means no-op.
  if [ -f /workspace/job-runner.sh ]; then
    JRPID=$(cat /workspace/jobs/.runner.pid 2>/dev/null)
    case "$JRPID" in ''|*[!0-9]*) JRPID=0;; esac
    if [ "$JRPID" -eq 0 ] || ! kill -0 "$JRPID" 2>/dev/null; then
      mkdir -p /workspace/jobs
      bash /workspace/job-runner.sh >/dev/null 2>&1 &
      echo $! > /workspace/jobs/.runner.pid
    fi
  fi

  # Two-way Telegram control: process any incoming commands (single pass).
  if [ -f /workspace/telegram-control.js ]; then
    node /workspace/telegram-control.js >/dev/null 2>&1
  fi

  # One-tap trade execution: place any user-approved orders (single pass, ≤ MAX_TRADE_USD each).
  if [ -f /workspace/execute-trades.js ]; then
    node /workspace/execute-trades.js >/dev/null 2>&1
  fi

  # YouTube analytics fetch (once/day around YOUTUBE_FETCH_TIME, default 06:40). Deterministic,
  # writes /workspace/youtube/*.json for the Studio dashboard. Same .lastfire gate as digest/backup.
  YTTIME="${YOUTUBE_FETCH_TIME:-06:40}"
  if [ -f /workspace/youtube-fetch.js ] && [ "$NOW" = "$YTTIME" ] && [ "$(cat /workspace/.ytfetch.lastfire 2>/dev/null)" != "$NOWSTAMP" ]; then
    echo "$NOWSTAMP" > /workspace/.ytfetch.lastfire
    node /workspace/youtube-fetch.js >/dev/null 2>&1
  fi

  # Kept (site-health) stats fetch for the dashboard's Kept page. Deterministic,
  # writes /workspace/kept/state.json. Fires every KEPT_FETCH_MIN minutes (default 15)
  # — or on the NEXT pass when the dashboard drops kept/refresh.trigger (Run-now button).
  KFMIN="${KEPT_FETCH_MIN:-15}"
  if [ -f /workspace/kept-fetch.js ]; then
    klast=$(cat /workspace/.keptfetch.lastrun_epoch 2>/dev/null || echo 0)
    case "$klast" in ''|*[!0-9]*) klast=0;; esac
    if [ -f /workspace/kept/refresh.trigger ] || [ $((EPOCH - klast)) -ge $((KFMIN * 60)) ]; then
      echo "$EPOCH" > /workspace/.keptfetch.lastrun_epoch
      rm -f /workspace/kept/refresh.trigger
      node /workspace/kept-fetch.js >/dev/null 2>&1
      [ -f /workspace/umami-fetch.js ] && node /workspace/umami-fetch.js >/dev/null 2>&1
    fi
  fi

  # Minecraft health alerts. Reads only health/minecraft.json and pings Telegram
  # when the server is up-but-not-answering or backups have gone stale. Same
  # interval-gate idiom as kept-fetch above; a no-op if the script isn't present.
  if [ -f /workspace/minecraft-alert.js ]; then
    mclast=$(cat /workspace/.mcalert.lastrun_epoch 2>/dev/null || echo 0)
    case "$mclast" in ''|*[!0-9]*) mclast=0;; esac
    if [ $((EPOCH - mclast)) -ge 300 ]; then
      echo "$EPOCH" > /workspace/.mcalert.lastrun_epoch
      node /workspace/minecraft-alert.js >/dev/null 2>&1
    fi
  fi

  # Momo review-queue + song-request alerts. Deterministic replacement for the
  # momo-queue-alert agent (retired 2026-08-02): that agent ran at the `power` tier
  # — unrestricted root Bash in this container — to diff two JSON files, on input
  # authored by the off-NAS PC pipeline. This does the same job with no LLM and no
  # shell, and commits an id to announced.json only once Telegram confirms delivery
  # (the agent marked ids announced BEFORE sending, permanently burning any that a
  # timeout or a failed send dropped). Same interval-gate idiom as minecraft-alert
  # above; a no-op if the script isn't present.
  MOMOMIN="${MOMO_ALERT_MIN:-30}"
  if [ -f /workspace/momo-alert.js ]; then
    molast=$(cat /workspace/.momoalert.lastrun_epoch 2>/dev/null || echo 0)
    case "$molast" in ''|*[!0-9]*) molast=0;; esac
    if [ $((EPOCH - molast)) -ge $((MOMOMIN * 60)) ]; then
      echo "$EPOCH" > /workspace/.momoalert.lastrun_epoch
      node /workspace/momo-alert.js >/dev/null 2>&1
    fi
  fi

  # Daily config backup (keeps last 14 in /workspace/backups). Fires at-or-AFTER
  # BACKUP_TIME (default 03:30) with a date-stamped dedupe — same pattern as the
  # brief gate above, so a pass that blows past the exact minute (e.g. a long
  # synchronous execute-trades call) delays the backup instead of skipping the
  # day (the exact-match gate silently lost the 2026-07-21 backup this way).
  BTIME="${BACKUP_TIME:-03:30}"
  if [ "$((10#$(echo "$NOW" | tr -d ':')))" -ge "$((10#$(echo "$BTIME" | tr -d ':')))" ] && [ "$(cat /workspace/.backup.lastfire 2>/dev/null)" != "$TODAYSTAMP" ]; then
    echo "$TODAYSTAMP" > /workspace/.backup.lastfire
    bash /workspace/backup.sh >/dev/null 2>&1
  fi

  sleep 20
done
