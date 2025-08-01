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
    #[msg("Math error")]
    MathError,
    #[msg("Invalid CPI digest")]
    InvalidCpiDigest,
    #[msg("Invalid token program")]
    InvalidTokenProgram,
    #[msg("Invalid exchange rate provider")]
    InvalidExchangeRateProvider,
    #[msg("Invalid authority")]
    InvalidAuthority,
    #[msg("Invalid payout address")]
    InvalidPayoutAddress,
    #[msg("Invalid allowed exchange rate change upper bound")]
    InvalidAllowedExchangeRateChangeUpperBound,
    #[msg("Invalid allowed exchange rate change lower bound")]
    InvalidAllowedExchangeRateChangeLowerBound,
    #[msg("Invalid platform fee bps")]
    InvalidPlatformFeeBps,
    #[msg("Invalid performance fee bps")]
    InvalidPerformanceFeeBps,
    #[msg("Invalid base asset")]
    InvalidBaseAsset,
    #[msg("Decimal conversion failed")]
    DecimalConversionFailed,
    #[msg("Maximum share premium exceeded")]
    MaximumSharePremiumExceeded,
    #[msg("Invalid strategist")]
    InvalidStrategist,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Invalid share mover")]
    InvalidShareMover,
    #[msg("Invalid vault")]
    InvalidVault,
}
