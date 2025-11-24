#!/bin/bash
# deploy-localnet.sh - Build and deploy programs to localnet
# This script builds all Anchor programs and deploys them to the local validator

set -euo pipefail

echo "🏗️  Building and Deploying to Localnet..."

# Ensure we're using localnet
CURRENT_URL=$(solana config get | grep "RPC URL" | awk '{print $3}')
if [[ "$CURRENT_URL" != "http://localhost:8899" ]]; then
    echo "⚠️  Current RPC: $CURRENT_URL"
    echo "🔄 Switching to localnet..."
    solana config set --url localhost
fi

# Check validator is running
if ! solana cluster-version &>/dev/null; then
    echo "❌ Localnet validator is not running!"
    echo "💡 Run './scripts/start-localnet.sh' first"
    exit 1
fi

echo ""
echo "📦 Building Anchor programs..."
anchor build

if [ $? -ne 0 ]; then
    echo "❌ Build failed!"
    exit 1
fi

echo ""
echo "✅ Build successful!"
echo ""
echo "🚀 Deploying programs to localnet..."

# Get the program IDs from Anchor.toml
echo "📋 Programs to deploy:"
echo "  - boring_vault_svm"
echo "  - boring_onchain_queue"
echo "  - layer_zero_share_mover"
echo "  - endpoint (mock)"
echo "  - state_assert"

# Deploy using Anchor
anchor deploy

if [ $? -ne 0 ]; then
    echo "❌ Deployment failed!"
    exit 1
fi

echo ""
echo "✅ All programs deployed successfully!"
echo ""

# Display program IDs
echo "📝 Deployed Program IDs:"
solana program show --programs | grep -E "(boring|endpoint|state_assert)" || echo "Run 'solana program show --programs' to see all deployed programs"

echo ""
echo "✅ Deployment complete!"
echo "💡 Next: Run './scripts/test-localnet.sh' to test the deployment"
