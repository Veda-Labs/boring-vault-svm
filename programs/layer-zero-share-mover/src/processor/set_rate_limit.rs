use crate::{error::BoringErrorCode, seed::SHARE_MOVER_SEED, state::share_mover::ShareMover};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetRateLimit<'info> {
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

pub fn set_rate_limit(
    ctx: Context<SetRateLimit>,
    outbound_limit: u64,
    outbound_capacity: u64,
    inbound_limit: u64,
    inbound_capacity: u64,
) -> Result<()> {
    let share_mover = &mut ctx.accounts.share_mover;

    share_mover.outbound_rate_limit.limit = outbound_limit;
    share_mover.outbound_rate_limit.capacity = outbound_capacity;
    share_mover.inbound_rate_limit.limit = inbound_limit;
    share_mover.inbound_rate_limit.capacity = inbound_capacity;

    msg!("Rate limits updated");
    Ok(())
}
