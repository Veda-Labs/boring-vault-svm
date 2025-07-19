use anchor_lang::prelude::Pubkey;
use boring_vault_svm::BASE_SEED_BORING_VAULT;

pub fn get_vault(vault_id: u64, sub_account: u8, program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            BASE_SEED_BORING_VAULT,
            &vault_id.to_le_bytes()[..],
            &[sub_account],
        ],
        program_id,
    )
    .0
}
