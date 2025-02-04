use anchor_lang::prelude::*;

#[account]
pub struct ProgramConfig {
    pub authority: Pubkey,
}

#[account]
pub struct QueueState {
    pub authority: Pubkey,
    pub boring_vault_program: Pubkey,
    pub vault_id: u64,
    pub share_mint: Pubkey,
    pub solve_authority: Pubkey,
    pub paused: bool,
}

#[account]
pub struct WithdrawAssetData {
    pub allow_withdrawals: bool,
    pub seconds_to_maturity: u32,
    pub minimum_seconds_to_deadline: u32,
    pub minimum_discount: u16,
    pub maximum_discount: u16,
    pub minimum_shares: u64,
}

// pda BASE_SEED_WITHDRAW_REQUEST + user.key() + last_nonce
#[account]
pub struct WithdrawRequest {
    pub vault_id: u64,
    pub asset_out: Pubkey,
    pub share_amount: u64,
    pub asset_amount: u64,
    pub creation_time: u64,
    pub seconds_to_maturity: u32,
    pub seconds_to_deadline: u32,
}

#[account]
pub struct UserWithdrawState {
    pub last_nonce: u64, // User specific nonce used to derive Withdraw Request
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DeployArgs {
    // Config
    pub authority: Pubkey,
    pub boring_vault_program: Pubkey,
    pub vault_id: u64,
    pub share_mint: Pubkey,
    pub solve_authority: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct UpdateWithdrawAssetArgs {
    pub vault_id: u64,
    pub seconds_to_maturity: u32,
    pub minimum_seconds_to_deadline: u32,
    pub minimum_discount: u16,
    pub maximum_discount: u16,
    pub minimum_shares: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RequestWithdrawArgs {
    pub vault_id: u64,
    pub share_amount: u64,
    pub discount: u16,
    pub seconds_to_deadline: u32,
}
