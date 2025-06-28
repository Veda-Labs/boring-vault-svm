use anchor_lang::{prelude::Pubkey, prelude::*};

use crate::{error::BoringErrorCode, rate_limit::RateLimitState};

#[account]
pub struct ProgramConfig {
    pub authority: Pubkey,
}

impl ProgramConfig {
    pub const LEN: usize = 8 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PeerChain {
    Unknown,
    Evm,
}

impl Default for PeerChain {
    fn default() -> Self {
        Self::Unknown
    }
}

#[account]
pub struct ShareMover {
    pub admin: Pubkey,
    pub endpoint_program: Pubkey,
    pub boring_vault_program: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub is_paused: bool,
    pub peer_decimals: u8,
    pub bump: u8,
    pub outbound_rate_limit: RateLimitState,
    pub inbound_rate_limit: RateLimitState,
    pub peer_chain: PeerChain,
}

impl ShareMover {
    /// Checks the outbound rate limit for sending shares.
    /// This function should be called within your `send` instruction.
    ///
    /// # Arguments
    ///
    /// * `amount` - The number of shares being sent.
    /// * `current_timestamp` - The current block timestamp from `Clock::get()`.
    pub fn check_outbound_rate_limit(&mut self, amount: u64, current_timestamp: i64) -> Result<()> {
        msg!("Checking outbound rate limit...");
        self.outbound_rate_limit
            .check_and_consume(amount, current_timestamp)
    }

    /// Checks the inbound rate limit for receiving shares.
    /// This function should be called within your `lz_receive` instruction.
    ///
    /// # Arguments
    ///
    /// * `amount` - The number of shares being received.
    /// * `current_timestamp` - The current block timestamp from `Clock::get()`.
    pub fn check_inbound_rate_limit(
        &mut self,
        amount: u128, // Amount from message is u128
        current_timestamp: i64,
    ) -> Result<()> {
        msg!("Checking inbound rate limit...");
        // Convert amount to u64 for the rate limiter, returning an error if it's too large.
        let amount_u64 = u64::try_from(amount).map_err(|_| BoringErrorCode::Overflow)?;

        self.inbound_rate_limit
            .check_and_consume(amount_u64, current_timestamp)
    }
}

#[account]
pub struct LzReceiveTypesAccounts {
    pub store: Pubkey, // This is required and should be consistent.
}

impl LzReceiveTypesAccounts {
    pub const LEN: usize = 8 + 32;
}
// https://github.com/LayerZero-Labs/LayerZero-v2/blob/88428755be6caa71cb1d2926141d73c8989296b5/packages/layerzero-v2/solana/programs/libs/oapp/src/endpoint_cpi.rs#L227
// same to anchor_lang::prelude::AccountMeta
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LzAccount {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}
