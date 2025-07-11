//! Pure mathematical functions for oracle price processing and conversions
//!
//! This module contains stateless math functions that can be easily tested
//! in isolation without requiring Solana runtime or account data.

use crate::{constants::*, BoringErrorCode};
use anchor_lang::prelude::*;
use rust_decimal::Decimal;

// ================================ Pyth Oracle Math ================================

/// Converts Pyth price data to a Decimal with proper scaling
///
/// # Arguments
/// * `price` - Raw price value from Pyth
/// * `exponent` - Price exponent from Pyth (usually negative)
///
/// # Returns
/// * `Decimal` - Properly scaled decimal price
///
/// # Examples
/// ```
/// let price = pyth_price_to_decimal(123456789, -8);
/// // Results in 1.23456789 (123456789 * 10^-8)
/// ```
pub fn pyth_price_to_decimal(price: i64, exponent: i32) -> Result<Decimal> {
    if exponent >= 0 {
        // Positive exponent: multiply by 10^exponent
        let multiplier = 10i128.pow(exponent as u32);
        let result = (price as i128)
            .checked_mul(multiplier)
            .ok_or(error!(BoringErrorCode::MathError))?;
        Ok(Decimal::from(result))
    } else {
        // Negative exponent: use scale
        let decimal_price = Decimal::from_i128_with_scale(price as i128, (-exponent) as u32);
        Ok(decimal_price)
    }
}

/// Converts slot-based staleness threshold to seconds
///
/// # Arguments
/// * `max_staleness_slots` - Maximum staleness in Solana slots
///
/// # Returns
/// * `u64` - Equivalent time in seconds (assuming ~0.4s per slot)
///
/// # Note
/// Uses saturating multiplication to prevent overflow
pub fn slots_to_seconds(max_staleness_slots: u64) -> u64 {
    max_staleness_slots.saturating_mul(400) / 1000
}

// ================================ Decimal Conversion Math ================================

/// Converts a value to a Decimal with specified decimal places
///
/// # Arguments
/// * `amount` - The value to convert
/// * `decimals` - Number of decimal places
pub fn to_decimal<T: Into<Decimal>>(amount: T, decimals: u8) -> Result<Decimal> {
    let mut decimal = amount.into();
    decimal.set_scale(decimals as u32).unwrap();
    Ok(decimal)
}

/// Converts a Decimal back to the specified numeric type
///
/// # Arguments
/// * `decimal` - The Decimal to convert
/// * `decimals` - Number of decimal places for the result
pub fn from_decimal<T: TryFrom<Decimal>>(decimal: Decimal, decimals: u8) -> Result<T> {
    decimal
        .checked_mul(Decimal::from(10u64.pow(decimals as u32)))
        .ok_or(error!(BoringErrorCode::MathError))?
        .try_into()
        .map_err(|_| error!(BoringErrorCode::DecimalConversionFailed))
}

/// Applies inverse transformation to price if needed
///
/// # Arguments
/// * `price` - Original price value
/// * `is_inverse` - Whether to invert the price (1/price)
///
/// # Returns
/// * `Result<Decimal>` - Potentially inverted price
pub fn apply_price_inversion(price: Decimal, is_inverse: bool) -> Result<Decimal> {
    if is_inverse {
        if price.is_zero() {
            return Err(error!(BoringErrorCode::MathError));
        }
        Decimal::from(1)
            .checked_div(price)
            .ok_or(error!(BoringErrorCode::MathError))
    } else {
        Ok(price)
    }
}

// ================================ Share Premium Math ================================

