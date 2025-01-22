use anchor_lang::prelude::*;

#[account]
pub struct ProgramConfig {
    pub authority: Pubkey,
    pub vault_count: u64,
    pub bump: u8,
}

#[account]
pub struct BoringVault {
    pub config: VaultConfig,
    pub teller: TellerConfig,
    pub manager: ManagerConfig,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct VaultConfig {
    pub vault_id: u64,
    pub authority: Pubkey,
    pub paused: bool,
    pub initialized: bool,
    pub share_mint: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TellerConfig {
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
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ManagerConfig {
    pub strategist: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DeployArgs {
    pub authority: Pubkey,
    pub strategist: Pubkey,
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
}

// =============================== Deposit ===============================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct UpdateAssetDataArgs {
    pub vault_id: u64,
    pub asset_data: AssetData,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DepositArgs {
    pub vault_id: u64,
    pub deposit_amount: u64,
    pub min_mint_amount: u64,
}

#[account]
#[derive(Debug)]
pub struct AssetData {
    pub decimals: u8,
    pub allow_deposits: bool,
    pub allow_withdrawals: bool,
    pub share_premium_bps: u16,
    pub price_feed: Pubkey,
    pub inverse_price_feed: bool,
}
