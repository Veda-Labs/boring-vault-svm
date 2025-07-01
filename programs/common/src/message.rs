// -----------------------------------------------------------------------------
// Cross-chain compatible message codec for ShareBridge
// This codec uses fixed 32-byte recipient addresses (natural for Solana,
// padded for EVM) and u128 amounts to handle tokens with up to 27 decimals
// without precision loss.
// -----------------------------------------------------------------------------

// Message layout (matches struct field order):
// Offset →
// 0       32      48       56
// |------|-------|--------|
// | 32B  | 16B   | 8B     |
// |recip | amt   | vault  |
// |      |(u128) |  id    |
// |------|-------|--------|

use anchor_lang::prelude::*;

use crate::error::ShareBridgeCodecError;

pub const RECIPIENT_OFFSET: usize = 0;
pub const AMOUNT_OFFSET: usize = 32;
pub const VAULT_ID_OFFSET: usize = 48;
pub const MESSAGE_SIZE: usize = 56;

#[derive(Debug, Clone, PartialEq)]
pub struct ShareBridgeMessage {
    pub recipient: [u8; 32],
    pub amount: u128,
}

impl ShareBridgeMessage {
    pub fn new(recipient: [u8; 32], amount: u128) -> Self {
        Self { recipient, amount }
    }

    /// Helper to convert amount between different decimal representations
    /// Returns None if:
    /// - Arithmetic overflow would occur
    /// - The resulting amount would be zero (dust protection)
    #[must_use]
    pub fn convert_amount_decimals(
        amount: u128,
        from_decimals: u8,
        to_decimals: u8,
    ) -> Option<u128> {
        if from_decimals == to_decimals {
            return Some(amount);
        }

        let result = if from_decimals > to_decimals {
            // Scale down
            let divisor = 10u128.checked_pow((from_decimals - to_decimals) as u32)?;
            amount.checked_div(divisor)?
        } else {
            // Scale up
            let multiplier = 10u128.checked_pow((to_decimals - from_decimals) as u32)?;
            amount.checked_mul(multiplier)?
        };

        // Dust protection: don't allow zero amounts after conversion
        if result == 0 && amount > 0 {
            return None;
        }

        Some(result)
    }

    /// Validates if a 32-byte address is a correctly padded 20-byte EVM address.
    /// EVM addresses should be left-padded with 12 zero bytes.
    pub fn is_valid_padded_evm_address(address: &[u8; 32]) -> bool {
        // The first 12 bytes must be all zeros for correct padding.
        let padding = &address[0..12];
        let is_padded_correctly = padding.iter().all(|&byte| byte == 0);

        // The zero address is generally not a valid recipient.
        let is_zero_address = address.iter().all(|&byte| byte == 0);

        is_padded_correctly && !is_zero_address
    }
}

/// Encode a ShareBridgeMessage into bytes
pub fn encode_message(msg: &ShareBridgeMessage) -> Vec<u8> {
    let mut buffer = Vec::with_capacity(MESSAGE_SIZE);

    // Recipient (32 bytes) - first to match struct order
    buffer.extend_from_slice(&msg.recipient);

    // Amount (16 bytes, big endian)
    buffer.extend_from_slice(&msg.amount.to_be_bytes());

    buffer
}

