//! Utility functions for the Boring Queue program
//!
//! This module provides:
//! - Decimal conversion utilities for precise number handling
//! - Token account validation functions
//! - Token transfer helpers with CPI support

use crate::QueueErrorCode;
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_interface::{self},
};
use rust_decimal::Decimal;

/// Converts a value to a Decimal with specified decimal places
///
/// # Arguments
/// * `amount` - The value to convert
/// * `decimals` - Number of decimal places
///
/// # Returns
/// * `Result<Decimal>` - The converted decimal value
///
/// # Errors
/// * Returns error if decimal conversion fails
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
///
/// # Returns
/// * `Result<T>` - The converted value in the target type
///
/// # Errors
/// * Returns `QueueErrorCode::DecimalConversionFailed` if conversion fails
pub fn from_decimal<T: TryFrom<Decimal>>(decimal: Decimal, decimals: u8) -> Result<T> {
    decimal
        .checked_mul(Decimal::from(10u64.pow(decimals as u32)))
        .unwrap()
        .try_into()
        .map_err(|_| error!(QueueErrorCode::DecimalConversionFailed))
}

/// Validates that the provided token accounts match their expected PDAs
///
/// # Arguments
/// * `token` - The token mint public key
/// * `token_program` - The token program ID
/// * `user` - The user's wallet public key
/// * `user_ata` - The user's associated token account to validate
///
/// # Returns
/// * `Result<()>` - Ok if validation passes
///
/// # Errors
/// * Returns `QueueErrorCode::InvalidTokenAccount` if validation fails
pub fn validate_associated_token_accounts(
    token: &Pubkey,
    token_program: &Pubkey,
    user: &Pubkey,
    user_ata: &Pubkey,
) -> Result<()> {
    let expected_user_ata =
        get_associated_token_address_with_program_id(user, token, token_program);

    require!(
        user_ata == &expected_user_ata,
        QueueErrorCode::InvalidTokenAccount
    );

    Ok(())
}

/// Transfers tokens to a destination using a PDA signer
///
/// # Arguments
/// * `token_program` - The token program account
/// * `from` - Source token account
/// * `to` - Destination token account
/// * `mint` - Token mint account
/// * `authority` - Account with authority to transfer
/// * `amount` - Amount of tokens to transfer
/// * `decimals` - Decimals of the token mint
/// * `seeds` - Seeds for PDA signing
///
/// # Returns
/// * `Result<()>` - Ok if transfer succeeds
///
/// # Errors
/// * Returns error if token transfer fails
pub fn transfer_tokens_to<'a>(
    token_program: AccountInfo<'a>,
    from: AccountInfo<'a>,
    to: AccountInfo<'a>,
    mint: AccountInfo<'a>,
    authority: AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            token_interface::TransferChecked {
                from,
                to,
                mint,
                authority,
            },
            seeds,
        ),
        amount,
        decimals,
    )
}
