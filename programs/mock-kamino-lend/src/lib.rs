#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use derivative::Derivative;
declare_id!("GE6jWNZWUQBkAppiqkdZeewFtr5Hmi6CwcsRHQb98CNR");

#[program]
pub mod mock_kamino_lend {
    use super::*;

    pub fn init_user_metadata(
        ctx: Context<InitUserMetadata>,
        user_lookup_table: Pubkey,
    ) -> Result<()> {
        // Implementation here
        // This would create the user metadata account with the same structure as Kamino's
        msg!("owner: {:?}", ctx.accounts.owner.key());
        msg!("user_lookup_table: {:?}", user_lookup_table);
        Ok(())
    }
}

#[derive(PartialEq, Derivative)]
#[derivative(Debug)]
#[account(zero_copy)]
#[repr(C)]
pub struct UserMetadata {
    pub referrer: Pubkey,
    pub bump: u64,
    pub user_lookup_table: Pubkey,
    pub owner: Pubkey,

    #[derivative(Debug = "ignore")]
    pub padding_1: [u64; 64],
    #[derivative(Debug = "ignore")]
    pub padding_2: [u64; 64],
}

impl Default for UserMetadata {
    fn default() -> Self {
        Self {
            referrer: Pubkey::default(),
            bump: 0,
            user_lookup_table: Pubkey::default(),
            owner: Pubkey::default(),
            padding_1: [0; 64],
            padding_2: [0; 64],
        }
    }
}

#[derive(Accounts)]
pub struct InitUserMetadata<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,

    #[account(init,
        seeds = [b"user_meta", owner.key().as_ref()],
        bump,
        payer = fee_payer,
        space = 1024 + 8,
    )]
    /// CHECK: test
    pub user_metadata: AccountLoader<'info, UserMetadata>,
    /// CHECK: test
    pub referrer_user_metadata: Option<AccountLoader<'info, UserMetadata>>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}