/// Decode bytes into a ShareBridgeMessage
pub fn decode_message(data: &[u8]) -> Result<ShareBridgeMessage> {
    // Check exact length
    if data.len() != MESSAGE_SIZE {
        return Err(ShareBridgeCodecError::InvalidLength.into());
    }

    // Decode recipient
    let recipient: [u8; 32] = data[RECIPIENT_OFFSET..AMOUNT_OFFSET]
        .try_into()
        .map_err(|_| ShareBridgeCodecError::InvalidLength)?;

    // Decode amount (u128)
    let amount_bytes: [u8; 16] = data[AMOUNT_OFFSET..VAULT_ID_OFFSET]
        .try_into()
        .map_err(|_| ShareBridgeCodecError::InvalidLength)?;
    let amount = u128::from_be_bytes(amount_bytes);

    Ok(ShareBridgeMessage { recipient, amount })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode_roundtrip() {
        // Test basic encoding/decoding
        let recipient = [0x11u8; 32];
        let amount = 1_000_000_000_000_000_000u128; // 1 token with 18 decimals
        let msg = ShareBridgeMessage::new(recipient, amount);

        let encoded = encode_message(&msg);
        assert_eq!(encoded.len(), MESSAGE_SIZE);

        let decoded = decode_message(&encoded).unwrap();
        assert_eq!(decoded, msg);
        assert_eq!(decoded.recipient, recipient);
        assert_eq!(decoded.amount, amount);
    }

    #[test]
    fn test_message_field_ordering() {
        // Verify the exact byte layout
        let mut recipient = [0u8; 32];
        recipient[0] = 0xAA;
        recipient[31] = 0xBB;

        let amount = 0x1234567890ABCDEFu128;

        let msg = ShareBridgeMessage::new(recipient, amount);
        let encoded = encode_message(&msg);

        // Check recipient bytes
        assert_eq!(encoded[0], 0xAA);
        assert_eq!(encoded[31], 0xBB);

        // Check amount bytes (big endian)
        let amount_bytes = &encoded[32..48];
        assert_eq!(
            u128::from_be_bytes(amount_bytes.try_into().unwrap()),
            amount
        );
    }

    #[test]
    fn test_max_values() {
        // Test with maximum values
        let recipient = [0xFFu8; 32];
        let amount = u128::MAX;

        let msg = ShareBridgeMessage::new(recipient, amount);
        let encoded = encode_message(&msg);
        let decoded = decode_message(&encoded).unwrap();

        assert_eq!(decoded.amount, u128::MAX);
    }

    #[test]
    fn test_invalid_message_length() {
        // Too short
        let short_data = vec![0u8; MESSAGE_SIZE - 1];
        assert!(matches!(
            decode_message(&short_data),
            Err(err) if err == ShareBridgeCodecError::InvalidLength.into()
        ));

        // Too long
        let long_data = vec![0u8; MESSAGE_SIZE + 1];
        assert!(matches!(
            decode_message(&long_data),
            Err(err) if err == ShareBridgeCodecError::InvalidLength.into()
        ));
    }

    // Decimal conversion tests
    #[test]
    fn test_decimal_conversion_same_decimals() {
        let amount = 123_456_789u128;
        assert_eq!(
            ShareBridgeMessage::convert_amount_decimals(amount, 9, 9),
            Some(amount)
        );
    }

    #[test]
    fn test_decimal_conversion_scale_down() {
        // 1 token: 18 decimals to 6 decimals
        let amount_18 = 1_000_000_000_000_000_000u128;
        let amount_6 = ShareBridgeMessage::convert_amount_decimals(amount_18, 18, 6).unwrap();
        assert_eq!(amount_6, 1_000_000u128);

        // 1.5 tokens: 18 decimals to 9 decimals
        let amount_18_2 = 1_500_000_000_000_000_000u128;
        let amount_9 = ShareBridgeMessage::convert_amount_decimals(amount_18_2, 18, 9).unwrap();
        assert_eq!(amount_9, 1_500_000_000u128);
    }

    #[test]
    fn test_decimal_conversion_scale_up() {
        // 1 USDC (6 decimals) to 18 decimals
        let usdc_amount = 1_000_000u128;
        let amount_18 = ShareBridgeMessage::convert_amount_decimals(usdc_amount, 6, 18).unwrap();
        assert_eq!(amount_18, 1_000_000_000_000_000_000u128);

        // 0.5 tokens: 9 decimals to 18 decimals
        let amount_9 = 500_000_000u128;
        let amount_18_2 = ShareBridgeMessage::convert_amount_decimals(amount_9, 9, 18).unwrap();
        assert_eq!(amount_18_2, 500_000_000_000_000_000u128);
    }

    #[test]
    fn test_decimal_conversion_precision_loss() {
        // Converting 0.123456789 (18 decimals) to 6 decimals loses precision
        let amount_18 = 123_456_789_000_000_000u128;
        let amount_6 = ShareBridgeMessage::convert_amount_decimals(amount_18, 18, 6).unwrap();
        assert_eq!(amount_6, 123_456u128); // Only 0.123456 remains
    }

    #[test]
    fn test_decimal_conversion_dust_protection() {
        // Amount too small to convert (would become 0)
        let dust_18 = 999_999_999_999u128; // Less than 0.000001 token
        let result = ShareBridgeMessage::convert_amount_decimals(dust_18, 18, 6);
        assert_eq!(result, None); // Rejected as dust

        // Zero amount always converts to zero
        assert_eq!(
            ShareBridgeMessage::convert_amount_decimals(0, 18, 6),
            Some(0)
        );
    }

    #[test]
    fn test_decimal_conversion_overflow_protection() {
        // Test overflow when scaling up
        let large_amount = u128::MAX / 10;
        assert!(ShareBridgeMessage::convert_amount_decimals(large_amount, 6, 18).is_none());

        // Test maximum safe conversion
        let max_safe = u128::MAX / 10u128.pow(12); // Safe for 6->18 conversion
        assert!(ShareBridgeMessage::convert_amount_decimals(max_safe, 6, 18).is_some());
    }

    #[test]
    fn test_cross_chain_decimal_conversion_roundtrip() {
        // Simulate sending 1 token (with 6 decimals) to a chain with 18 decimals
        let local_amount_6_decimals = 1_000_000u128;
        let local_decimals = 6;
        let peer_decimals = 18;

        // 1. SEND LOGIC: Convert local amount to peer's decimals for the message
        let amount_for_message = ShareBridgeMessage::convert_amount_decimals(
            local_amount_6_decimals,
            local_decimals,
            peer_decimals,
        )
        .unwrap();

        // The amount in the message should be 1 token at 18 decimals
        assert_eq!(amount_for_message, 1_000_000_000_000_000_000u128);

        // 2. RECEIVE LOGIC: Convert the amount from the message back to local decimals
        let received_amount = ShareBridgeMessage::convert_amount_decimals(
            amount_for_message,
            peer_decimals,
            local_decimals,
        )
        .unwrap();

        // The final amount should match the original local amount
        assert_eq!(received_amount, local_amount_6_decimals);
    }
}

