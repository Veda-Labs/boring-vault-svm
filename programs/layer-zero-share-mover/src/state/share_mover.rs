use anchor_lang::{prelude::Pubkey, prelude::*};
use common::{error::MathError, rate_limit::RateLimitState};

#[account]
pub struct ProgramConfig {
    pub authority: Pubkey,
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

// TODO: review immutability
#[account]
pub struct ShareMover {
    pub admin: Pubkey,
    pub endpoint_program: Pubkey,
    pub executor_program: Pubkey,
    // immutable after deployment
    pub boring_vault_program: Pubkey,
    // immutable after deployment
    pub vault: Pubkey,
    // immutable after deployment
    pub mint: Pubkey,
    pub is_paused: bool,
    // immutable after deployment
    pub peer_decimals: u8,
    pub bump: u8,
    pub allow_from: bool,
    pub allow_to: bool,
    pub outbound_rate_limit: RateLimitState,
    pub inbound_rate_limit: RateLimitState,
    // immutable after deployment
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
        let amount_u64 = u64::try_from(amount).map_err(|_| MathError::Overflow)?;

        self.inbound_rate_limit
            .check_and_consume(amount_u64, current_timestamp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use common::{
        error::{MathError, RateLimitError},
        rate_limit::create_test_rate_limit_state,
    };

    fn create_test_share_mover() -> ShareMover {
        ShareMover {
            admin: Pubkey::new_unique(),
            endpoint_program: Pubkey::new_unique(),
            executor_program: Pubkey::new_unique(),
            boring_vault_program: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            is_paused: false,
            peer_decimals: 18,
            bump: 0,
            allow_from: false,
            allow_to: false,
            outbound_rate_limit: Default::default(),
            inbound_rate_limit: Default::default(),
            peer_chain: PeerChain::Unknown,
        }
    }

    #[test]
    fn test_share_mover_outbound_check() {
        let mut share_mover = create_test_share_mover();
        let current_time = 100;
        share_mover.outbound_rate_limit = create_test_rate_limit_state(50, 500, current_time);

        // Successful check. Bucket starts full at 500. No refill. Consumes 400. 100 left.
        let result = share_mover.check_outbound_rate_limit(400, current_time + 1);
        assert!(result.is_ok());
        assert_eq!(share_mover.outbound_rate_limit.current_bucket_size, 100); // 500 - 400 = 100

        // Failed check. 1 second passes, refills by 50. Bucket becomes 150.
        // Attempting to consume 200 fails.
        let result_fail = share_mover.check_outbound_rate_limit(200, current_time + 2);
        assert!(result_fail.is_err());
        assert_eq!(
            result_fail.unwrap_err(),
            error!(RateLimitError::RateLimitExceeded)
        );

        // IMPORTANT: The bucket state is still updated by the refill, even on failure.
        assert_eq!(share_mover.outbound_rate_limit.current_bucket_size, 150);
    }

    #[test]
    fn test_share_mover_inbound_check() {
        let mut share_mover = create_test_share_mover();
        let current_time = 200;
        share_mover.inbound_rate_limit = create_test_rate_limit_state(1000, 10000, current_time);

        // Successful check. Bucket starts full at 10000. No refill. Consumes 5000. 5000 left.
        let result = share_mover.check_inbound_rate_limit(5000, current_time + 1);
        assert!(result.is_ok());
        assert_eq!(share_mover.inbound_rate_limit.current_bucket_size, 5000); // 10000 - 5000 = 5000

        // Failed check due to amount > u64::MAX
        let large_amount = u64::MAX as u128 + 1;
        let result_large = share_mover.check_inbound_rate_limit(large_amount, current_time + 2);
        assert!(result_large.is_err());
        assert_eq!(result_large.unwrap_err(), error!(MathError::Overflow));
    }
}
