#!/bin/sh
# Start the Fastify engine in the background, then exec the Next.js standalone
# server as the foreground process (PID 1). SIGTERM from the container runtime
# hits Next.js, which shuts down cleanly; the trap kills the engine first.
set -e

node dist/src/server.js &
ENGINE_PID=$!

trap "kill $ENGINE_PID 2>/dev/null; exit 0" INT TERM

exec node nextjs/server.js
