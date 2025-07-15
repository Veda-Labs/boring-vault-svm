// =============================================================================
// Integration tests for ShareBridge message codec using property-based and fuzz
// testing methodologies (QuickCheck, Proptest, structured edge-case tests).
// =============================================================================

// Additions to Cargo.toml (already added in dev-dependencies section):
// [dev-dependencies]
// arbitrary = { version = "1.3", features = ["derive"] }
// quickcheck = "1.0"
// proptest  = "1.0"

use arbitrary::Arbitrary;
use quickcheck::{quickcheck, TestResult};

// Re-export the types/functions we want to test from the crate
use common::message::{
    decode_message, encode_message, ShareBridgeMessage, MESSAGE_SIZE,
};

// =============================================================================
// 1. ARBITRARY IMPLEMENTATIONS FOR PROPERTY-BASED TESTING
// =============================================================================

#[derive(Debug, Clone, Arbitrary)]
struct FuzzShareBridgeMessage {
    recipient: [u8; 32],
    amount: u128,
}

impl From<FuzzShareBridgeMessage> for ShareBridgeMessage {
    fn from(fuzz_msg: FuzzShareBridgeMessage) -> Self {
        ShareBridgeMessage::new(fuzz_msg.recipient, fuzz_msg.amount)
    }
}

// -----------------------------------------------------------------------------
// QuickCheck helper newtypes to work around missing Arbitrary implementations for
// fixed-size arrays like `[u8; 32]`.
// -----------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Bytes32(pub [u8; 32]);

impl quickcheck::Arbitrary for Bytes32 {
    fn arbitrary(g: &mut quickcheck::Gen) -> Self {
        let mut arr = [0u8; 32];
        for byte in arr.iter_mut() {
            *byte = <u8 as quickcheck::Arbitrary>::arbitrary(g);
        }
        Bytes32(arr)
    }
}

// =============================================================================
// 2. QUICKCHECK PROPERTY-BASED TESTS
// =============================================================================

#[cfg(test)]
mod quickcheck_tests {
    use super::*;

    #[test]
    fn quickcheck_encode_decode_roundtrip() {
        fn prop_roundtrip(recipient: Bytes32, amount: u128) -> bool {
            let recipient_arr = recipient.0;
            let msg = ShareBridgeMessage::new(recipient_arr, amount);
            let encoded = encode_message(&msg);

            match decode_message(&encoded) {
                Ok(decoded) => decoded == msg,
                Err(_) => false,
            }
        }

        quickcheck(prop_roundtrip as fn(Bytes32, u128) -> bool);
    }

    #[test]
    fn quickcheck_encoded_message_size() {
        fn prop_message_size(recipient: Bytes32, amount: u128) -> bool {
            let msg = ShareBridgeMessage::new(recipient.0, amount);
            let encoded = encode_message(&msg);
            encoded.len() == MESSAGE_SIZE
        }

        quickcheck(prop_message_size as fn(Bytes32, u128) -> bool);
    }

    #[test]
    fn quickcheck_decimal_conversion_properties() {
        fn prop_decimal_conversion(amount: u128, from_decimals: u8, to_decimals: u8) -> TestResult {
            // Limit to 0–18 decimal places as used by standard tokens
            if from_decimals > 18 || to_decimals > 18 {
                return TestResult::discard();
            }

            match ShareBridgeMessage::convert_amount_decimals(amount, from_decimals, to_decimals) {
                Some(converted) => {
                    // If conversion succeeded, it should be non-zero if original was non-zero
                    if amount > 0 && converted == 0 {
                        // Acceptable only when scaling down (dust).
                        TestResult::from_bool(from_decimals > to_decimals)
                    } else {
                        TestResult::passed()
                    }
                }
                None => TestResult::passed(), // Overflow or dust cases are acceptable
            }
        }

        quickcheck(prop_decimal_conversion as fn(u128, u8, u8) -> TestResult);
    }

    #[test]
    fn quickcheck_same_decimals_identity() {
        fn prop_same_decimals(amount: u128, decimals: u8) -> TestResult {
            if decimals > 18 {
                return TestResult::discard();
            }

            let result = ShareBridgeMessage::convert_amount_decimals(amount, decimals, decimals);
            TestResult::from_bool(result == Some(amount))
        }

        quickcheck(prop_same_decimals as fn(u128, u8) -> TestResult);
    }
}

