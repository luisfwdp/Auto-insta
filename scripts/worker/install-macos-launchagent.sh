#!/usr/bin/env bash
# Runs the PING CHAT DM worker on this Mac as a LaunchAgent: starts at login,
# restarts if it exits, logs to ~/Library/Logs/pingchat-worker.log.
#
# Homologation only: messages stop while the Mac sleeps or is off. For 24/7
# use a hosted worker (see docs/fly-worker.md).
#
# Usage, from the repository root:
#   1. Create .env.worker (never commit it) with:
#        DATABASE_URL=<Supabase session pooler, port 5432>
#        REDIS_URL=<same value as Vercel's REDIS_URL>
#        ENCRYPTION_KEY=<same value as Vercel's ENCRYPTION_KEY>
#        META_GRAPH_API_VERSION=v26.0
#        DB_POOL_MAX=5
#   2. npm ci && npm run db:generate
#   3. bash scripts/worker/install-macos-launchagent.sh
#   Remove: launchctl bootout gui/$(id -u)/com.pingchat.worker
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$REPO/.env.worker"
LABEL="com.pingchat.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/pingchat-worker.log"
NODE_BIN="$(command -v node)"

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (see the header of this script)."; exit 1; }
for key in DATABASE_URL REDIS_URL ENCRYPTION_KEY; do
  grep -q "^$key=." "$ENV_FILE" || { echo "$key is missing in $ENV_FILE"; exit 1; }
done
[ -x "$REPO/node_modules/.bin/tsx" ] || { echo "Run npm ci first."; exit 1; }
chmod 600 "$ENV_FILE"

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--env-file=$ENV_FILE</string>
    <string>$REPO/node_modules/.bin/tsx</string>
    <string>worker/dm-worker.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>NODE_ENV</key><string>production</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Worker started. Logs: tail -f $LOG"
echo "Check: curl -s https://auto-insta-pi.vercel.app/api/health  (worker.healthy should be true within ~30s)"
