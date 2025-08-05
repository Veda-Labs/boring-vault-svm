use anchor_lang::error_code;

#[error_code]
pub enum MathError {
    #[msg("Overflow")]
    Overflow,
}

#[error_code]
pub enum RateLimitError {
    #[msg("Rate limit exceeded")]
    RateLimitExceeded,
    #[msg("Overflow")]
    Overflow,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Invalid window configuration")]
    InvalidWindow,
    #[msg("Timestamp moved backwards")]
    InvalidTimestamp,
}

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
    #[msg("Invalid Sui recipient address")]
    InvalidSuiRecipientAddress,
    #[msg("Invalid decimals")]
    InvalidDecimals,
    #[msg("Invalid recipient")]
    InvalidRecipient,
}
