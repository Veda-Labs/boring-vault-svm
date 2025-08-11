#!/bin/bash

# deploy-program.sh - Deploy a Solana program with sensible defaults
# Usage: ./deploy-program.sh <program.so> [program-id|program-id-keypair] [fee-payer-keypair]
#
# Environment variables (required unless noted otherwise):
#   SOLANA_RPC_URL   - Full RPC endpoint URL OR leave unset and set SOLANA_CLUSTER.
#   SOLANA_CLUSTER   - Cluster moniker: mainnet-beta, devnet, testnet, localhost.
#                      Ignored if SOLANA_RPC_URL is provided.
#
# Optional positional argument:
#   program-id       - Either:
#                        • A base58 address (for upgrades), or
#                        • A keypair JSON file (for first-time deploys)
#   fee-payer        - Path to keypair used as transaction fee-payer (optional).
#                      If omitted, defaults to ~/.config/solana/id.json when present.
#
# The script hard-codes --max-sign-attempts 20, runs `anchor build` first,
# and defaults RPC URL to mainnet-beta public RPC.

set -euo pipefail
IFS=$'\n\t'

# Positional parameters
PROGRAM_PATH=${1:-}
PROGRAM_ID_ARG=${2:-}
FEEPAYER_ARG=${3:-}

if [[ -z "$PROGRAM_PATH" ]]; then
  echo "Usage: $0 <program.so> [program-id|program-id-keypair] [fee-payer-keypair]"
  exit 1
fi

# Ensure anchor CLI is available
if ! command -v anchor >/dev/null 2>&1; then
  echo "Error: 'anchor' CLI not found in PATH. Please install Anchor." >&2
  exit 1
fi

echo "🛠️  Running anchor build ..."
anchor build

# Verify compiled program exists now
if [[ ! -f "$PROGRAM_PATH" ]]; then
  echo "Error: Compiled program '$PROGRAM_PATH' not found after anchor build."
  exit 1
fi

# Display environment information and confirm
ANCHOR_VER=$(anchor --version 2>/dev/null | head -n1)
SOLANA_VER=$(solana --version 2>/dev/null | head -n1 || echo "solana CLI not found")
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "-" )
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "-")

echo "📦 Anchor CLI:   $ANCHOR_VER"
echo "🔗 Solana CLI:   $SOLANA_VER"
echo "🌿 Git branch:   $GIT_BRANCH"
echo "🔖 Git commit:   $GIT_COMMIT"

read -rp "Continue with program deployment? [y/N] " confirm
if [[ ! $confirm =~ ^[Yy] ]]; then
  echo "Aborting deployment."; exit 0
fi

# Build base command
CMD=(solana program deploy "${PROGRAM_PATH}" "--max-sign-attempts" "20")

# RPC / cluster handling: prefer env vars, fall back to mainnet-beta public RPC
if [[ -n "${SOLANA_RPC_URL:-}" ]]; then
  CMD+=("--url" "${SOLANA_RPC_URL}")
elif [[ -n "${SOLANA_CLUSTER:-}" ]]; then
  CMD+=("--url" "${SOLANA_CLUSTER}")
else
  CMD+=("--url" "https://api.mainnet-beta.solana.com")
fi

############################
# Program ID handling      #
############################
if [[ -n "$PROGRAM_ID_ARG" ]]; then
  CMD+=("--program-id" "${PROGRAM_ID_ARG}")
fi

# Fee-payer keypair handling
KEYPAIR_PATH="${FEEPAYER_ARG:-}"
if [[ -z "$KEYPAIR_PATH" ]]; then
  DEFAULT_KP="$HOME/.config/solana/id.json"
  if [[ -f "$DEFAULT_KP" ]]; then
    KEYPAIR_PATH="$DEFAULT_KP"
  fi
fi

if [[ -n "$KEYPAIR_PATH" ]]; then
  CMD+=("--keypair" "${KEYPAIR_PATH}")
fi

echo "🔨 Running: ${CMD[*]}"
"${CMD[@]}"
