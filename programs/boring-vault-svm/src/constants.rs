use anchor_lang::prelude::*;

pub const NATIVE: Pubkey = Pubkey::new_from_array([0; 32]);
pub const NATIVE_DECIMALS: u8 = 9;
pub const BPS_SCALE: u16 = 10000;
pub const BPS_DECIMALS: u8 = 4;
pub const MAXIMUM_ALLOWED_EXCHANGE_RATE_CHANGE_UPPER_BOUND: u16 = 12000; // 20%
pub const MAXIMUM_ALLOWED_EXCHANGE_RATE_CHANGE_LOWER_BOUND: u16 = 8000; // -20%
pub const MAXIMUM_PLATFORM_FEE_BPS: u16 = 2000; // 20%
pub const MAXIMUM_PERFORMANCE_FEE_BPS: u16 = 5000; // 50%

/// Base seeds for the boring vault
pub const BASE_SEED_CONFIG: &[u8] = b"config";
pub const BASE_SEED_BORING_VAULT_STATE: &[u8] = b"boring-vault-state";
pub const BASE_SEED_BORING_VAULT: &[u8] = b"boring-vault";
pub const BASE_SEED_SHARE_TOKEN: &[u8] = b"share-token";
pub const BASE_SEED_ASSET_DATA: &[u8] = b"asset-data";
pub const BASE_SEED_CPI_DIGEST: &[u8] = b"cpi-digest";
