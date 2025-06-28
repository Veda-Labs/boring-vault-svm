use crate::{error::BoringErrorCode, seed::SHARE_MOVER_SEED, state::ShareMover};
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
        bump = share_mover.bump,
    )]
    pub share_mover: Account<'info, ShareMover>,
}

pub fn transfer_authority(ctx: Context<TransferAuthority>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.share_mover.admin = new_admin;
    msg!("ShareMover admin updated to: {}", new_admin);
    Ok(())
}
