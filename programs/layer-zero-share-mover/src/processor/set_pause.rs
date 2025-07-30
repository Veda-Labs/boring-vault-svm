use crate::{constants::SHARE_MOVER_SEED, error::BoringErrorCode, state::share_mover::ShareMover};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetPause<'info> {
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

pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
    ctx.accounts.share_mover.is_paused = paused;
    Ok(())
}
