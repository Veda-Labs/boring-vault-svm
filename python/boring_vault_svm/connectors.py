import borsh_construct as borsh
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import AccountMeta, Instruction
from solders.transaction import VersionedTransaction 
from solders.message import MessageV0
from solders.hash import Hash
from solders.signature import Signature
from solana.rpc.api import Client

# Instruction discriminators
SET_DEPOSIT_SUB_ACCOUNT_DISCRIMINATOR = bytes([
    135,
    238,
    218,
    4,
    120,
    77,
    207,
    156
])
SET_WITHDRAW_SUB_ACCOUNT_DISCRIMINATOR = bytes([
    152,
    197,
    103,
    249,
    56,
    180,
    0,
    172
])

args_struct = borsh.CStruct(
    "vault_id" / borsh.U64,
    "new_sub_account" / borsh.U8
)

BASE_SEED_BORING_VAULT_STATE = b"boring-vault-state"

def set_deposit_sub_account(
    client: Client,
    program_id: Pubkey,
    vault_id: int,
    new_sub_account: int,
    authority: Keypair
) -> Signature:
    """Constructs and sends the set_deposit_sub_account transaction using VersionedTransaction."""

    vault_state_pda, _ = Pubkey.find_program_address(
        [BASE_SEED_BORING_VAULT_STATE, vault_id.to_bytes(8, 'little')],
        program_id
    )

    encoded_args = args_struct.build({
        'vault_id': vault_id,
        'new_sub_account': new_sub_account
    })
    instruction_data = SET_DEPOSIT_SUB_ACCOUNT_DISCRIMINATOR + encoded_args

    accounts = [
        AccountMeta(pubkey=authority.pubkey(), is_signer=True, is_writable=False),
        AccountMeta(pubkey=vault_state_pda, is_signer=False, is_writable=True)
    ]

    instruction = Instruction(
        program_id=program_id,
        data=instruction_data,
        accounts=accounts
    )

    latest_blockhash_resp = client.get_latest_blockhash()
    recent_blockhash = latest_blockhash_resp.value.blockhash
    
    message = MessageV0.try_compile(
        payer=authority.pubkey(),
        instructions=[instruction],
        address_lookup_table_accounts=[],
        recent_blockhash=recent_blockhash,
    )

    transaction = VersionedTransaction(message, [authority])
    result = client.send_transaction(transaction)

    return result.value

def set_withdraw_sub_account(
    client: Client,
    program_id: Pubkey,
    vault_id: int,
    new_sub_account: int,
    authority: Keypair
) -> Signature:
    """Constructs and sends the set_withdraw_sub_account transaction using VersionedTransaction."""

    vault_state_pda, _ = Pubkey.find_program_address(
        [BASE_SEED_BORING_VAULT_STATE, vault_id.to_bytes(8, 'little')],
        program_id
    )

    encoded_args = args_struct.build({
        'vault_id': vault_id,
        'new_sub_account': new_sub_account
    })
    instruction_data = SET_WITHDRAW_SUB_ACCOUNT_DISCRIMINATOR + encoded_args

    accounts = [
        AccountMeta(pubkey=authority.pubkey(), is_signer=True, is_writable=False),
        AccountMeta(pubkey=vault_state_pda, is_signer=False, is_writable=True)
    ]

    instruction = Instruction(
        program_id=program_id,
        data=instruction_data,
        accounts=accounts
    )

    latest_blockhash_resp = client.get_latest_blockhash()
    recent_blockhash = latest_blockhash_resp.value.blockhash

    message = MessageV0.try_compile(
        payer=authority.pubkey(),
        instructions=[instruction],
        address_lookup_table_accounts=[],
        recent_blockhash=recent_blockhash,
    )

    transaction = VersionedTransaction(message, [authority])
    result = client.send_transaction(transaction)

    return result.value 