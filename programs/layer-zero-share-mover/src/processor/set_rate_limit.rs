use crate::{constants::SHARE_MOVER_SEED, error::BoringErrorCode, state::share_mover::ShareMover};
use anchor_lang::prelude::*;
use common::rate_limit::RateLimitState;

#[derive(Accounts)]
pub struct SetRateLimit<'info> {
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

pub fn set_rate_limit(
    ctx: Context<SetRateLimit>,
    outbound_limit: u64,
    outbound_window: u64,
    inbound_limit: u64,
    inbound_window: u64,
) -> Result<()> {
    let share_mover = &mut ctx.accounts.share_mover;
    let clock = Clock::get()?;

    share_mover.outbound_rate_limit =
        RateLimitState::new(outbound_limit, outbound_window, clock.unix_timestamp)?;
    share_mover.inbound_rate_limit =
        RateLimitState::new(inbound_limit, inbound_window, clock.unix_timestamp)?;

    Ok(())
}
