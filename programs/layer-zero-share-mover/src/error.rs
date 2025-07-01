use anchor_lang::prelude::*;

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
    #[msg("Invalid endpoint program")]
    InvalidEndpointProgram,
    #[msg("Invalid message")]
    InvalidMessage,
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
    #[msg("Invalid peer chain")]
    InvalidPeerChain,
    #[msg("Unauthorized Executor")]
    UnauthorizedExecutor,
    #[msg("Not Allowed from")]
    NotAllowedFrom,
    #[msg("Not Allowed to")]
    NotAllowedTo,
}