// =============================================================================
// 3. PROPTEST PROPERTY-BASED TESTS
// =============================================================================

#[cfg(test)]
mod proptest_tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn proptest_encode_decode_roundtrip(
            recipient in any::<[u8; 32]>(),
            amount    in any::<u128>()
        ) {
            let msg = ShareBridgeMessage::new(recipient, amount);
            let encoded = encode_message(&msg);
            let decoded = decode_message(&encoded).unwrap();
            let dec_recipient = decoded.recipient;
            let dec_amount    = decoded.amount;
            prop_assert_eq!(decoded, msg.clone());
            prop_assert_eq!(dec_recipient, recipient);
            prop_assert_eq!(dec_amount, amount);
        }

        #[test]
        fn proptest_invalid_message_lengths(
            data in prop::collection::vec(any::<u8>(), 0..200)
        ) {
            if data.len() == MESSAGE_SIZE {
                // Valid length – decoding may succeed or fail depending on content.
                let _ = decode_message(&data);
            } else {
                // Any other size must fail.
                prop_assert!(decode_message(&data).is_err());
            }
        }

        #[test]
        fn proptest_decimal_conversion_overflow_safety(
            amount        in any::<u128>(),
            from_decimals in 0u8..=18,
            to_decimals   in 0u8..=18
        ) {
            let result = ShareBridgeMessage::convert_amount_decimals(amount, from_decimals, to_decimals);

            if let Some(converted) = result {
                if from_decimals == to_decimals {
                    prop_assert_eq!(converted, amount);
                }

                if from_decimals > to_decimals && amount <= u128::MAX / 2 {
                    prop_assert!(converted <= amount);
                }
            }
        }

        #[test]
        fn proptest_evm_address_validation(address in any::<[u8; 32]>()) {
            let is_valid = ShareBridgeMessage::is_valid_padded_evm_address(&address);

            if is_valid {
                prop_assert!(address[0..12].iter().all(|&b| b == 0));
                prop_assert!(!address.iter().all(|&b| b == 0));
            }
        }

        // ------------------------------------------------------------------
        // DECODE → ENCODE ROUND-TRIP
        // If a 48-byte slice successfully decodes, re-encoding the resulting
        // message must yield exactly the original bytes.
        // ------------------------------------------------------------------
        #[test]
        fn proptest_decode_encode_roundtrip(
            data in prop::collection::vec(any::<u8>(), MESSAGE_SIZE..=MESSAGE_SIZE)
        ) {
            if let Ok(msg) = decode_message(&data) {
                prop_assert_eq!(encode_message(&msg), data);
            }
        }
    }
}

// =============================================================================
// 4. STRUCTURED EDGE-CASE / FUZZ TESTS
// =============================================================================

#[cfg(test)]
mod structured_fuzz_tests {
    use super::*;

    #[test]
    fn fuzz_message_boundaries() {
        let boundary_cases = vec![
            (MESSAGE_SIZE - 1, false), // Too short
            (MESSAGE_SIZE,     true ), // Exact size
            (MESSAGE_SIZE + 1, false), // Too long
        ];

        for (size, should_succeed) in boundary_cases {
            let data = vec![0u8; size];
            let result = decode_message(&data);

            if should_succeed {
                assert!(result.is_ok(), "Size {size} should decode successfully");
            } else {
                assert!(result.is_err(), "Size {size} should fail to decode");
            }
        }
    }

    #[test]
    fn fuzz_amount_edge_cases() {
        let edge_amounts = vec![
            0u128,
            1u128,
            u128::MAX - 1,
            u128::MAX,
            1_000_000_000_000_000_000u128, // Common 18-decimal token amount
        ];

        for amount in edge_amounts {
            let recipient = [0x42u8; 32];
            let msg = ShareBridgeMessage::new(recipient, amount);
            let encoded = encode_message(&msg);
            let decoded = decode_message(&encoded).unwrap();

            assert_eq!(decoded.amount, amount);
        }
    }

    #[test]
    fn fuzz_single_byte_mutation_changes_decoded_message() {
        let original_msg = ShareBridgeMessage::new([0xAB; 32], 42u128);
        let mut encoded = encode_message(&original_msg);

        // Flip every byte one by one and ensure the decoded message differs
        for i in 0..MESSAGE_SIZE {
            let mut mutated = encoded.clone();
            mutated[i] ^= 0x01; // toggle lowest bit

            // Decoding should succeed (size unchanged) but produce a different message
            let decoded = decode_message(&mutated).unwrap();
            assert_ne!(decoded, original_msg, "Byte index {i} mutation did not alter message");
        }
    }

