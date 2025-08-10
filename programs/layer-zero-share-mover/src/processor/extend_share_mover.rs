use crate::{
    constants::SHARE_MOVER_SEED,
    error::BoringErrorCode,
    state::share_mover::{OldShareMover, ShareMover},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ExtendShareMover<'info> {
    /// Admin signer paying for the reallocation
    #[account(mut)]
    pub signer: Signer<'info>,

    /// ShareMover PDA whose data will be grown by 32 bytes.
    /// Passed in unchecked because its current size is 32 bytes smaller than the
    /// Anchor-generated struct, so we cannot deserialize it until after we
    /// resize.
    #[account(mut, owner = crate::ID)]
    /// CHECK: This is the ShareMover account that will be extended.
    pub share_mover: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn extend_share_mover(ctx: Context<ExtendShareMover>, mint: Pubkey) -> Result<()> {
    msg!("Extending ShareMover account for mint: {}", mint);
    let expected_pda =
        Pubkey::find_program_address(&[SHARE_MOVER_SEED, mint.as_ref()], ctx.program_id).0;

    require_keys_eq!(
        expected_pda,
        ctx.accounts.share_mover.key(),
        BoringErrorCode::InvalidShareMover
    );

    // First, deserialize the OLD struct format before resizing
    let old_share_mover = {
        let account_data = ctx.accounts.share_mover.try_borrow_data()?;
        // Skip the 8-byte discriminator and deserialize the rest
        let mut data_slice = &account_data[8..];
        OldShareMover::deserialize(&mut data_slice)?
    };

    // Verify authority using old data
    require_keys_eq!(
        old_share_mover.admin,
        ctx.accounts.signer.key(),
        BoringErrorCode::NotAuthorized
    );

    // Now resize the account
    const DISCRIMINATOR_LEN: usize = 8;
    let target_len = DISCRIMINATOR_LEN + ShareMover::INIT_SPACE as usize;

    if ctx.accounts.share_mover.data_len() != target_len {
        ctx.accounts.share_mover.resize(target_len)?;
    }

    // Reconstruct the new ShareMover with migrated data
    let new_share_mover = ShareMover {
        admin: old_share_mover.admin,
        endpoint_program: old_share_mover.endpoint_program,
        // executor_program field removed - not copying it
        boring_vault_program: old_share_mover.boring_vault_program,
        vault: old_share_mover.vault,
        mint: old_share_mover.mint,
        is_paused: old_share_mover.is_paused,
        peer_decimals: old_share_mover.peer_decimals,
        bump: old_share_mover.bump,
        allow_from: old_share_mover.allow_from,
        allow_to: old_share_mover.allow_to,
        outbound_rate_limit: old_share_mover.outbound_rate_limit,
        inbound_rate_limit: old_share_mover.inbound_rate_limit,
        peer_chain: old_share_mover.peer_chain,
        pending_admin: Pubkey::default(), // New field - set to default or admin
    };

    // Serialize the new struct back to the account (including discriminator)
    let mut account_data = ctx.accounts.share_mover.try_borrow_mut_data()?;
    let mut cursor = std::io::Cursor::new(&mut account_data[..]);
    new_share_mover.try_serialize(&mut cursor)?;

    msg!("ShareMover account migrated successfully");

    Ok(())
}
