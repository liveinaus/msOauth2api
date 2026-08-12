#!/usr/bin/env bash

# ── Configurable host / ports ─────────────────────────────────────────────────
BACKEND_HOST=${BACKEND_HOST:-localhost}
BACKEND_PORT=${BACKEND_PORT:-3000}
FRONTEND_HOST=${FRONTEND_HOST:-localhost}
FRONTEND_PORT=${FRONTEND_PORT:-5173}

# Services always bind to 0.0.0.0; BACKEND_HOST/FRONTEND_HOST are display/proxy names only
PROXY_HOST=127.0.0.1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── .env setup ────────────────────────────────────────────────────────────────
if [ ! -f backend/.env ]; then
  cp env.example backend/.env
  echo ""
  echo "Created backend/.env from env.example."
  echo ""
fi

# The backend refuses to boot on an empty or publicly-known JWT_SECRET, so generate a
# random one for local dev if the current value is missing or a placeholder.
if ! grep -q "^JWT_SECRET=." backend/.env 2>/dev/null \
   || grep -qE "^JWT_SECRET=(change-me-in-production|changeme|secret)$" backend/.env 2>/dev/null; then
  SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  if grep -q "^JWT_SECRET=" backend/.env 2>/dev/null; then
    sed "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" backend/.env > backend/.env.tmp && mv backend/.env.tmp backend/.env
  else
    printf 'JWT_SECRET=%s\n' "$SECRET" >> backend/.env
  fi
  echo "Generated a random JWT_SECRET in backend/.env for local development."
  echo ""
fi

if grep -q "^ADMIN_PASSWORD=changeme$" backend/.env 2>/dev/null; then
  echo "NOTE: backend/.env uses the default ADMIN_PASSWORD (changeme)."
  echo "      You'll be prompted to change it on first login."
  echo ""
fi

# ── Dependencies ──────────────────────────────────────────────────────────────
echo "Installing dependencies..."
(cd backend && npm install --no-audit) || true
(cd frontend && npm install --no-audit) || true

# ── Cleanup on exit ───────────────────────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""

# Each service is a chain: subshell -> npm -> sh -c -> tsx/vite -> the node that listens.
# Killing only the pid we hold leaves the rest alive, and a surviving `tsx watch` respawns
# the server we just stopped, so walk the tree and kill depth-first.
kill_tree() {
  local pid=$1
  [ -z "$pid" ] && return 0
  local kid
  for kid in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$kid"; done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  echo ""
  echo "Stopping..."
  kill_tree "$BACKEND_PID"
  kill_tree "$FRONTEND_PID"
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Free the configured ports ─────────────────────────────────────────────────
kill_port() {
  local PORT=$1
  local PIDS
  PIDS=$(ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+')
  [ -z "$PIDS" ] && return 0
  echo "Killing existing process(es) on port $PORT: $PIDS"
  kill -9 $PIDS 2>/dev/null || true
  sleep 0.5
}

for PORT in $BACKEND_PORT $FRONTEND_PORT; do
  kill_port "$PORT"
done

# kill_port only reaches whatever holds the socket, so watchers orphaned by an earlier run
# (a killed terminal, a crash before the trap fired) survive it and pile up. Match on this
# checkout's paths so other projects are left alone.
kill_stale_watchers() {
  local pattern pids
  for pattern in "$SCRIPT_DIR/backend/node_modules/.bin/tsx" \
                 "$SCRIPT_DIR/frontend/node_modules/.bin/vite"; do
    pids=$(pgrep -f "$pattern" 2>/dev/null | grep -v "^$$\$")
    [ -z "$pids" ] && continue
    echo "Killing stale watcher(s): $(echo "$pids" | tr '\n' ' ')"
    kill -9 $pids 2>/dev/null || true
  done
}
kill_stale_watchers

# ── Start services ────────────────────────────────────────────────────────────
echo ""
echo "  Backend:  http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "  Frontend: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
echo ""
echo "Press Ctrl+C to stop both."
echo ""

(cd backend && HOST=0.0.0.0 PORT=$BACKEND_PORT npm run dev) &
BACKEND_PID=$!

printf "Waiting for backend"
until (echo > /dev/tcp/127.0.0.1/$BACKEND_PORT) 2>/dev/null; do
  printf "."
  sleep 1
done
echo " ready"

(cd frontend && BACKEND_HOST=$PROXY_HOST BACKEND_PORT=$BACKEND_PORT \
  npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" --strictPort) &
FRONTEND_PID=$!

wait
