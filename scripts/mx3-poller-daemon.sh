#!/usr/bin/env bash
set -euo pipefail

# Load credentials
set -a
source "$HOME/.config/mx3.env"
set +a

cd /Users/ryo/dev/scratch/mx3-gym-api
exec /opt/homebrew/bin/npx tsx src/poller.ts
