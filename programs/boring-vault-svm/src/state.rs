use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

#[account]
pub struct ProgramConfig {
    pub authority: Pubkey,
    pub vault_count: u64,
    pub bump: u8,
}

#[account]
pub struct BoringVault {
    // Architecture Config
    pub vault_id: u64,
    pub authority: Pubkey,
    pub paused: bool,
    pub initialized: bool,
    // Token info
    pub share_mint: Pubkey,

    // Teller Info
    pub base_asset: Pubkey,
    pub exchange_rate: u64,
    pub exchange_rate_high_water_mark: u64,
    pub total_shares_last_update: u64,
    pub last_update_timestamp: u32,
    pub payout_address: Pubkey,
    pub allowed_exchange_rate_change_upper_bound: u64,
    pub allowed_exchange_rate_change_lower_bound: u64,
    pub allowed_exchange_rate_change_upper_bound_timestamp: u16,
    pub minimum_update_delay_in_seconds: u16,
    pub platform_fee_bps: u16,
    pub performance_fee_bps: u16,

    // Manager Info
    pub strategist: Pubkey,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<ProgramConfig>(),
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DeployArgs {
    pub authority: Pubkey,
    pub strategist: Pubkey,
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
}

#[derive(Accounts)]
#[instruction(args: DeployArgs)]
pub struct Deploy<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<BoringVault>(),
        seeds = [b"boring-vault", config.key().as_ref(), &config.vault_count.to_le_bytes()[..]],
        bump,
    )]
    pub boring_vault: Account<'info, BoringVault>,

    /// The mint of the share token.
    #[account(
        init,
        payer = signer,
        mint::decimals = args.decimals,
        mint::authority = boring_vault.key(),
        seeds = [b"share-token", boring_vault.key().as_ref()],
        bump,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

// =============================== Deposit ===============================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum DepositAsset {
    Sol,
    JitoSol,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DepositArgs {
    pub vault_id: u64,
    pub asset: DepositAsset,
    pub deposit_amount: u64,
    pub min_mint_amount: u64,
}

#[derive(Accounts)]
#[instruction(args: DepositArgs)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    pub config: Account<'info, ProgramConfig>,

    #[account(
        mut,
        seeds = [b"boring-vault", config.key().as_ref(), &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    pub boring_vault: Account<'info, BoringVault>,

    /// The vault's share mint
    #[account(
            mut,
            seeds = [b"share-token", boring_vault.key().as_ref()],
            bump
        )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    /// The user's share token account
    #[account(mut)]
    pub user_shares: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,

    /// User's JitoSOL account
    #[account(mut)]
    pub user_jito_sol: Option<InterfaceAccount<'info, TokenAccount>>,

    /// Vault's JitoSOL account
    #[account(mut)]
    pub vault_jito_sol: Option<InterfaceAccount<'info, TokenAccount>>,

    /// JitoSOL mint
    pub jito_sol_mint: Option<InterfaceAccount<'info, Mint>>,
}
