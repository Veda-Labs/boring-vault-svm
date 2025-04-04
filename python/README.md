# Boring Vault SVM - Python SDK & Tests

This directory contains the Python utilities for interacting with the Boring Vault SVM program and the corresponding tests.

## Prerequisites

-   Rust & Cargo installed
-   Solana Tool Suite installed (`solana-cli`)
-   Anchor CLI installed (`avm install latest`, `avm use latest`)
-   Node.js & Yarn (or npm) installed (for running setup scripts)
-   Python 3.x installed
-   Poetry installed (`pip install poetry`)

## Setup

1.  **Install Node.js dependencies** (from the workspace root):
    ```bash
    yarn install
    # or npm install
    ```

2.  **Install Python dependencies** (from within the `python/` directory):
    ```bash
    cd python
    poetry install
    cd .. # Go back to workspace root
    ```

3.  **Build the Anchor Program** (from the workspace root):
    ```bash
    anchor build
    ```

## Running Tests

1.  **Start Local Validator & Deploy Program:**
    Open a separate terminal in the workspace root and run:
    ```bash
    anchor localnet
    ```
    This will start a local validator and deploy the program specified in `Anchor.toml`.

2.  **Run Setup Script:**
    In another terminal (at the workspace root), run the setup script to initialize the program config and deploy the test vault:
    ```bash
    anchor run setup_test_vault
    ```
    Verify this script completes successfully. It should output the Program ID, Authority, and Vault State PDA for Vault ID 1.

3.  **Run Pytest:**
    Navigate back to the `python/` directory and run the tests using Poetry:
    ```bash
    cd python
    poetry run pytest -vs
    ```

This should execute the tests defined in `python/tests/` against the locally running validator and the pre-initialized vault state.