    #[test]
    fn fuzz_malformed_messages() {
        let malformed_cases = vec![
            vec![],                          // Empty
            vec![0u8; 1],                    // Single byte
            vec![0u8; 16],                   // Half message
            vec![0u8; 31],                   // Almost recipient
            vec![0u8; 32],                   // Just recipient
            vec![0u8; 47],                   // Almost complete
            vec![0u8; 49],                   // Too long by 1
            vec![0u8; 100],                  // Much too long
            vec![0xFFu8; MESSAGE_SIZE],      // All 0xFF – formally correct length
            vec![0x00u8; MESSAGE_SIZE],      // All zeros
        ];

        for data in malformed_cases {
            let result = decode_message(&data);
            if data.len() == MESSAGE_SIZE {
                assert!(result.is_ok(), "Valid-sized message should decode");
            } else {
                assert!(result.is_err(), "Invalid-sized message should fail");
            }
        }
    }

    #[test]
    fn fuzz_decimal_conversion_edge_cases() {
        let test_cases = vec![
            (0, 0, 0, Some(0)),
            (0, 18, 6, Some(0)),
            (1, 18, 6, None),                          // Dust
            (999_999_999_999, 18, 6, None),           // Dust
            (1_000_000_000_000, 18, 6, Some(1)),      // Minimum non-dust
            (u128::MAX, 0, 1, None),                  // Overflow
            (u128::MAX / 10, 0, 1, Some((u128::MAX / 10) * 10)), // Just fits
        ];

        for (amount, from_decimals, to_decimals, expected) in test_cases {
            let result = ShareBridgeMessage::convert_amount_decimals(
                amount, from_decimals, to_decimals
            );
            assert_eq!(result, expected, "Failed for amount={amount}, from={from_decimals}, to={to_decimals}");
        }
    }
}

// =============================================================================
// 5. CODEC-SPECIFIC INVARIANT TESTS (Proptest)
// =============================================================================

#[cfg(test)]
mod codec_invariant_tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn prop_decimal_conversion_never_creates_value(
            amount        in 1u128..(u128::MAX / 1000),
            from_decimals in 0u8..=18,
            to_decimals   in 0u8..=18
        ) {
            if let Some(converted) = ShareBridgeMessage::convert_amount_decimals(amount, from_decimals, to_decimals) {
                // Scaling down should never increase value.
                if from_decimals > to_decimals {
                    prop_assert!(converted <= amount, "Scaling down created value: {amount} -> {converted}");
                }

                // Scaling up must match deterministic multiplication.
                if to_decimals > from_decimals {
                    let scale_factor = 10u128.pow((to_decimals - from_decimals) as u32);
                    prop_assert_eq!(converted, amount.saturating_mul(scale_factor));
                }
            }
        }

        #[test]
        fn prop_precision_loss_is_bounded(
            amount        in 1_000_000_000_000u128..(u128::MAX / 1000),
            from_decimals in 6u8..=18,
            to_decimals   in 0u8..6
        ) {
            if let Some(converted) = ShareBridgeMessage::convert_amount_decimals(amount, from_decimals, to_decimals) {
                if let Some(back_converted) = ShareBridgeMessage::convert_amount_decimals(converted, to_decimals, from_decimals) {
                    let precision_loss = amount - back_converted;
                    let max_loss = 10u128.pow((from_decimals - to_decimals) as u32) - 1;
                    prop_assert!(precision_loss <= max_loss, "Precision loss {precision_loss} exceeds maximum {max_loss}");
                }
            }
        }

        #[test]
        fn prop_evm_address_validation_consistency(address in any::<[u8; 32]>()) {
            let is_valid = ShareBridgeMessage::is_valid_padded_evm_address(&address);

            if is_valid {
                prop_assert!(address[0..12].iter().all(|&b| b == 0), "Invalid padding");
                prop_assert!(!address.iter().all(|&b| b == 0), "Zero address marked as valid");
            }

            let has_correct_padding = address[0..12].iter().all(|&b| b == 0);
            let is_zero_address      = address.iter().all(|&b| b == 0);

            if has_correct_padding && !is_zero_address {
                prop_assert!(is_valid, "Should be valid with correct padding and non-zero");
            }
        }
    }
} 