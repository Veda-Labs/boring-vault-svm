#!/bin/bash
# dev-localnet.sh - All-in-one development script
# This script starts localnet, deploys, and tests in one command

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🚀 Boring Vault - Localnet Development Environment"
echo "=================================================="
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
}

trap cleanup EXIT

# Parse arguments
SKIP_TESTS=false
DEPLOY_ONLY=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-tests)
            SKIP_TESTS=true
            shift
            ;;
        --deploy-only)
            DEPLOY_ONLY=true
            shift
            ;;
        --help)
            echo "Usage: ./scripts/dev-localnet.sh [OPTIONS]"
            echo ""
            echo "Options:"
           echo "  --skip-tests     Deploy but don't run tests"
            echo "  --deploy-only    Only deploy, skip initialization and tests"
            echo "  --help           Show this help message"
            echo ""
            echo "This script will:"
            echo "  1. Start localnet validator (if not running)"
            echo "  2. Build and deploy all programs"
            echo "  3. Initialize programs (unless --deploy-only)"
            echo "  4. Run tests (unless --skip-tests or --deploy-only)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage information"
            exit 1
            ;;
    esac
done

# Step 1: Start localnet
echo "Step 1/4: Starting Localnet..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
"$SCRIPT_DIR/start-localnet.sh"

echo ""
echo "Step 2/4: Building and Deploying..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
"$SCRIPT_DIR/deploy-localnet.sh"

if [ "$DEPLOY_ONLY" = true ]; then
    echo ""
    echo "✅ Deployment complete!"
    echo "   (Skipping initialization and tests as requested)"
    exit 0
fi

if [ "$SKIP_TESTS" = false ]; then
    echo ""
    echo "Step 3/4: Testing Deployment..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    "$SCRIPT_DIR/test-localnet.sh"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Development Environment Ready!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🔗 Useful Commands:"
echo "   solana logs              - Stream transaction logs"
echo "   solana balance           - Check wallet balance"
echo "   anchor test              - Run test suite"
echo "   pkill solana-test-validator - Stop validator"
echo ""
echo "📝 Validator logs: test-ledger/validator.log"
echo ""
