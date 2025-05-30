# Boring Vault SVM

## Getting Started

1. Install dependencies:

```bash
yarn install
```

2. (Optional) Set up environment variables:

```bash
cp sample.env .env
```

Then edit `.env` and fill in your values.

3. Build the project:

```bash
anchor build
```

4. Sync program IDs (if you encounter program ID mismatch errors):

```bash
anchor keys sync
```

5. Rust tests:

```bash
anchor test
```

## License

All Rights Reserved

This code is proprietary and confidential. Unauthorized copying, modification, distribution, or use of this code, via any medium, is strictly prohibited without express written permission.

5. To install new solana version

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/v2.0.15/install)"
```

Where 2.0.15 is the version you want to install

solana --version
solana-cli 2.0.15 (src:f8f3fe31; feat:607245837, client:Agave)
