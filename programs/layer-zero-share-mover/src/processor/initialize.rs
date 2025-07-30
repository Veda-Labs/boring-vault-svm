use anchor_lang::prelude::*;
use std::mem::size_of;

use crate::{constants::PROGRAM_CONFIG_SEED, state::share_mover::ProgramConfig};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(address = crate::ID)]
    pub program: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = 8 + size_of::<ProgramConfig>(),
        seeds = [PROGRAM_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, ProgramConfig>,

    pub system_program: Program<'info, System>,
}

pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
    ctx.accounts.config.authority = authority;

    Ok(())
}
