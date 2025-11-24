#!/bin/bash
# start-localnet.sh - Start Solana localnet validator
# This script starts a local validator for development and testing

set -euo pipefail

echo "🚀 Starting Solana Localnet Validator..."

# Check if validator is already running
if pgrep -x "solana-test-validator" > /dev/null; then
    echo "⚠️  Solana validator is already running!"
    read -rp "Kill existing validator and restart? [y/N] " answer
    if [[ $answer =~ ^[Yy] ]]; then
        echo "🛑 Stopping existing validator..."
        pkill -9 solana-test-validator || true
        sleep 2
    else
        echo "Using existing validator"
        exit 0
    fi
fi

# Clean up old ledger (optional - uncomment if you want fresh state each time)
# rm -rf test-ledger

# Start validator with recommended settings for development
echo "🔧 Starting validator with development configuration..."

solana-test-validator \
    --reset \
    --quiet \
    --ledger test-ledger \
    --rpc-port 8899 \
    --limit-ledger-size 1000000 \
    &

VALIDATOR_PID=$!
echo "📊 Validator PID: $VALIDATOR_PID"

# Wait for validator to be ready
echo "⏳ Waiting for validator to become ready..."
for i in {1..30}; do
    if solana cluster-version --url http://localhost:8899 &>/dev/null; then
        echo "✅ Validator is ready!"
        
        # Set Solana config to localnet
        solana config set --url localhost
        
        # Show cluster info
        echo ""
        echo "📡 Cluster Information:"
        solana cluster-version
        
        # Airdrop some SOL to the default wallet
        echo ""
        echo "💰 Airdropping 100 SOL to your wallet..."
        WALLET_ADDRESS=$(solana address)
        solana airdrop 100 "$WALLET_ADDRESS" || echo "Airdrop may have failed, but continuing..."
        
        echo ""
        echo "💼 Your wallet balance:"
        solana balance
        
        echo ""
        echo "✅ Localnet is ready for development!"
        echo "📝 Validator logs: test-ledger/validator.log"
        echo "🛑 To stop: pkill solana-test-validator"
        echo ""
        exit 0
    fi
    echo "  Attempt $i/30..."
    sleep 1
done

echo "❌ Validator failed to start within 30 seconds"
pkill -9 solana-test-validator || true
exit 1
