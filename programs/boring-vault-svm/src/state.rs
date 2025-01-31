use crate::utils::*;
use anchor_lang::prelude::*;

#[account]
pub struct ProgramConfig {
    pub authority: Pubkey,
    pub vault_count: u64,
}

#[account]
pub struct BoringVault {
    pub config: VaultState,
    pub teller: TellerState,
    pub manager: ManagerState,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct VaultState {
    pub vault_id: u64,
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub paused: bool,
    pub initialized: bool,
    pub share_mint: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TellerState {
    pub base_asset: Pubkey,
    pub decimals: u8,
    pub exchange_rate_provider: Pubkey,
    pub exchange_rate: u64,
    pub exchange_rate_high_water_mark: u64,
    pub fees_owed_in_base_asset: u64,
    pub total_shares_last_update: u64,
    pub last_update_timestamp: u64,
    pub payout_address: Pubkey,
    pub allowed_exchange_rate_change_upper_bound: u16,
    pub allowed_exchange_rate_change_lower_bound: u16,
    pub minimum_update_delay_in_seconds: u32,
    pub platform_fee_bps: u16,
    pub performance_fee_bps: u16,
    pub withdraw_authority: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ManagerState {
    pub strategist: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DeployArgs {
    // Config
    pub authority: Pubkey,
    pub name: String,
    pub symbol: String,

    // Teller
    pub exchange_rate_provider: Pubkey, // Who can update the exchange rate
    pub exchange_rate: u64,
    pub payout_address: Pubkey,
    pub allowed_exchange_rate_change_upper_bound: u16,
    pub allowed_exchange_rate_change_lower_bound: u16,
    pub minimum_update_delay_in_seconds: u32,
    pub platform_fee_bps: u16,
    pub performance_fee_bps: u16,
    pub withdraw_authority: Pubkey,

    // Manager
    pub strategist: Pubkey,
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
    pub allow_deposits: bool,
    pub allow_withdrawals: bool,
    pub share_premium_bps: u16,
    pub is_pegged_to_base_asset: bool,
    pub price_feed: Pubkey,
    pub inverse_price_feed: bool,
}

// =============================== Withdraw =============================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct WithdrawArgs {
    pub vault_id: u64,
    pub share_amount: u64,
    pub min_assets_amount: u64,
}

// =============================== Manage ===============================

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct UpdateCpiDigestArgs {
    pub vault_id: u64,
    pub cpi_digest: [u8; 32],
    pub is_valid: bool,
}

// TODO this could probs use a ViewCpiDigestArgs struct to prevernt repetition
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ManageArgs {
    pub vault_id: u64,
    pub ix_program_id: Pubkey,
    pub ix_data: Vec<u8>,
    pub operators: Operators, // Could be stored in CpiDigest
    pub expected_size: u16,   // Could be stored in CpiDigest
}

#[account]
#[derive(Debug)]
pub struct CpiDigest {
    pub is_valid: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ViewCpiDigestReturn {
    pub digest: [u8; 32],
}
