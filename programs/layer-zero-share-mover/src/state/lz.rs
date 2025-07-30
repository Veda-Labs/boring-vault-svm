use anchor_lang::prelude::*;

use crate::constants::{ENFORCED_OPTIONS_SEND_AND_CALL_MAX_LEN, ENFORCED_OPTIONS_SEND_MAX_LEN};

#[account]
#[derive(InitSpace)]
pub struct LzReceiveTypesAccounts {
    pub store: Pubkey,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LzAccount {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[account]
pub struct PeerConfig {
    pub peer_address: [u8; 32],
    pub enforced_options: EnforcedOptions,
    pub bump: u8,
}

#[derive(Clone, Default, AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct EnforcedOptions {
    #[max_len(ENFORCED_OPTIONS_SEND_MAX_LEN)]
    pub send: Vec<u8>,
    #[max_len(ENFORCED_OPTIONS_SEND_AND_CALL_MAX_LEN)]
    pub send_and_call: Vec<u8>,
}
// https://github.com/LayerZero-Labs/LayerZero-v2/blob/63bbd31584c588844de33678bf8dd61d879cba14/packages/layerzero-v2/solana/programs/programs/oft/src/state/enforced_options.rs#L16
impl EnforcedOptions {
    pub fn combine_options(
        &self,
        compose_msg: &Option<Vec<u8>>,
        extra_options: &[u8],
    ) -> Result<Vec<u8>> {
        let enforced_options = if compose_msg.is_none() {
            self.send.clone()
        } else {
            self.send_and_call.clone()
        };
        combine_options(enforced_options, extra_options)
    }
}

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/63bbd31584c588844de33678bf8dd61d879cba14/packages/layerzero-v2/solana/programs/libs/oapp/src/options.rs#L3
pub fn combine_options(mut enforced_options: Vec<u8>, extra_options: &[u8]) -> Result<Vec<u8>> {
    // No enforced options, pass whatever the caller supplied, even if it's empty or legacy type
    // 1/2 options.
    if enforced_options.is_empty() {
        return Ok(extra_options.to_vec());
    }

    // No caller options, return enforced
    if extra_options.is_empty() {
        return Ok(enforced_options);
    }

    // If caller provided extra_options, must be type 3 as it's the ONLY type that can be
    // combined.
    if extra_options.len() >= 2 {
        assert_type_3(extra_options)?;
        // Remove the first 2 bytes containing the type from the extra_options and combine with
        // enforced.
        enforced_options.extend_from_slice(&extra_options[2..]);
        return Ok(enforced_options);
    }

    // No valid set of options was found.
    Err(ErrorCode::InvalidOptions.into())
}

pub fn assert_type_3(options: &[u8]) -> Result<()> {
    let mut option_type_bytes = [0; 2];
    option_type_bytes.copy_from_slice(&options[0..2]);
    require!(
        u16::from_be_bytes(option_type_bytes) == 3,
        ErrorCode::InvalidOptions
    );
    Ok(())
}

#[error_code]
enum ErrorCode {
    InvalidOptions,
}

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/88428755be6caa71cb1d2926141d73c8989296b5/packages/layerzero-v2/solana/programs/programs/messagelib-interface/src/lib.rs#L73
#[derive(Clone, AnchorSerialize, AnchorDeserialize, Default)]
pub struct MessagingFee {
    pub native_fee: u64,
    pub lz_token_fee: u64,
}

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/88428755be6caa71cb1d2926141d73c8989296b5/packages/layerzero-v2/solana/programs/programs/endpoint/src/state/endpoint.rs#L5
#[account]
#[derive(InitSpace)]
pub struct EndpointSettings {
    // immutable
    pub eid: u32,
    pub bump: u8,
    // configurable
    pub admin: Pubkey,
    pub lz_token_mint: Option<Pubkey>,
}

// PARAMS

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LzReceiveParams {
    pub src_eid: u32,
    pub sender: [u8; 32],
    pub nonce: u64,
    pub guid: [u8; 32],
    pub message: Vec<u8>,
    pub extra_data: Vec<u8>,
}
