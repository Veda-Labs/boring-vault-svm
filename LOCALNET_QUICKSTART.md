# 🚀 Quick Start - Localnet Development

Get up and running with Boring Vault on localnet in under 2 minutes!

## Prerequisites

- ✅ Node.js & Yarn installed
- ✅ Rust & Anchor CLI installed
- ✅ Solana CLI installed

## One-Command Setup

```bash
./scripts/dev-localnet.sh
```

That's it! This single command will:
1. ✅ Start localnet validator
2. ✅ Build all programs
3. ✅ Deploy to localnet
4. ✅ Run tests

## What You Get

After running the script, you'll have:

- 🟢 **Local validator running** on `http://localhost:8899`
- 💰 **100 SOL** in your wallet
- 📦 **All 5 programs deployed**:
  - boring_vault_svm
  - boring_onchain_queue
  - layer_zero_share_mover
  - endpoint (mock)
  - state_assert
- ✅ **Programs initialized** and ready to use
- 🧪 **Tests passing** (if all went well)

## Next Steps

### View Logs
```bash
solana logs
```

### Deploy a Test Vault
```bash
yarn ts-node scripts/deploy.ts
```

### Run Tests Manually
```bash
anchor test --skip-local-validator
```

### Check Your Balance
```bash
solana balance
```

### Stop When Done
```bash
./scripts/stop-localnet.sh
```

## Daily Workflow

```bash
# Morning: Start fresh
./scripts/dev-localnet.sh

# During development: Quick redeploy
./scripts/deploy-localnet.sh

# Evening: Clean up
./scripts/stop-localnet.sh
```

## Troubleshooting

**Validator won't start?**
```bash
pkill -9 solana-test-validator
./scripts/start-localnet.sh
```

**Build fails?**
```bash
anchor clean
anchor build
```

**Need more details?**
- See `scripts/README.md` for full documentation
- Run any script with `--help` flag

---

**Happy coding! 🎉**
