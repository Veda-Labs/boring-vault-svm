use crate::error::RateLimitError;
use anchor_lang::prelude::*;

/// Rate limit state matching the EVM implementation's linear decay model
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct RateLimitState {
    /// The amount currently in flight (being tracked in the window)
    pub amount_in_flight: u64,
    /// Timestamp of the last update
    pub last_updated: i64,
    /// Maximum allowed amount within the window
    pub limit: u64,
    /// Duration of the rate limiting window (in seconds)
    pub window: u64,
}

impl RateLimitState {
    /// Constructs a new rate-limit state, validating parameters.
    pub fn new(limit: u64, window: u64, last_updated: i64) -> Result<Self> {
        if limit > 0 {
            require!(window > 0, RateLimitError::InvalidWindow);
        }
        Ok(Self {
            amount_in_flight: 0,
            last_updated,
            limit,
            window,
        })
    }
    /// Checks if the amount can be sent/received within rate limits and updates state if allowed
    pub fn check_and_consume(&mut self, amount: u64, current_timestamp: i64) -> Result<()> {
        if amount == 0 {
            return Err(RateLimitError::ZeroAmount.into());
        }

        // Reject time going backwards
        require!(
            current_timestamp >= self.last_updated,
            RateLimitError::InvalidTimestamp
        );

        // If the limit is zero, rate limiting is disabled completely
        if self.limit == 0 {
            return Ok(());
        }

        // Calculate the current amount in flight and amount that can be sent
        let (current_amount_in_flight, amount_can_be_sent) =
            self.calculate_available(current_timestamp)?;

        if amount > amount_can_be_sent {
            msg!(
                "RateLimitExceeded: requested={}, available={}",
                amount,
                amount_can_be_sent
            );
            return Err(RateLimitError::RateLimitExceeded.into());
        }

        // Update the storage with new amount and current timestamp
        self.amount_in_flight = current_amount_in_flight
            .checked_add(amount)
            .ok_or(RateLimitError::Overflow)?;
        self.last_updated = current_timestamp;

        Ok(())
    }

    /// Calculates the current amount in flight and how much can be sent
    pub fn calculate_available(&self, current_timestamp: i64) -> Result<(u64, u64)> {
        // If window is 0, rate limiting is effectively disabled
        if self.window == 0 {
            return Ok((0, u64::MAX));
        }

        let time_since_last_update = current_timestamp.saturating_sub(self.last_updated) as u64;

        let (current_amount_in_flight, amount_can_be_sent) =
            if time_since_last_update >= self.window {
                // Full window has passed, everything has decayed
                (0, self.limit)
            } else {
                // Calculate linear decay
                // decay = (limit * timeSinceLastUpdate) / window
                let decay = self
                    .limit
                    .checked_mul(time_since_last_update)
                    .and_then(|v| v.checked_div(self.window))
                    .ok_or(RateLimitError::Overflow)?;

                // Current amount in flight after decay
                let current_amount = self.amount_in_flight.saturating_sub(decay);

                // Amount that can be sent
                // In case limit was lowered and in-flight amount is higher than limit, set to 0
                let available = self.limit.saturating_sub(current_amount);

                (current_amount, available)
            };

        Ok((current_amount_in_flight, amount_can_be_sent))
    }
}

pub fn create_test_rate_limit_state(
    limit: u64,
    window: u64,
    last_updated: i64,
    amount_in_flight: u64,
) -> RateLimitState {
    RateLimitState {
        amount_in_flight,
        last_updated,
        limit,
        window,
    }
}

#[cfg(test)]
mod rate_limit_tests {
    use super::*;
    use anchor_lang::error;

    #[test]
    fn test_rate_limit_disabled() {
        let mut state = create_test_rate_limit_state(0, 3600, 0, 0); // limit = 0
        let result = state.check_and_consume(5000, 10);
        assert!(result.is_ok(), "Should succeed when rate limit is disabled");
    }