#[test]
fn test_evm_address_validation() {
    // Valid padded EVM address
    let mut valid_evm_addr = [0u8; 32];
    valid_evm_addr[12..].copy_from_slice(&[0x11; 20]);
    assert!(ShareBridgeMessage::is_valid_padded_evm_address(
        &valid_evm_addr
    ));

    // Invalid: Non-zero padding
    let mut invalid_padding_addr = [0u8; 32];
    invalid_padding_addr[0] = 0x01; // Non-zero byte in padding
    invalid_padding_addr[12..].copy_from_slice(&[0x11; 20]);
    assert!(!ShareBridgeMessage::is_valid_padded_evm_address(
        &invalid_padding_addr
    ));

    // Invalid: Solana-style address (no zero padding)
    let solana_addr = [0x22u8; 32];
    assert!(!ShareBridgeMessage::is_valid_padded_evm_address(
        &solana_addr
    ));

    // Invalid: Zero address
    let zero_addr = [0u8; 32];
    assert!(!ShareBridgeMessage::is_valid_padded_evm_address(&zero_addr));

    // Valid: Another valid address with data in the last byte
    let mut another_valid_addr = [0u8; 32];
    another_valid_addr[31] = 0xFF;
    assert!(ShareBridgeMessage::is_valid_padded_evm_address(
        &another_valid_addr
    ));
}
