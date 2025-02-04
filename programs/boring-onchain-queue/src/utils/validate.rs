use crate::error::QueueErrorCode;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;

pub fn validate_associated_token_accounts(
    token: &Pubkey,
    token_program: &Pubkey,
    user: &Pubkey,
    user_ata: &Pubkey,
) -> Result<()> {
    // Validate ATAs by checking against derived PDAs
    let expected_user_ata =
        get_associated_token_address_with_program_id(user, token, token_program);

    require!(
        user_ata == &expected_user_ata,
        QueueErrorCode::InvalidTokenAccount
    );

    Ok(())
}
