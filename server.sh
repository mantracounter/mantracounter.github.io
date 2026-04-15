#!/usr/bin/env bash
# Serve current directory on port 8108, enable gzip serving of precompressed files,
# disable caching (-c-1) and forward stderr to stdout so all npx/http-server output
# is visible in stdout.
exec npx http-server . -p 8108 --gzip -c-1 "$@" 2>&1
