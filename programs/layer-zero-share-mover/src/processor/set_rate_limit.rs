use crate::{constants::SHARE_MOVER_SEED, error::BoringErrorCode, state::share_mover::ShareMover};
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

    // checkpoint the existing rate limits (consume 0 to update decay)
    let _ = share_mover
        .outbound_rate_limit
        .check_and_consume(0, clock.unix_timestamp);
    let _ = share_mover
        .inbound_rate_limit
        .check_and_consume(0, clock.unix_timestamp);

    share_mover.outbound_rate_limit.limit = outbound_limit;
    share_mover.outbound_rate_limit.window = outbound_window;

    share_mover.inbound_rate_limit.limit = inbound_limit;
    share_mover.inbound_rate_limit.window = inbound_window;

    Ok(())
}
