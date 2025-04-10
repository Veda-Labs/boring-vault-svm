use anchor_lang::prelude::*;

#[error_code]
pub enum QueueErrorCode {
    #[msg("Not authorized")]
    NotAuthorized,
    #[msg("Queue paused")]
    QueuePaused,
    #[msg("Withdraws not allowed for asset")]
    WithdrawsNotAllowedForAsset,
    #[msg("Invalid discount")]
    InvalidDiscount,
    #[msg("Invalid share amount")]
    InvalidShareAmount,
    #[msg("Invalid seconds to deadline")]
    InvalidSecondsToDeadline,
    #[msg("Invalid boring vault program")]
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
    #[msg("Decimal conversion failed")]
    DecimalConversionFailed,
    #[msg("Request deadline not passed")]
    RequestDeadlineNotPassed,
    #[msg("Maximum maturity exceeded")]
    MaximumMaturityExceeded,
    #[msg("Maximum deadline exceeded")]
    MaximumDeadlineExceeded,
    #[msg("Maximum discount exceeded")]
    MaximumDiscountExceeded,
    #[msg("Invalid associated token account")]
    InvalidAssociatedTokenAccount,
    #[msg("Math error")]
    MathError,
}
