use anchor_lang::prelude::{Pubkey, *};

use crate::{
    seed::{ENDPOINT_SEED, EVENT_SEED, NONCE_SEED, OAPP_SEED, PAYLOAD_HASH_SEED},
    state::LzAccount,
};

pub fn get_accounts_for_clear(
    endpoint_program: Pubkey,
    receiver: &Pubkey,
    src_eid: u32,
    sender: &[u8; 32],
    nonce: u64,
) -> Vec<LzAccount> {
    let (nonce_account, _) = Pubkey::find_program_address(
        &[
            NONCE_SEED,
            &receiver.to_bytes(),
            &src_eid.to_be_bytes(),
            sender,
        ],
        &endpoint_program,
    );

    let (payload_hash_account, _) = Pubkey::find_program_address(
        &[
            PAYLOAD_HASH_SEED,
            &receiver.to_bytes(),
            &src_eid.to_be_bytes(),
            sender,
            &nonce.to_be_bytes(),
        ],
        &endpoint_program,
    );

    let (oapp_registry_account, _) =
        Pubkey::find_program_address(&[OAPP_SEED, &receiver.to_bytes()], &endpoint_program);
    let (event_authority_account, _) =
        Pubkey::find_program_address(&[EVENT_SEED], &endpoint_program);
    let (endpoint_settings_account, _) =
        Pubkey::find_program_address(&[ENDPOINT_SEED], &endpoint_program);

    vec![
        LzAccount {
            pubkey: endpoint_program,
            is_signer: false,
            is_writable: false,
        },
        LzAccount {
            pubkey: *receiver,
            is_signer: false,
            is_writable: false,
        },
        LzAccount {
            pubkey: oapp_registry_account,
            is_signer: false,
            is_writable: false,
        },
        LzAccount {
            pubkey: nonce_account,
            is_signer: false,
            is_writable: true,
        },
        LzAccount {
            pubkey: payload_hash_account,
            is_signer: false,
            is_writable: true,
        },
        LzAccount {
            pubkey: endpoint_settings_account,
            is_signer: false,
            is_writable: true,
        },
        LzAccount {
            pubkey: event_authority_account,
            is_signer: false,
            is_writable: false,
        },
        LzAccount {
            pubkey: endpoint_program,
            is_signer: false,
            is_writable: false,
        },
    ]
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LzReceiveParams {
    pub src_eid: u32,
    pub sender: [u8; 32],
    pub nonce: u64,
    pub guid: [u8; 32],
    pub message: Vec<u8>,
    pub extra_data: Vec<u8>,
}

// https://github.com/LayerZero-Labs/devtools/blob/main/examples/oapp-solana/programs/my_oapp/src/state/peer_config.rs#L7
#[account]
pub struct PeerConfig {
    pub peer_address: [u8; 32],
    pub enforced_options: EnforcedOptions,
    pub bump: u8,
}

pub const ENFORCED_OPTIONS_SEND_MAX_LEN: usize = 512;
pub const ENFORCED_OPTIONS_SEND_AND_CALL_MAX_LEN: usize = 1024;

#[derive(Clone, Default, AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct EnforcedOptions {
    #[max_len(ENFORCED_OPTIONS_SEND_MAX_LEN)]
    pub send: Vec<u8>,
    #[max_len(ENFORCED_OPTIONS_SEND_AND_CALL_MAX_LEN)]
    pub send_and_call: Vec<u8>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct ClearParams {
    pub receiver: Pubkey,
    pub src_eid: u32,
    pub sender: [u8; 32],
    pub nonce: u64,
    pub guid: [u8; 32],
    pub message: Vec<u8>,
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

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/88428755be6caa71cb1d2926141d73c8989296b5/packages/layerzero-v2/solana/programs/programs/messagelib-interface/src/lib.rs#L73
#[derive(Clone, AnchorSerialize, AnchorDeserialize, Default)]
pub struct MessagingFee {
    pub native_fee: u64,
    pub lz_token_fee: u64,
}

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/88428755be6caa71cb1d2926141d73c8989296b5/packages/layerzero-v2/solana/programs/programs/endpoint/src/instructions/oapp/quote.rs#L109
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct QuoteParams {
    pub sender: Pubkey,
    pub dst_eid: u32,
    pub receiver: [u8; 32],
    pub message: Vec<u8>,
    pub options: Vec<u8>,
    pub pay_in_lz_token: bool,
}

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/88428755be6caa71cb1d2926141d73c8989296b5/packages/layerzero-v2/solana/programs/programs/endpoint/src/instructions/oapp/send.rs#L183
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendParams {
    pub dst_eid: u32,
    pub receiver: [u8; 32],
    pub message: Vec<u8>,
    pub options: Vec<u8>,
    pub native_fee: u64,
    pub lz_token_fee: u64,
}

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/88428755be6caa71cb1d2926141d73c8989296b5/packages/layerzero-v2/solana/programs/programs/endpoint/src/state/message_lib.rs#L17
/// the reason for not using Option::None to indicate default is to respect the spec on evm
#[account]
#[derive(InitSpace)]
pub struct SendLibraryConfig {
    pub message_lib: Pubkey,
    pub bump: u8,
}

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/solana/programs/programs/endpoint/src/state/messaging_channel.rs#L10
#[account]
#[derive(InitSpace)]
pub struct Nonce {
    pub bump: u8,
    pub outbound_nonce: u64,
    pub inbound_nonce: u64,
}

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/solana/programs/programs/endpoint/src/state/endpoint.rs#L16
#[account]
#[derive(InitSpace)]
pub struct OAppRegistry {
    pub delegate: Pubkey,
    pub bump: u8,
}
