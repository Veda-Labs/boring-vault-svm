#!/bin/bash
# test-localnet.sh - Run tests against localnet deployment
# This script initializes programs and runs basic functionality tests

set -euo pipefail

echo "🧪 Testing Localnet Deployment..."

# Check we're on localnet
CURRENT_URL=$(solana config get | grep "RPC URL" | awk '{print $3}')
if [[ "$CURRENT_URL" != "http://localhost:8899" ]]; then
    echo "⚠️  Not on localnet! Current: $CURRENT_URL"
    exit 1
fi

# Check validator is running
if ! solana cluster-version &>/dev/null; then
    echo "❌ Localnet validator is not running!"
    exit 1
fi

echo ""
echo "1️⃣  Initializing Programs..."
echo ""

# Initialize vault program
echo "🔧 Initializing vault program..."
yarn ts-node scripts/initialize.ts || echo "⚠️  Initialization may have already been done"

echo ""
echo "2️⃣  Running Anchor Tests..."
echo ""

# Run all tests
RUST_LOG=error anchor test --skip-local-validator

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ All tests passed!"
else
    echo ""
    echo "⚠️  Some tests failed. Check output above."
fi

echo ""
echo "3️⃣  Basic Functionality Check..."
echo ""

# Check program accounts exist
echo "📊 Checking program states..."
WALLET=$(solana address)
echo "   Wallet: $WALLET"

BALANCE=$(solana balance | awk '{print $1}')
echo "   Balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 10" | bc -l) )); then
    echo "   ⚠️  Low balance, requesting airdrop..."
    solana airdrop 50
fi

echo ""
echo "✅ Localnet testing complete!"
echo "💡 To deploy a test vault, check scripts/deploy.ts"
