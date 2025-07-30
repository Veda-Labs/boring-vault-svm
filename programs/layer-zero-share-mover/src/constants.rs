// Seeds adopted from the upstream LayerZero-v2 Solana programs.
pub const PROGRAM_CONFIG_SEED: &[u8] = b"config";
pub const SHARE_MOVER_SEED: &[u8] = b"share_mover";
pub const PEER_SEED: &[u8] = b"Peer";
pub const NONCE_SEED: &[u8] = b"Nonce";
pub const OAPP_SEED: &[u8] = b"OApp";
pub const PAYLOAD_HASH_SEED: &[u8] = b"PayloadHash";
pub const ENDPOINT_SEED: &[u8] = b"Endpoint";
pub const LZ_RECEIVE_TYPES_SEED: &[u8] = b"LzReceiveTypes";
pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

// Discriminants for layerzero instructions
pub const OAPP_REGISTER_DISCRIMINATOR: [u8; 8] = [129, 89, 71, 68, 11, 82, 210, 125];
pub const CLEAR_DISCRIMINATOR: [u8; 8] = [250, 39, 28, 213, 123, 163, 133, 5];
pub const QUOTE_DISCRIMINATOR: [u8; 8] = [149, 42, 109, 247, 134, 146, 213, 123];
pub const SEND_DISCRIMINATOR: [u8; 8] = [102, 251, 20, 187, 65, 75, 12, 69];

// LayerZero send options constants
pub const ENFORCED_OPTIONS_SEND_MAX_LEN: usize = 512;
pub const ENFORCED_OPTIONS_SEND_AND_CALL_MAX_LEN: usize = 1024;

// Discriminants for boring-vault instructions
pub const MINT_SHARES_DISCRIMINATOR: [u8; 8] = [24, 196, 132, 0, 183, 158, 216, 142];
pub const BURN_SHARES_DISCRIMINATOR: [u8; 8] = [98, 168, 88, 31, 217, 221, 191, 214];
