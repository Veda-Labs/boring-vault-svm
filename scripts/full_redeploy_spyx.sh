#!/usr/bin/env bash

# Full SPYx redeploy helper.
#
# Default mode prepares fresh program IDs, syncs them into declare_id!/Anchor.toml,
# and builds local artifacts. Live mainnet sends require:
#
#   EXECUTE=true CONFIRM_FULL_REDEPLOY=true CONFIRM_SPYX_MINT=true \
#   ANCHOR_WALLET=/path/to/id.json SOLANA_RPC_URL=https://... \
#   ./scripts/full_redeploy_spyx.sh
#
# Program keypairs are intentionally kept under target/ by default, which is
# ignored by git. Back them up securely after a live deploy.

set -euo pipefail
IFS=$'\n\t'

DEFAULT_RPC_URL="https://api.mainnet-beta.solana.com"
NOW_UTC="$(date -u +"%Y%m%dT%H%M%SZ")"

if [[ -d "$HOME/.cargo/bin" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
if [[ -d "$HOME/.local/share/solana/install/active_release/bin" ]]; then
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi
if [[ -d "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin" ]]; then
  export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin:$PATH"
fi
if [[ -d "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin" ]]; then
  export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
fi

ANCHOR_BIN="${ANCHOR_BIN:-$(command -v anchor || true)}"
SOLANA_BIN="${SOLANA_BIN:-$(command -v solana || true)}"
SOLANA_KEYGEN_BIN="${SOLANA_KEYGEN_BIN:-$(command -v solana-keygen || true)}"

if [[ -z "$ANCHOR_BIN" ]]; then
  echo "Error: anchor CLI not found. Install Anchor 0.31.1 first." >&2
  exit 1
fi
if [[ -z "$SOLANA_BIN" || -z "$SOLANA_KEYGEN_BIN" ]]; then
  echo "Error: solana/solana-keygen CLI not found. Install Solana/Agave CLI first." >&2
  exit 1
fi

EXECUTE="${EXECUTE:-false}"
CONFIRM_FULL_REDEPLOY="${CONFIRM_FULL_REDEPLOY:-false}"
DEPLOY_SPYX_VAULT="${DEPLOY_SPYX_VAULT:-true}"
FORCE_NEW_PROGRAM_IDS="${FORCE_NEW_PROGRAM_IDS:-false}"

RPC_URL="${SPYX_RPC_URL:-${ANCHOR_PROVIDER_URL:-${SOLANA_RPC_URL:-$DEFAULT_RPC_URL}}}"
redact_rpc_url() {
  local value="$1"
  if [[ "$value" =~ ^(https?://[^/]+)(/.*)?$ ]]; then
    local origin="${BASH_REMATCH[1]}"
    local path_part="${BASH_REMATCH[2]:-}"
    if [[ -n "$path_part" && "$path_part" != "/" ]]; then
      echo "$origin/<redacted>"
    else
      echo "$origin"
    fi
  else
    echo "$value"
  fi
}
RPC_URL_REDACTED="$(redact_rpc_url "$RPC_URL")"
PUBLIC_OUT_DIR="${DEPLOYMENT_OUT_DIR:-deployments}"
WORK_DIR="${FULL_REDEPLOY_WORK_DIR:-target/full-redeploy-$NOW_UTC}"
PROGRAM_KEYPAIR_DIR="$WORK_DIR/program-keypairs"
BUFFER_KEYPAIR_DIR="$WORK_DIR/buffer-keypairs"
MANIFEST_PATH="$PUBLIC_OUT_DIR/full-redeploy-$NOW_UTC.json"

VAULT_PROGRAM_KEYPAIR="${VAULT_PROGRAM_KEYPAIR:-$PROGRAM_KEYPAIR_DIR/boring_vault_svm-keypair.json}"
QUEUE_PROGRAM_KEYPAIR="${QUEUE_PROGRAM_KEYPAIR:-$PROGRAM_KEYPAIR_DIR/boring_onchain_queue-keypair.json}"
VAULT_BUFFER_KEYPAIR="${VAULT_BUFFER_KEYPAIR:-$BUFFER_KEYPAIR_DIR/boring_vault_svm-buffer-keypair.json}"
QUEUE_BUFFER_KEYPAIR="${QUEUE_BUFFER_KEYPAIR:-$BUFFER_KEYPAIR_DIR/boring_onchain_queue-buffer-keypair.json}"

mkdir -p "$PROGRAM_KEYPAIR_DIR" "$BUFFER_KEYPAIR_DIR" "$PUBLIC_OUT_DIR" target/deploy

if [[ "$EXECUTE" == "true" ]]; then
  if [[ "$CONFIRM_FULL_REDEPLOY" != "true" ]]; then
    echo "Error: set CONFIRM_FULL_REDEPLOY=true for live program deployment." >&2
    exit 1
  fi
  if [[ -z "${ANCHOR_WALLET:-}" ]]; then
    echo "Error: ANCHOR_WALLET must point to the fee-payer/authority keypair JSON." >&2
    exit 1
  fi
  if [[ ! -f "${ANCHOR_WALLET/#\~/$HOME}" ]]; then
    echo "Error: ANCHOR_WALLET does not exist: $ANCHOR_WALLET" >&2
    exit 1
  fi
fi

prepare_program_keypair() {
  local label="$1"
  local source_keypair="$2"
  local target_keypair="$3"

  if [[ "$FORCE_NEW_PROGRAM_IDS" != "true" && -f "$target_keypair" && ! -f "$source_keypair" ]]; then
    echo "Reusing existing target/deploy keypair for $label: $target_keypair"
    cp "$target_keypair" "$source_keypair"
  fi

  if [[ "$FORCE_NEW_PROGRAM_IDS" == "true" || ! -f "$source_keypair" ]]; then
    echo "Generating fresh $label program keypair: $source_keypair"
    "$SOLANA_KEYGEN_BIN" new --silent --no-bip39-passphrase --force -o "$source_keypair" >/dev/null
  fi

  cp "$source_keypair" "$target_keypair"
}

prepare_program_keypair \
  "vault" \
  "$VAULT_PROGRAM_KEYPAIR" \
  "target/deploy/boring_vault_svm-keypair.json"
prepare_program_keypair \
  "queue" \
  "$QUEUE_PROGRAM_KEYPAIR" \
  "target/deploy/boring_onchain_queue-keypair.json"

prepare_buffer_keypair() {
  local label="$1"
  local keypair="$2"

  if [[ ! -f "$keypair" ]]; then
    echo "Generating $label deploy buffer keypair: $keypair"
    "$SOLANA_KEYGEN_BIN" new --silent --no-bip39-passphrase --force -o "$keypair" >/dev/null
  fi
}

prepare_buffer_keypair "vault" "$VAULT_BUFFER_KEYPAIR"
prepare_buffer_keypair "queue" "$QUEUE_BUFFER_KEYPAIR"

VAULT_PROGRAM_ID="$("$SOLANA_KEYGEN_BIN" pubkey "$VAULT_PROGRAM_KEYPAIR")"
QUEUE_PROGRAM_ID="$("$SOLANA_KEYGEN_BIN" pubkey "$QUEUE_PROGRAM_KEYPAIR")"

echo "Fresh program IDs:"
echo "  vault: $VAULT_PROGRAM_ID"
echo "  queue: $QUEUE_PROGRAM_ID"
echo "  keypairs: $PROGRAM_KEYPAIR_DIR"

echo "Syncing program IDs into declare_id!() and Anchor.toml..."
"$ANCHOR_BIN" keys sync -p boring_vault_svm
"$ANCHOR_BIN" keys sync -p boring_onchain_queue

cat > "$MANIFEST_PATH" <<EOF
{
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "executed": $EXECUTE,
  "rpcUrl": "$RPC_URL_REDACTED",
  "workDir": "$WORK_DIR",
  "vaultProgram": "$VAULT_PROGRAM_ID",
  "queueProgram": "$QUEUE_PROGRAM_ID",
  "vaultProgramKeypair": "$VAULT_PROGRAM_KEYPAIR",
  "queueProgramKeypair": "$QUEUE_PROGRAM_KEYPAIR",
  "vaultBufferKeypair": "$VAULT_BUFFER_KEYPAIR",
  "queueBufferKeypair": "$QUEUE_BUFFER_KEYPAIR"
}
EOF

echo "Building programs with fresh IDs..."
"$ANCHOR_BIN" build

echo "Redeploy manifest: $MANIFEST_PATH"

if [[ "$EXECUTE" != "true" ]]; then
  echo "Prepared fresh program IDs and local build only."
  echo "Set EXECUTE=true CONFIRM_FULL_REDEPLOY=true CONFIRM_SPYX_MINT=true when ready to deploy to mainnet."
  exit 0
fi

echo "Checking fee-payer balance..."
"$SOLANA_BIN" balance --keypair "$ANCHOR_WALLET" --url "$RPC_URL"

echo "Deploying vault program..."
"$SOLANA_BIN" program deploy \
  target/deploy/boring_vault_svm.so \
  --program-id "$VAULT_PROGRAM_KEYPAIR" \
  --buffer "$VAULT_BUFFER_KEYPAIR" \
  --keypair "$ANCHOR_WALLET" \
  --fee-payer "$ANCHOR_WALLET" \
  --upgrade-authority "$ANCHOR_WALLET" \
  --url "$RPC_URL" \
  --max-sign-attempts 20 \
  --use-rpc

echo "Deploying queue program..."
"$SOLANA_BIN" program deploy \
  target/deploy/boring_onchain_queue.so \
  --program-id "$QUEUE_PROGRAM_KEYPAIR" \
  --buffer "$QUEUE_BUFFER_KEYPAIR" \
  --keypair "$ANCHOR_WALLET" \
  --fee-payer "$ANCHOR_WALLET" \
  --upgrade-authority "$ANCHOR_WALLET" \
  --url "$RPC_URL" \
  --max-sign-attempts 20 \
  --use-rpc

if [[ ! -d node_modules ]]; then
  if command -v yarn >/dev/null 2>&1; then
    yarn install --frozen-lockfile
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm install
  else
    echo "Error: node_modules missing and neither yarn nor pnpm is available." >&2
    exit 1
  fi
fi

echo "Initializing program config PDAs..."
BORING_VAULT_PROGRAM_ID="$VAULT_PROGRAM_ID" \
BORING_QUEUE_PROGRAM_ID="$QUEUE_PROGRAM_ID" \
CONFIRM_PROGRAM_CONFIG_INIT=true \
EXECUTE=true \
DEPLOYMENT_OUT_DIR="$PUBLIC_OUT_DIR" \
./node_modules/.bin/ts-mocha -p ./tsconfig.json -t 1000000 scripts/initialize_program_configs.ts

if [[ "$DEPLOY_SPYX_VAULT" == "true" ]]; then
  echo "Deploying SPYx vault with fresh program IDs..."
  BORING_VAULT_PROGRAM_ID="$VAULT_PROGRAM_ID" \
  BORING_QUEUE_PROGRAM_ID="$QUEUE_PROGRAM_ID" \
  EXECUTE=true \
  DEPLOYMENT_OUT_DIR="$PUBLIC_OUT_DIR" \
  ./node_modules/.bin/ts-mocha -p ./tsconfig.json -t 1000000 scripts/deploy_spyx.ts
else
  echo "Skipping SPYx vault deployment because DEPLOY_SPYX_VAULT=$DEPLOY_SPYX_VAULT."
fi

echo "Full SPYx redeploy flow completed."
echo "Vault program: $VAULT_PROGRAM_ID"
echo "Queue program: $QUEUE_PROGRAM_ID"
