use anchor_lang::{prelude::Pubkey, pubkey};

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/solana/programs/programs/endpoint/src/lib.rs#L18
pub const L0_ENDPOINT_PROGRAM_ID: Pubkey = pubkey!("76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6");

pub const PROGRAM_CONFIG_SEED: &[u8] = b"config";
pub const SHARE_MOVER_SEED: &[u8] = b"share_mover";
// The Executor relies on this exact seed to derive the LzReceiveTypes PDA.
pub const PEER_SEED: &[u8] = b"Peer";
// https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/solana/programs/programs/endpoint/src/lib.rs#L21
pub const NONCE_SEED: &[u8] = b"Nonce";
pub const OAPP_SEED: &[u8] = b"OApp";
pub const PAYLOAD_HASH_SEED: &[u8] = b"PayloadHash";
pub const ENDPOINT_SEED: &[u8] = b"Endpoint";
// https://github.com/LayerZero-Labs/LayerZero-v2/blob/88428755be6caa71cb1d2926141d73c8989296b5/packages/layerzero-v2/solana/programs/libs/oapp/src/endpoint_cpi.rs#L16
pub const EVENT_SEED: &[u8] = b"__event_authority";
// https://github.com/LayerZero-Labs/LayerZero-v2/blob/88428755be6caa71cb1d2926141d73c8989296b5/packages/layerzero-v2/solana/programs/libs/oapp/src/lib.rs#L8
// The Executor relies on this exact seed to derive the LzReceiveTypes PDA.
pub const LZ_RECEIVE_TYPES_SEED: &[u8] = b"LzReceiveTypes";
