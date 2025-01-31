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
}
