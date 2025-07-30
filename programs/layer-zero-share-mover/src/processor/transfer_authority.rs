use crate::{constants::SHARE_MOVER_SEED, error::BoringErrorCode, state::share_mover::ShareMover};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(
        constraint = signer.key() == share_mover.admin @ BoringErrorCode::NotAuthorized
    )]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [SHARE_MOVER_SEED, share_mover.mint.as_ref()],
        bump,
    )]
    pub share_mover: Account<'info, ShareMover>,
}

pub fn transfer_authority(ctx: Context<TransferAuthority>, new_admin: Pubkey) -> Result<()> {
    require!(
        new_admin != Pubkey::default(),
        BoringErrorCode::InvalidNewAdmin
    );
    ctx.accounts.share_mover.pending_admin = new_admin;
    Ok(())
}
