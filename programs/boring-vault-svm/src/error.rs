use anchor_lang::prelude::*;

#[error_code]
pub enum BoringErrorCode {
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Invalid share mint")]
    InvalidShareMint,
    #[msg("Asset not allowed")]
    AssetNotAllowed,
    #[msg("Invalid associated token account")]
    InvalidAssociatedTokenAccount,
    #[msg("Vault paused")]
    VaultPaused,
    #[msg("Invalid price feed")]
    InvalidPriceFeed,
    #[msg("Not authorized")]
    NotAuthorized,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid CPI digest")]
    InvalidCpiDigest,
    #[msg("Invalid Account")]
    InvalidAccounts,
    #[msg("Invalid Token Program")]
    InvalidTokenProgram,
    #[msg("Invalid Token Account")]
    InvalidTokenAccount,
}
