pub const BPS_DECIMALS: u8 = 4;
pub const MAXIMUM_DEADLINE: u32 = 90 * 86400; // 90 days
pub const MAXIMUM_MATURITY: u32 = 90 * 86400; // 90 days
pub const MAXIMUM_DISCOUNT: u16 = 1_000; // 10%

pub const BASE_SEED_CONFIG: &[u8] = b"config";
pub const BASE_SEED_QUEUE_STATE: &[u8] = b"boring-queue-state";
pub const BASE_SEED_QUEUE: &[u8] = b"boring-queue";
pub const BASE_SEED_WITHDRAW_REQUEST: &[u8] = b"boring-queue-withdraw-request";
pub const BASE_SEED_WITHDRAW_ASSET_DATA: &[u8] = b"boring-queue-withdraw-asset-data";
pub const BASE_SEED_USER_WITHDRAW_STATE: &[u8] = b"boring-queue-user-withdraw-state";
