# Boring Vault Tools

A collection of tools for interacting with the Boring Vault program on Solana.

## Prerequisites

- Python 3.8 or higher
- Rust toolchain (install via [rustup](https://rustup.rs/))
- Python development headers (`python3-dev` package on Ubuntu/Debian)

## Installation

1. Create and activate a virtual environment:
```bash
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. Build the Rust components first:
```bash
# Make sure you're in the tools directory
cd tools
cargo build --release
```

3. Install the Python package in development mode:
```bash
# Still in the tools directory
pip install -e .
```

This will install the Python package using the pre-built Rust components.

4. Ensure there is a `.env` file in the root directory of the project with your Alchemy RPC API key:
```
ALCHEMY_API_KEY=your_api_key_here
```

## Usage

### Querying Vault Information

The `query_vault.py` script allows you to query information about deployed vaults:

```bash
# Make sure you're in the tools directory
cd tools

# Run with default settings
python3 query_vault.py

# Query a specific vault ID
python3 query_vault.py --vault-id 1

# Use a custom RPC URL
python3 query_vault.py --rpc-url https://solana-mainnet.g.alchemy.com/v2/

# Query multiple vaults
python3 query_vault.py --limit 5

# Start from a specific index
python3 query_vault.py --start-index 10 --limit 5
```

## Development

### Making Changes

If you modify the Rust code:

```bash
# Rebuild the Rust library
cargo build --release

# Reinstall the Python package
pip install -e .
```

## License

MIT 