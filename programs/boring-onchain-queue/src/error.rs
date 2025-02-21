use anchor_lang::prelude::*;

#[error_code]
pub enum QueueErrorCode {
    #[msg("Not Authorized")]
    NotAuthorized,
    #[msg("Queue Paused")]
    QueuePaused,
    #[msg("Withdraws Not Allowed For Asset")]
    WithdrawsNotAllowedForAsset,
    #[msg("Invalid Discount")]
    InvalidDiscount,
    #[msg("Invalid Share Amount")]
    InvalidShareAmount,
    #[msg("Invalid Seconds To Deadline")]
    InvalidSecondsToDeadline,
    #[msg("Invalid Boring Vault Program")]
    InvalidBoringVaultProgram,
    #[msg("Request not mature")]
    RequestNotMature,
    #[msg("Request deadline passed")]
    RequestDeadlinePassed,
    #[msg("Invalid withdraw mint")]
    InvalidWithdrawMint,
    #[msg("Invalid token program")]
    InvalidTokenProgram,
    #[msg("Invalid share mint")]
    InvalidShareMint,
    #[msg("Invalid token account")]
    InvalidTokenAccount,
    #[msg("Decimal conversion failed")]
    DecimalConversionFailed,
    #[msg("Request deadline not passed")]
    RequestDeadlineNotPassed,
    #[msg("Maximum maturity exceeded")]
    MaximumMaturityExceeded,
    #[msg("Maximum deadline exceeded")]
    MaximumDeadlineExceeded,
}
