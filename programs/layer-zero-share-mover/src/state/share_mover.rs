use crate::error::BoringErrorCode;
use anchor_lang::{prelude::Pubkey, prelude::*};
use common::{
    error::{MathError, ShareBridgeCodecError},
    message::ShareBridgeMessage,
    rate_limit::RateLimitState,
};

#[derive(InitSpace)]
#[account]
pub struct ProgramConfig {
    pub authority: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PeerChain {
    Unknown,
    Evm,
    Sui,
}

impl Default for PeerChain {
    fn default() -> Self {
        Self::Unknown
    }
}

impl PeerChain {
    pub fn validate(&self, address: &[u8; 32]) -> Result<()> {
        msg!("Validating address: {:?}", address);

        require!(
            address.iter().any(|&byte| byte != 0),
            ShareBridgeCodecError::InvalidSuiRecipientAddress
        );

        let is_evm_address = ShareBridgeMessage::is_valid_padded_evm_address(address);

        match self {
            PeerChain::Evm => {
                require!(
                    is_evm_address,
                    ShareBridgeCodecError::InvalidEVMRecipientAddress
                );
                Ok(())
            }
            PeerChain::Sui => {
                require!(
                    !is_evm_address,
                    ShareBridgeCodecError::InvalidSuiRecipientAddress
                );
                Ok(())
            }
            _ => Err(error!(BoringErrorCode::InvalidPeerChain)),
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Debug, Clone)]
pub struct OldShareMover {
    pub admin: Pubkey,
    pub endpoint_program: Pubkey,
    pub executor_program: Pubkey, // This field was removed
    pub boring_vault_program: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub is_paused: bool,
    pub peer_decimals: u8,
    pub bump: u8,
    pub allow_from: bool,
    pub allow_to: bool,
    pub outbound_rate_limit: RateLimitState,
    pub inbound_rate_limit: RateLimitState,
    pub peer_chain: PeerChain,
}

#[derive(InitSpace)]
#[account]
pub struct ShareMover {
    pub admin: Pubkey,
    /// Endpoint program associated with this ShareMover.
    ///
    /// LayerZero allows multiple endpoints/DVNs per chain; if we ever need
    /// to support that, this can be swapped for a Pubkey array
    pub endpoint_program: Pubkey,
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
    pub pending_admin: Pubkey,
}

impl ShareMover {
    pub fn check_inbound_rate_limit(
        &mut self,
        amount: u128, // Amount from message is u128
        current_timestamp: i64,
    ) -> Result<()> {
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
            pending_admin: Pubkey::default(),
        }
    }

    #[test]
    fn test_share_mover_outbound_check() {
        let mut share_mover = create_test_share_mover();
        let current_time = 100;

        // Initialize with limit=1000, window=3600 (1 hour), starting with 0 in flight
        share_mover.outbound_rate_limit = create_test_rate_limit_state(1000, 3600, current_time, 0);

        // Successful check. Start with 0 in flight, consume 400
        let result = share_mover
            .outbound_rate_limit
            .check_and_consume(400, current_time);
        assert!(result.is_ok());
        assert_eq!(share_mover.outbound_rate_limit.amount_in_flight, 400);

        // Try to consume 600 more immediately (should succeed, total = 1000)
        let result = share_mover
            .outbound_rate_limit
            .check_and_consume(600, current_time);
        assert!(result.is_ok());
        assert_eq!(share_mover.outbound_rate_limit.amount_in_flight, 1000);

        // Try to consume 1 more immediately (should fail, at limit)
        let result_fail = share_mover
            .outbound_rate_limit
            .check_and_consume(1, current_time);
        assert!(result_fail.is_err());
        assert_eq!(
            result_fail.unwrap_err(),
            error!(RateLimitError::RateLimitExceeded)
        );

        // After half the window (1800 seconds), half should have decayed
        // 1000 * 1800/3600 = 500 decayed, so 500 in flight, can send 500 more
        let result = share_mover
            .outbound_rate_limit
            .check_and_consume(400, current_time + 1800);
        assert!(result.is_ok());
        assert_eq!(share_mover.outbound_rate_limit.amount_in_flight, 900); // 500 (after decay) + 400
    }

    #[test]
    fn test_share_mover_inbound_check() {
        let mut share_mover = create_test_share_mover();
        let current_time = 200;

        // Initialize with limit=10000, window=3600 (1 hour), starting with 0 in flight
        share_mover.inbound_rate_limit = create_test_rate_limit_state(10000, 3600, current_time, 0);

        // Successful check. Start with 0 in flight, consume 5000
        let result = share_mover.check_inbound_rate_limit(5000, current_time);
        assert!(result.is_ok());
        assert_eq!(share_mover.inbound_rate_limit.amount_in_flight, 5000);

        // After quarter window (900 seconds), 2500 should have decayed
        // 10000 * 900/3600 = 2500 decayed, so 2500 in flight, can receive 7500 more
        let result = share_mover.check_inbound_rate_limit(7000, current_time + 900);
        assert!(result.is_ok());
        assert_eq!(share_mover.inbound_rate_limit.amount_in_flight, 9500); // 2500 (after decay) + 7000

        // Failed check due to amount > u64::MAX
        let large_amount = u64::MAX as u128 + 1;
        let result_large = share_mover.check_inbound_rate_limit(large_amount, current_time + 1000);
        assert!(result_large.is_err());
        assert_eq!(result_large.unwrap_err(), error!(MathError::Overflow));
    }

    #[test]
    fn test_rate_limit_full_window_reset() {
        let mut share_mover = create_test_share_mover();
        let current_time = 0;

        // Initialize with limit=1000, window=3600, with 800 already in flight
        share_mover.outbound_rate_limit =
            create_test_rate_limit_state(1000, 3600, current_time, 800);

        // After full window passes, everything should reset
        let result = share_mover
            .outbound_rate_limit
            .check_and_consume(1000, current_time + 3600);
        assert!(result.is_ok());
        assert_eq!(share_mover.outbound_rate_limit.amount_in_flight, 1000);
        assert_eq!(
            share_mover.outbound_rate_limit.last_updated,
            current_time + 3600
        );
    }

    #[test]
    fn test_rate_limit_disabled() {
        let mut share_mover = create_test_share_mover();
        let current_time = 0;

        // Initialize with limit=0 (disabled)
        share_mover.outbound_rate_limit = create_test_rate_limit_state(0, 3600, current_time, 0);

        // Should be able to send any amount when disabled
        let result = share_mover
            .outbound_rate_limit
            .check_and_consume(u64::MAX, current_time);
        assert!(result.is_ok());
        // When disabled, state shouldn't be updated
        assert_eq!(share_mover.outbound_rate_limit.amount_in_flight, 0);
    }
}
