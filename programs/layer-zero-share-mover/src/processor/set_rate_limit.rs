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
    outbound_window: u64,
    inbound_limit: u64,
    inbound_window: u64,
) -> Result<()> {
    let share_mover = &mut ctx.accounts.share_mover;
    let clock = Clock::get()?;

    // First checkpoint the existing rate limits (consume 0 to update decay)
    let _ = share_mover
        .outbound_rate_limit
        .check_and_consume(0, clock.unix_timestamp);
    let _ = share_mover
        .inbound_rate_limit
        .check_and_consume(0, clock.unix_timestamp);

    // Update the limits and windows
    // Note: This doesn't reset amount_in_flight or last_updated, matching EVM behavior
    share_mover.outbound_rate_limit.limit = outbound_limit;
    share_mover.outbound_rate_limit.window = outbound_window;

    share_mover.inbound_rate_limit.limit = inbound_limit;
    share_mover.inbound_rate_limit.window = inbound_window;

    msg!(
        "Rate limits updated - Outbound: {}/{} seconds, Inbound: {}/{} seconds",
        outbound_limit,
        outbound_window,
        inbound_limit,
        inbound_window
    );
    Ok(())
}
