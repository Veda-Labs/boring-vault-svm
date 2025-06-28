use crate::{error::BoringErrorCode, seed::SHARE_MOVER_SEED, state::ShareMover};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetPeerDecimals<'info> {
    #[account(
        constraint = signer.key() == share_mover.admin @ BoringErrorCode::NotAuthorized
    )]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [SHARE_MOVER_SEED, share_mover.mint.as_ref()],
        bump = share_mover.bump,
    )]
    pub share_mover: Account<'info, ShareMover>,
}

pub fn set_peer_decimals(ctx: Context<SetPeerDecimals>, new_decimals: u8) -> Result<()> {
    ctx.accounts.share_mover.peer_decimals = new_decimals;
    msg!("ShareMover peer decimals updated to: {}", new_decimals);
    Ok(())
}
