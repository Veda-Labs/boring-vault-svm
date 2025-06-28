use crate::error::BoringErrorCode;
use anchor_lang::prelude::*; // Assuming you have an error enum

// A new struct to encapsulate the state for a single rate limit bucket.
// This keeps the ShareMover struct cleaner.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct RateLimitState {
    /// The number of tokens (shares) added to the bucket per second.
    pub limit: u64,
    /// The maximum capacity of the bucket, to prevent infinite accumulation.
    pub capacity: u64,
    /// The last time the bucket was refilled (Unix timestamp).
    pub last_refill_timestamp: i64,
    /// The current number of available tokens in the bucket.
    pub current_bucket_size: u64,
}

impl Default for RateLimitState {
    /// Initializes the rate limit to be disabled by default.
    fn default() -> Self {
        Self {
            limit: 0, // A limit of 0 means rate limiting is disabled.
            capacity: 0,
            last_refill_timestamp: 0,
            current_bucket_size: 0,
        }
    }
}

impl RateLimitState {
    /// The core token bucket logic. Refills the bucket based on time passed
    /// and checks if a given amount can be consumed.
    /// This method is internal and mutates the state.
    pub fn check_and_consume(&mut self, amount: u64, current_timestamp: i64) -> Result<()> {
        // If the limit is zero, rate limiting is disabled for this bucket.
        if self.limit == 0 {
            return Ok(());
        }

        // Refill the bucket based on the time elapsed since the last check.
        self.refill(current_timestamp);

        // Check if there are enough tokens in the bucket for the requested amount.
        require!(
            self.current_bucket_size >= amount,
            BoringErrorCode::RateLimitExceeded
        );

        // Consume the tokens from the bucket.
        self.current_bucket_size -= amount;

        Ok(())
    }

    /// Refills the token bucket based on the elapsed time.
    pub fn refill(&mut self, current_timestamp: i64) {
        // Calculate the time passed since the last refill.
        let time_passed = current_timestamp.saturating_sub(self.last_refill_timestamp);

        if time_passed > 0 {
            // Calculate how many tokens to add to the bucket.
            let tokens_to_add = (time_passed as u64).saturating_mul(self.limit);

            // Add the new tokens, ensuring the bucket does not exceed its capacity.
            self.current_bucket_size = self
                .current_bucket_size
                .saturating_add(tokens_to_add)
                .min(self.capacity);

            // Update the last refill timestamp.
            self.last_refill_timestamp = current_timestamp;
        }
    }
}

#[cfg(test)]
mod rate_limit_tests {
    use crate::state::{PeerChain, ShareMover};

    use super::*;
    use anchor_lang::error;

    // Helper to create a default RateLimitState for testing
    fn create_test_rate_limit_state(
        limit: u64,
        capacity: u64,
        current_timestamp: i64,
    ) -> RateLimitState {
        RateLimitState {
            limit,
            capacity,
            last_refill_timestamp: current_timestamp,
            current_bucket_size: capacity, // Start with a full bucket
        }
    }

    #[test]
    fn test_rate_limit_disabled() {
        let mut state = create_test_rate_limit_state(0, 1000, 0); // limit = 0
        let result = state.check_and_consume(5000, 10); // Try to consume more than capacity
        assert!(result.is_ok(), "Should succeed when rate limit is disabled");
    }

    #[test]
    fn test_basic_consumption_succeeds() {
        let mut state = create_test_rate_limit_state(100, 1000, 0);
        assert_eq!(state.current_bucket_size, 1000);

        let result = state.check_and_consume(500, 1);
        assert!(result.is_ok());
        assert_eq!(
            state.current_bucket_size, 500,
            "Bucket size should decrease after consumption"
        );
    }

    #[test]
    fn test_rate_limit_exceeded_fails() {
        let mut state = create_test_rate_limit_state(100, 1000, 0);
        let result = state.check_and_consume(1001, 1);

        assert!(
            result.is_err(),
            "Should fail when consuming more than available"
        );
        let err = result.unwrap_err();
        assert_eq!(err, error!(BoringErrorCode::RateLimitExceeded));
    }

    #[test]
    fn test_exact_consumption_succeeds() {
        let mut state = create_test_rate_limit_state(100, 1000, 0);
        let result = state.check_and_consume(1000, 1);
        assert!(result.is_ok());
        assert_eq!(state.current_bucket_size, 0);
    }

    #[test]
    fn test_refill_logic() {
        let mut state = create_test_rate_limit_state(100, 1000, 0);
        state.current_bucket_size = 0; // Empty the bucket

        // Simulate 5 seconds passing
        state.refill(5);

        // Bucket should refill by 5 * 100 = 500
        assert_eq!(state.current_bucket_size, 500);
        assert_eq!(state.last_refill_timestamp, 5);
    }

    #[test]
    fn test_refill_does_not_exceed_capacity() {
        let mut state = create_test_rate_limit_state(100, 1000, 0);
        state.current_bucket_size = 800; // Partially full bucket

        // Simulate 5 seconds passing (should add 500, but capped at 1000)
        state.refill(5);

        assert_eq!(
            state.current_bucket_size, 1000,
            "Bucket should not exceed capacity"
        );
    }

    #[test]
    fn test_refill_with_no_time_passed() {
        let mut state = create_test_rate_limit_state(100, 1000, 0);
        state.current_bucket_size = 500;

        // Call refill with the same timestamp
        state.refill(0);

        assert_eq!(
            state.current_bucket_size, 500,
            "Bucket should not change if no time has passed"
        );
    }

    #[test]
    fn test_consumption_after_refill() {
        let mut state = create_test_rate_limit_state(100, 1000, 0);

        // 1. Consume 800 tokens. Bucket starts full (1000), so no refill. 200 remain.
        let _ = state.check_and_consume(800, 1);
        assert_eq!(state.current_bucket_size, 200);
        assert_eq!(state.last_refill_timestamp, 1);

        // 2. Try to consume 300. This should succeed.
        // 1 second has passed (t=2), so bucket refills by 100 (200 + 100 = 300).
        // Consuming 300 leaves 0.
        let result1 = state.check_and_consume(300, 2);
        assert!(result1.is_ok(), "Check should succeed after exact refill");
        assert_eq!(state.current_bucket_size, 0);
        assert_eq!(state.last_refill_timestamp, 2);

        // 3. Wait 3 more seconds (t=5). Bucket should refill by 3 * 100 = 300.
        // Try to consume 250, which should succeed.
        let result2 = state.check_and_consume(250, 5);
        assert!(result2.is_ok());
        assert_eq!(state.current_bucket_size, 50); // 300 - 250 = 50
        assert_eq!(state.last_refill_timestamp, 5);
    }

    // --- ShareMover Integration Tests ---

    // Mock ShareMover for testing purposes
    fn create_test_share_mover() -> ShareMover {
        ShareMover {
            admin: Pubkey::new_unique(),
            endpoint_program: Pubkey::new_unique(),
            boring_vault_program: Pubkey::new_unique(),
            vault: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            is_paused: false,
            peer_decimals: 18,
            bump: 0,
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
            error!(BoringErrorCode::RateLimitExceeded)
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
        assert_eq!(result_large.unwrap_err(), error!(BoringErrorCode::Overflow));
    }
}
