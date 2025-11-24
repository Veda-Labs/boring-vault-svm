#!/bin/bash
# stop-localnet.sh - Stop the localnet validator
# Safely stops the running Solana test validator

set -euo pipefail

echo "🛑 Stopping Solana Localnet Validator..."

if pgrep -x "solana-test-validator" > /dev/null; then
    pkill solana-test-validator
    echo "✅ Validator stopped"
    
    # Wait a moment for cleanup
    sleep 1
    
    # Check if it's really stopped
    if pgrep -x "solana-test-validator" > /dev/null; then
        echo "⚠️  Validator still running, force killing..."
        pkill -9 solana-test-validator
    fi
else
    echo "ℹ️  No validator is currently running"
fi

echo ""
echo "💡 To start again: ./scripts/start-localnet.sh"
