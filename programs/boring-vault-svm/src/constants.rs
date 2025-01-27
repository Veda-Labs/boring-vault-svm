use anchor_lang::prelude::*;

pub const NATIVE: Pubkey = Pubkey::new_from_array([0; 32]);
pub const NATIVE_DECIMALS: u8 = 9;

// TODO could store base seeds here like kamino-lend
// https://github.com/Kamino-Finance/klend/blob/master/programs/klend/src/utils/seeds.rs#L7
// pub const BASE_SEED_USER_METADATA: &[u8] = b"user_meta";
// pub const BASE_SEED_REFERRER_STATE: &[u8] = b"ref_state";
// pub const BASE_SEED_SHORT_URL: &[u8] = b"short_url";