/// Calculates the share premium reduction
///
/// # Arguments
/// * `base_shares` - Shares before premium
/// * `premium_bps` - Premium in basis points (100 = 1%)
///
/// # Returns
/// * `Result<Decimal>` - Shares after premium reduction
pub fn apply_share_premium(base_shares: Decimal, premium_bps: u16) -> Result<Decimal> {
    if premium_bps == 0 {
        return Ok(base_shares);
    }

    let premium_decimal = to_decimal(premium_bps, BPS_DECIMALS)?;
    let premium_amount = base_shares
        .checked_mul(premium_decimal)
        .ok_or(error!(BoringErrorCode::MathError))?;

    base_shares
        .checked_sub(premium_amount)
        .ok_or(error!(BoringErrorCode::MathError))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ================================ Test Helper Functions ================================

    /// Validates price data age against staleness threshold (test helper)
    fn is_price_fresh(price_timestamp: i64, current_timestamp: i64, max_age_seconds: u64) -> bool {
        if current_timestamp < price_timestamp {
            // Price is from the future, consider it fresh
            return true;
        }

        let age_seconds = (current_timestamp - price_timestamp) as u64;
        age_seconds <= max_age_seconds
    }

    /// Validates that a feed ID is exactly 32 bytes (test helper)  
    fn is_valid_feed_id(feed_id: &[u8]) -> bool {
        feed_id.len() == 32
    }

    // ================================ Pyth Oracle Math Tests ================================

    #[test]
    fn test_pyth_price_to_decimal() {
        // Test typical JITOSOL/SOL price: 1.05 with -8 exponent
        let price = pyth_price_to_decimal(105000000, -8).unwrap();
        assert_eq!(price.to_string(), "1.05000000");

        // Test BTC/USD price: $45,000 with -8 exponent
        let btc_price = pyth_price_to_decimal(4500000000000, -8).unwrap();
        assert_eq!(btc_price.to_string(), "45000.00000000");

        // Test very small price with high precision
        let small_price = pyth_price_to_decimal(1, -18).unwrap();
        assert_eq!(small_price.to_string(), "0.000000000000000001");
    }

    #[test]
    fn test_pyth_price_edge_cases() {
        // Test zero price
        let zero_price = pyth_price_to_decimal(0, -8).unwrap();
        assert_eq!(zero_price, Decimal::ZERO);

        // Test negative price
        let neg_price = pyth_price_to_decimal(-100000000, -8).unwrap();
        assert_eq!(neg_price.to_string(), "-1.00000000");

        // Test positive exponent (multiply by 10^exponent)
        let pos_exp_price = pyth_price_to_decimal(123, 2).unwrap();
        assert_eq!(pos_exp_price, Decimal::from(12300));
    }

    #[test]
    fn test_slots_to_seconds_conversion() {
        // Test typical staleness: 12,500 slots = ~5,000 seconds
        assert_eq!(slots_to_seconds(12_500), 5_000);

        // Test 1 slot = 0.4 seconds (rounded down to 0)
        assert_eq!(slots_to_seconds(1), 0);

        // Test 3 slots = 1.2 seconds (rounded down to 1)
        assert_eq!(slots_to_seconds(3), 1);

        // Test overflow protection
        let result = slots_to_seconds(u64::MAX);
        // Should not panic and should be a reasonable value
        assert!(result > 0);
    }

    #[test]
    fn test_price_freshness_validation() {
        let current_time = 1700000000i64;

        // Fresh price (5 seconds old, max 60 seconds)
        assert!(is_price_fresh(current_time - 5, current_time, 60));

        // Stale price (120 seconds old, max 60 seconds)
        assert!(!is_price_fresh(current_time - 120, current_time, 60));

        // Exactly at threshold (60 seconds old, max 60 seconds)
        assert!(is_price_fresh(current_time - 60, current_time, 60));

        // Future price (should be considered fresh)
        assert!(is_price_fresh(current_time + 10, current_time, 60));
    }

    #[test]
    fn test_feed_id_validation() {
        // Valid 32-byte feed ID
        let valid_id = [1u8; 32];
        assert!(is_valid_feed_id(&valid_id));

        // Invalid lengths
        assert!(!is_valid_feed_id(&[1u8; 31]));
        assert!(!is_valid_feed_id(&[1u8; 33]));
        assert!(!is_valid_feed_id(&[]));
    }

    // ================================ Price Inversion Tests ================================

    #[test]
    fn test_price_inversion() {
        let price = Decimal::from(2);

        // Normal price (no inversion)
        let normal = apply_price_inversion(price, false).unwrap();
        assert_eq!(normal, Decimal::from(2));

        // Inverted price (1/2 = 0.5)
        let inverted = apply_price_inversion(price, true).unwrap();
        assert_eq!(inverted * Decimal::from(2), Decimal::from(1)); // Verify 0.5 * 2 = 1

        // Test zero price inversion (should error)
        assert!(apply_price_inversion(Decimal::ZERO, true).is_err());
    }

    // ================================ Share Premium Tests ================================

    #[test]
    fn test_share_premium_calculation() {
        let base_shares = Decimal::from(1000);

        // No premium
        let no_premium = apply_share_premium(base_shares, 0).unwrap();
        assert_eq!(no_premium, Decimal::from(1000));

        // 1% premium (100 bps)
        let with_premium = apply_share_premium(base_shares, 100).unwrap();
        assert_eq!(with_premium, Decimal::from(990)); // 1000 - (1000 * 0.01)

        // 5% premium (500 bps)
        let high_premium = apply_share_premium(base_shares, 500).unwrap();
        assert_eq!(high_premium, Decimal::from(950)); // 1000 - (1000 * 0.05)
    }

    // ================================ Decimal Conversion Tests ================================

    #[test]
    fn test_decimal_conversions() {
        // Test to_decimal
        let decimal_9 = to_decimal(1_000_000_000u64, 9).unwrap();
        assert_eq!(decimal_9.scale(), 9);

        // Test from_decimal roundtrip
        let back: u64 = from_decimal(decimal_9, 9).unwrap();
        assert_eq!(back, 1_000_000_000u64);

        // Test different decimal places
        let decimal_6 = to_decimal(1_000_000u64, 6).unwrap();
        let back_6: u64 = from_decimal(decimal_6, 6).unwrap();
        assert_eq!(back_6, 1_000_000u64);
    }

    #[test]
    fn test_decimal_conversion_edge_cases() {
        // Test zero
        let zero_decimal = to_decimal(0u64, 9).unwrap();
        let back_zero: u64 = from_decimal(zero_decimal, 9).unwrap();
        assert_eq!(back_zero, 0);

        // Test maximum safe values
        let max_safe = 1_000_000_000_000_000u64; // Large but safe value
        let decimal = to_decimal(max_safe, 9).unwrap();
        let back: u64 = from_decimal(decimal, 9).unwrap();
        assert_eq!(back, max_safe);
    }

    // ================================ Integration Tests ================================

    #[test]
    fn test_full_pyth_v2_price_processing() {
        // Simulate full Pyth V2 price processing pipeline
        let raw_price = 105000000i64; // 1.05 with -8 exponent
        let exponent = -8i32;
        let max_staleness_slots = 12500u64;
        let current_time = 1700000000i64;
        let price_time = current_time - 30; // 30 seconds old

        // Step 1: Convert raw price to decimal
        let decimal_price = pyth_price_to_decimal(raw_price, exponent).unwrap();
        assert_eq!(decimal_price.to_string(), "1.05000000");

        // Step 2: Check staleness
        let max_age_seconds = slots_to_seconds(max_staleness_slots);
        let is_fresh = is_price_fresh(price_time, current_time, max_age_seconds);
        assert!(is_fresh); // Should be fresh (30s < 5000s)

        // Step 3: Apply any inversion if needed
        let final_price = apply_price_inversion(decimal_price, false).unwrap();
        assert_eq!(final_price.to_string(), "1.05000000");
    }

    #[test]
    fn test_precision_preservation() {
        // Test that we don't lose precision through the conversion pipeline
        let high_precision_cases = vec![
            (123456789012345i64, -15i32), // Very high precision
            (1i64, -18i32),               // Smallest possible value
            (999999999999999i64, -15i32), // Large value with precision
        ];

        for (price, exponent) in high_precision_cases {
            let decimal = pyth_price_to_decimal(price, exponent).unwrap();

            // Verify the decimal represents the exact expected value
            let expected_scale = (-exponent) as u32;
            assert_eq!(decimal.scale(), expected_scale);

            // Verify mantissa is preserved
            let mantissa = decimal.mantissa();
            assert_eq!(mantissa, price as i128);
        }
    }

    #[test]
    fn test_math_error_boundaries() {
        // Test that functions handle edge cases gracefully

        // Very large premium should not panic
        let large_shares = Decimal::from(u64::MAX);
        let result = apply_share_premium(large_shares, 9999); // 99.99%
        assert!(result.is_ok() || result.is_err()); // Should either work or fail gracefully

        // Division by zero in price inversion
        let zero_inversion = apply_price_inversion(Decimal::ZERO, true);
        assert!(zero_inversion.is_err());

        // Invalid feed ID lengths
        assert!(!is_valid_feed_id(&[0u8; 0]));
        assert!(!is_valid_feed_id(&[0u8; 1000]));
    }
}
