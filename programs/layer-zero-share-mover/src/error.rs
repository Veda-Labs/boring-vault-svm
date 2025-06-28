use anchor_lang::prelude::*;

#[error_code]
pub enum ShareBridgeCodecError {
    #[msg("Buffer too short for message")]
    InvalidLength,
    #[msg("Message version not supported")]
    UnsupportedVersion,
    #[msg("Amount exceeds u128 maximum")]
    AmountTooLarge,
    #[msg("Invalid message")]
    InvalidMessage,
    #[msg("Invalid EVM recipient address")]
    InvalidEVMRecipientAddress,
}

#[error_code]
pub enum BoringErrorCode {
    #[msg("Invalid share mint")]
    InvalidShareMint,
    #[msg("Invalid associated token account")]
    InvalidAssociatedTokenAccount,
    #[msg("Vault paused")]
    ShareMoverPaused,
    #[msg("Not authorized")]
    NotAuthorized,
    #[msg("Math error")]
    MathError,
    #[msg("Invalid authority")]
    InvalidAuthority,
    #[msg("Decimal conversion failed")]
    DecimalConversionFailed,
    #[msg("Invalid endpoint program")]
    InvalidEndpointProgram,
    #[msg("Invalid message")]
    InvalidMessage,
    #[msg("Invalid bridge program")]
    InvalidBridgeProgram,
    #[msg("Invalid vault")]
    InvalidVault,
    #[msg("Vault paused")]
    VaultPaused,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Invalid share mover")]
    InvalidShareMover,
    #[msg("Invalid peer")]
    InvalidPeer,
    #[msg("Invalid message amount")]
    InvalidMessageAmount,
    #[msg("Invalid message recipient")]
    InvalidMessageRecipient,
    #[msg("Invalid message extra accounts")]
    InvalidMessageExtraAccounts,
    #[msg("Invalid bridge authority")]
    InvalidBridgeAuthority,
    #[msg("Send amount conversion failed")]
    SendAmountConversionFailed,
    #[msg("Rate limit exceeded")]
    RateLimitExceeded,
    #[msg("Overflow")]
    Overflow,
    #[msg("Invalid EVM recipient address")]
    InvalidEVMRecipientAddress,
    #[msg("Invalid peer chain")]
    InvalidPeerChain,
}
