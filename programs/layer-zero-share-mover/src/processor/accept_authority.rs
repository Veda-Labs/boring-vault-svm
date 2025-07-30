use crate::{constants::SHARE_MOVER_SEED, error::BoringErrorCode, state::share_mover::ShareMover};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        constraint = signer.key() == share_mover.pending_admin @ BoringErrorCode::NotAuthorized
    )]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [SHARE_MOVER_SEED, share_mover.mint.as_ref()],
        bump,
    )]
    pub share_mover: Account<'info, ShareMover>,
}

pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
    // Move pending admin to admin and clear pending_admin
    ctx.accounts.share_mover.admin = ctx.accounts.signer.key();
    ctx.accounts.share_mover.pending_admin = Pubkey::default();

    Ok(())
}
