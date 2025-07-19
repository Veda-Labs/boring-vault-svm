use crate::{error::BoringErrorCode, seed::SHARE_MOVER_SEED, state::share_mover::ShareMover};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetEndpointProgram<'info> {
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

pub fn set_endpoint_program(ctx: Context<SetEndpointProgram>, endpoint: Pubkey) -> Result<()> {
    ctx.accounts.share_mover.endpoint_program = endpoint;
    Ok(())
}