    #[test]
    fn test_basic_consumption_succeeds() {
        let mut state = create_test_rate_limit_state(1000, 3600, 0, 0); // 1000 per hour

        let result = state.check_and_consume(500, 100);
        assert!(result.is_ok());
        assert_eq!(state.amount_in_flight, 500);
        assert_eq!(state.last_updated, 100);
    }

    #[test]
    fn test_rate_limit_exceeded_fails() {
        let mut state = create_test_rate_limit_state(1000, 3600, 0, 0);
        let result = state.check_and_consume(1001, 100);

        assert!(
            result.is_err(),
            "Should fail when consuming more than limit"
        );
        let err = result.unwrap_err();
        assert_eq!(err, error!(RateLimitError::RateLimitExceeded));
    }

    #[test]
    fn test_exact_consumption_succeeds() {
        let mut state = create_test_rate_limit_state(1000, 3600, 0, 0);
        let result = state.check_and_consume(1000, 100);
        assert!(result.is_ok());
        assert_eq!(state.amount_in_flight, 1000);
    }

    #[test]
    fn test_linear_decay() {
        let state = create_test_rate_limit_state(1000, 3600, 0, 800); // 1000 per hour, 800 in flight

        // After 1800 seconds (half window), half should have decayed
        let (amount_in_flight, amount_can_be_sent) = state.calculate_available(1800).unwrap();
        assert_eq!(amount_in_flight, 300); // 800 - (1000 * 1800/3600) = 800 - 500 = 300
        assert_eq!(amount_can_be_sent, 700); // 1000 - 300 = 700
    }

    #[test]
    fn test_full_window_reset() {
        let state = create_test_rate_limit_state(1000, 3600, 0, 800);

        // After full window, everything should be reset
        let (amount_in_flight, amount_can_be_sent) = state.calculate_available(3600).unwrap();
        assert_eq!(amount_in_flight, 0);
        assert_eq!(amount_can_be_sent, 1000);
    }

    #[test]
    fn test_consumption_after_partial_decay() {
        let mut state = create_test_rate_limit_state(1000, 3600, 0, 800);

        // After 1800 seconds, try to consume 600 (should succeed as 700 is available)
        let result = state.check_and_consume(600, 1800);
        assert!(result.is_ok());
        assert_eq!(state.amount_in_flight, 900); // 300 (after decay) + 600 = 900
        assert_eq!(state.last_updated, 1800);
    }

    #[test]
    fn test_limit_lowered_scenario() {
        // Scenario where limit is lowered while amount is in flight
        let state = create_test_rate_limit_state(500, 3600, 0, 800); // limit < amount_in_flight

        // Should not be able to send anything
        let (amount_in_flight, amount_can_be_sent) = state.calculate_available(100).unwrap();
        assert!(amount_in_flight > 500); // Some decay, but still over limit
        assert_eq!(amount_can_be_sent, 0); // Cannot send when over new limit
    }

    #[test]
    fn test_zero_amount_rejected() {
        let mut state = create_test_rate_limit_state(100, 60, 0, 0);
        let err = state.check_and_consume(0, 1).unwrap_err();
        assert_eq!(err, error!(RateLimitError::ZeroAmount));
    }

    #[test]
    fn test_overflow_in_decay() {
        // limit * time_since_last_update overflows while time_since < window
        let state = create_test_rate_limit_state(u64::MAX, u64::MAX, 0, 0);
        let err = state.calculate_available(2).unwrap_err();
        assert_eq!(err, error!(RateLimitError::Overflow));
    }

    #[test]
    fn test_overflow_in_add() {
        let mut state = create_test_rate_limit_state(u64::MAX, 60, 0, u64::MAX - 1);
        let err = state.check_and_consume(10, 10).unwrap_err();
        assert_eq!(err, error!(RateLimitError::Overflow));
    }

    #[test]
    fn test_window_zero_disabled() {
        let state = create_test_rate_limit_state(1000, 0, 0, 0); // window = 0

        let (amount_in_flight, amount_can_be_sent) = state.calculate_available(100).unwrap();
        assert_eq!(amount_in_flight, 0);
        assert_eq!(amount_can_be_sent, u64::MAX); // Effectively unlimited
    }
}
