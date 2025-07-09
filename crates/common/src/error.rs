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
}
