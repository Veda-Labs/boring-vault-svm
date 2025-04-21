#!/usr/bin/env python3
import argparse
import json
import base64
import requests
import os
from dotenv import load_dotenv
from boring_vault_tools import sum_vault_balances

# Load environment variables from .env file
print(f"Current working directory: {os.getcwd()}")
load_dotenv()
api_key = os.getenv("ALCHEMY_API_KEY")
print(f"API key loaded: {'Yes' if api_key else 'No'}")

# Program ID from source file
BORING_VAULT_SVM = "5ZRnXG4GsUMLaN7w2DtJV1cgLgcXHmuHCmJ2MxoorWCE"  # Updated program ID

def get_vault_info(program_id, rpc_url):
    """Get information about vaults deployed by the given program."""
    api_key = os.getenv("ALCHEMY_API_KEY")
    if not api_key:
        raise ValueError("ALCHEMY_API_KEY environment variable not set")
        
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getProgramAccounts",
        "params": [
            program_id,
            {
                "encoding": "base64",
                "commitment": "confirmed"
            }
        ]
    }
    
    try:
        response = requests.post(rpc_url, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        
        if "result" not in data or data["result"] is None:
            print(f"No accounts found for program {program_id}")
            return []
        
        vaults = []
        for account in data["result"]:
            try:
                # Try to parse the account data to extract vault ID
                account_data = base64.b64decode(account["account"]["data"][0])
                # Assuming vault_id is stored at a specific position in the account data
                # This is a placeholder and may need to be adjusted
                vault_id = int.from_bytes(account_data[8:16], byteorder='little')
                vaults.append({
                    "pubkey": account["pubkey"],
                    "vault_id": vault_id
                })
            except Exception as e:
                print(f"Error parsing account {account['pubkey']}: {e}")
        
        return vaults
    except Exception as e:
        print(f"Error querying program accounts: {e}")
        return []

def main():
    parser = argparse.ArgumentParser(description="Query Boring Vault balances")
    parser.add_argument("--rpc-url", default="https://solana-mainnet.g.alchemy.com/v2/", 
                        help="Solana RPC URL")
    parser.add_argument("--vault-id", type=int, help="Specific vault ID to query")
    parser.add_argument("--limit", type=int, default=1, help="Number of vaults to check (default: 1)")
    parser.add_argument("--start-index", type=int, default=0, help="Start checking from this index (default: 0)")
    
    args = parser.parse_args()
    
    # Append API key to RPC URL if using Alchemy
    if "alchemy.com" in args.rpc_url and not args.rpc_url.endswith(os.getenv("ALCHEMY_API_KEY", "")):
        args.rpc_url = args.rpc_url.rstrip("/") + "/" + os.getenv("ALCHEMY_API_KEY", "")
    
    print(f"\nQuerying Boring Vault program ({BORING_VAULT_SVM})...")
    vault_accounts = get_vault_info(BORING_VAULT_SVM, args.rpc_url)
    print(f"Found {len(vault_accounts)} vault accounts")
    
    if args.vault_id:
        # Filter to specific vault ID if provided
        vault_accounts = [v for v in vault_accounts if v["vault_id"] == args.vault_id]
        print(f"Filtered to {len(vault_accounts)} vault accounts with ID {args.vault_id}")
    
    # Apply start index and limit
    start = min(args.start_index, len(vault_accounts))
    end = min(start + args.limit, len(vault_accounts))
    vault_accounts = vault_accounts[start:end]
    
    print(f"\nChecking vaults {start} to {end-1}:")
    for vault in vault_accounts:
        print(f"\nVault ID: {vault['vault_id']}")
        print(f"Vault Address: {vault['pubkey']}")
        try:
            balances = sum_vault_balances(args.rpc_url)
            print(f"SOL: {balances.sol} lamports")
            print(f"JitoSOL: {balances.jitosol} base units")
            print(f"wSOL: {balances.wsol} base units")
        except Exception as e:
            print(f"Error getting balances: {e}")

if __name__ == "__main__":
    main() 