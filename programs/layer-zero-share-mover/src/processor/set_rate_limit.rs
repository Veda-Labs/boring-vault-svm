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
    let ts = Clock::get()?.unix_timestamp;

    // carry over decayed in-flight amounts
    let (out_in_flight, _) = share_mover.outbound_rate_limit.calculate_available(ts)?;
    share_mover.outbound_rate_limit = RateLimitState {
        amount_in_flight: out_in_flight,
        ..RateLimitState::new(outbound_limit, outbound_window, ts)?
    };

    let (in_in_flight, _) = share_mover.inbound_rate_limit.calculate_available(ts)?;
    share_mover.inbound_rate_limit = RateLimitState {
        amount_in_flight: in_in_flight,
        ..RateLimitState::new(inbound_limit, inbound_window, ts)?
    };

    Ok(())
}
