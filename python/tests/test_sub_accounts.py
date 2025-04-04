import pytest
import os
from pathlib import Path
import borsh_construct as borsh
from construct import Bytes as ConstructBytes

from solana.rpc.api import Client
from solders.pubkey import Pubkey
from solders.keypair import Keypair

from boring_vault_svm.connectors import (
    set_deposit_sub_account,
    set_withdraw_sub_account,
    BASE_SEED_BORING_VAULT_STATE
)

# --- Test Constants ---
PROGRAM_ID_STR = "5ZRnXG4GsUMLaN7w2DtJV1cgLgcXHmuHCmJ2MxoorWCE"
DEPLOYED_VAULT_ID = 1 # Vault ID created by setup script
DEFAULT_AUTHORITY_PATH = "~/.config/solana/id.json"
LOCAL_RPC_ENDPOINT = "http://127.0.0.1:8899"

# --- Borsh Schemas ---
boring_vault_flat_struct = borsh.CStruct(
    "config_vault_id" / borsh.U64,
    "config_authority" / ConstructBytes(32),
    "config_pending_authority" / ConstructBytes(32),
    "config_paused" / borsh.Bool,
    "config_share_mint" / ConstructBytes(32),
    "config_deposit_sub_account" / borsh.U8,
    "config_withdraw_sub_account" / borsh.U8,
    "teller_base_asset" / ConstructBytes(32),
    "teller_decimals" / borsh.U8,
    "teller_exchange_rate_provider" / ConstructBytes(32),
    "teller_exchange_rate" / borsh.U64,
    "teller_exchange_rate_high_water_mark" / borsh.U64,
    "teller_fees_owed_in_base_asset" / borsh.U64,
    "teller_total_shares_last_update" / borsh.U64,
    "teller_last_update_timestamp" / borsh.U64,
    "teller_payout_address" / ConstructBytes(32),
    "teller_allowed_exchange_rate_change_upper_bound" / borsh.U16,
    "teller_allowed_exchange_rate_change_lower_bound" / borsh.U16,
    "teller_minimum_update_delay_in_seconds" / borsh.U32,
    "teller_platform_fee_bps" / borsh.U16,
    "teller_performance_fee_bps" / borsh.U16,
    "teller_withdraw_authority" / ConstructBytes(32),
    "manager_strategist" / ConstructBytes(32)
)

# --- Pytest Fixtures ---

@pytest.fixture(scope="module")
def rpc_client() -> Client:
    return Client(LOCAL_RPC_ENDPOINT)

@pytest.fixture(scope="module")
def program_id() -> Pubkey:
    return Pubkey.from_string(PROGRAM_ID_STR)

@pytest.fixture(scope="module")
def authority_keypair() -> Keypair:
    keypair_path = Path(os.path.expanduser(DEFAULT_AUTHORITY_PATH))
    if not keypair_path.exists():
        raise FileNotFoundError(f"Authority keypair not found at {keypair_path}")
    return Keypair.from_json(keypair_path.read_text())

@pytest.fixture(scope="module")
def deployed_vault_id() -> int:
    return DEPLOYED_VAULT_ID

# --- Test Functions ---

def test_set_deposit_sub_account(rpc_client: Client, program_id: Pubkey, authority_keypair: Keypair, deployed_vault_id: int):
    """Tests setting the deposit sub account."""
    new_deposit_sub = 5

    print(f"\nSetting deposit sub-account for vault {deployed_vault_id} to {new_deposit_sub}...")
    tx_sig = set_deposit_sub_account(
        client=rpc_client,
        program_id=program_id,
        vault_id=deployed_vault_id,
        new_sub_account=new_deposit_sub,
        authority=authority_keypair
    )
    print(f"Transaction signature: {tx_sig}")
    rpc_client.confirm_transaction(tx_sig)
    print("Transaction confirmed.")

    vault_state_pda, _ = Pubkey.find_program_address(
        [BASE_SEED_BORING_VAULT_STATE, deployed_vault_id.to_bytes(8, 'little')],
        program_id
    )
    account_info = rpc_client.get_account_info(vault_state_pda)
    assert account_info.value is not None
    account_data = account_info.value.data[8:]
    decoded_data = boring_vault_flat_struct.parse(account_data)

    assert decoded_data.config_deposit_sub_account == new_deposit_sub
    print("Deposit sub-account verified.")

def test_set_withdraw_sub_account(rpc_client: Client, program_id: Pubkey, authority_keypair: Keypair, deployed_vault_id: int):
    """Tests setting the withdraw sub account."""
    new_withdraw_sub = 10

    print(f"\nSetting withdraw sub-account for vault {deployed_vault_id} to {new_withdraw_sub}...")
    tx_sig = set_withdraw_sub_account(
        client=rpc_client,
        program_id=program_id,
        vault_id=deployed_vault_id,
        new_sub_account=new_withdraw_sub,
        authority=authority_keypair
    )
    print(f"Transaction signature: {tx_sig}")
    rpc_client.confirm_transaction(tx_sig)
    print("Transaction confirmed.")

    # Verify the change
    vault_state_pda, _ = Pubkey.find_program_address(
        [BASE_SEED_BORING_VAULT_STATE, deployed_vault_id.to_bytes(8, 'little')],
        program_id
    )
    account_info = rpc_client.get_account_info(vault_state_pda)
    assert account_info.value is not None
    account_data = account_info.value.data[8:]
    decoded_data = boring_vault_flat_struct.parse(account_data)

    assert decoded_data.config_withdraw_sub_account == new_withdraw_sub
    print("Withdraw sub-account verified.") 