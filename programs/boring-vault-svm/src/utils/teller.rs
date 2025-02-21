//! Teller module - Handles exchange rate calculations, token transfers, and share calculations
//!
//! This module provides utilities for:
//! - Converting between decimals and integers
//! - Validating token accounts
//! - Calculating shares for deposits/withdrawals
//! - Managing token transfers
//! - Computing exchange rates

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint};
use rust_decimal::Decimal;
use switchboard_on_demand::on_demand::accounts::pull_feed::PullFeedAccountData;

// Internal modules
use crate::{constants::*, AssetData, BoringErrorCode, BoringVault, DepositArgs, WithdrawArgs};

// ================================ Decimal Conversions ================================

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
        .unwrap()
        .try_into()
        .map_err(|_| error!(BoringErrorCode::DecimalConversionFailed))
}

// ================================ Validation Functions ================================

/// Validates state before deposit
pub fn before_deposit(is_paused: bool, allow_deposits: bool) -> Result<()> {
    require!(!is_paused, BoringErrorCode::VaultPaused);
    require!(allow_deposits, BoringErrorCode::AssetNotAllowed);
    Ok(())
}

/// Validates state before withdrawal
pub fn before_withdraw(is_paused: bool, allow_withdrawals: bool) -> Result<()> {
    require!(!is_paused, BoringErrorCode::VaultPaused);
    require!(allow_withdrawals, BoringErrorCode::AssetNotAllowed);
    Ok(())
}

/// Validates associated token accounts
///
/// # Arguments
/// * `token` - Token mint address
/// * `token_program` - Token program ID
/// * `user` - User's wallet address
/// * `vault` - Vault address
/// * `user_ata` - User's token account
/// * `vault_ata` - Vault's token account
pub fn validate_associated_token_accounts(
    token: &Pubkey,
    token_program: &Pubkey,
    user: &Pubkey,
    vault: &Pubkey,
    user_ata: &Pubkey,
    vault_ata: &Pubkey,
) -> Result<()> {
    // Validate ATAs by checking against derived PDAs
    let expected_user_ata =
        anchor_spl::associated_token::get_associated_token_address_with_program_id(
            user,
            token,
            token_program,
        );
    let expected_vault_ata =
        anchor_spl::associated_token::get_associated_token_address_with_program_id(
            vault,
            token,
            token_program,
        );

    require!(
        user_ata == &expected_user_ata,
        BoringErrorCode::InvalidTokenAccount
    );
    require!(
        vault_ata == &expected_vault_ata,
        BoringErrorCode::InvalidTokenAccount
    );

    Ok(())
}

// ================================ Token Transfer Functions ================================

/// Transfers tokens to a destination with signer seeds
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

/// Transfers tokens from a source
pub fn transfer_tokens_from<'a>(
    token_program: AccountInfo<'a>,
    from: AccountInfo<'a>,
    to: AccountInfo<'a>,
    mint: AccountInfo<'a>,
    authority: AccountInfo<'a>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            token_program,
            token_interface::TransferChecked {
                from,
                to,
                mint,
                authority,
            },
        ),
        amount,
        decimals,
    )
}

// ================================ Share Calculation Functions ================================

/// Calculates shares to mint and performs minting operation
pub fn calculate_shares_and_mint<'a>(
    is_base: bool,
    args: DepositArgs,
    exchange_rate: u64,
    share_decimals: u8,
    asset_decimals: u8,
    asset_data: Account<'_, AssetData>,
    price_feed: AccountInfo<'a>,
    token_2022: AccountInfo<'a>,
    share_mint: AccountInfo<'a>,
    user_shares: AccountInfo<'a>,
    boring_vault_state: AccountInfo<'a>,
    boring_vault_state_bump: u8,
) -> Result<u64> {
    let shares_to_mint = if is_base {
        calculate_shares_to_mint_using_base_asset(
            args.deposit_amount,
            exchange_rate,
            asset_decimals,
            share_decimals,
            asset_data.share_premium_bps,
        )?
    } else if asset_data.is_pegged_to_base_asset {
        // Asset is pegged to base asset, so just need to convert amount to be in terms of base asset decimals.
        let deposit_amount = to_decimal(args.deposit_amount, asset_decimals)?;
        let deposit_amount: u64 = from_decimal(deposit_amount, share_decimals)?;

        calculate_shares_to_mint_using_base_asset(
            deposit_amount,
            exchange_rate,
            // Use share_decimals since we converted deposit_amount to be in terms of share_decimals.
            share_decimals,
            share_decimals,
            asset_data.share_premium_bps,
        )?
    } else {
        // Query price feed.
        let feed_account = price_feed.data.borrow();
        let feed = PullFeedAccountData::parse(feed_account).unwrap();

        let price = match feed.value() {
            Some(value) => value,
            None => return Err(BoringErrorCode::InvalidPriceFeed.into()),
        };

        calculate_shares_to_mint_using_deposit_asset(
            args.deposit_amount,
            exchange_rate,
            price,
            asset_data.inverse_price_feed,
            asset_decimals,
            share_decimals,
            asset_data.share_premium_bps,
        )?
    };

    // Verify minimum shares
    require!(
        shares_to_mint >= args.min_mint_amount,
        BoringErrorCode::SlippageExceeded
    );

    // Mint shares to user
    token_interface::mint_to(
        CpiContext::new_with_signer(
            token_2022,
            token_interface::MintTo {
                mint: share_mint,
                to: user_shares,
                authority: boring_vault_state,
            },
            &[&[
                // PDA signer seeds for vault state
                BASE_SEED_BORING_VAULT_STATE,
                &args.vault_id.to_le_bytes()[..],
                &[boring_vault_state_bump],
            ]],
        ),
        shares_to_mint,
    )?;
    Ok(shares_to_mint)
}

/// Calculates assets to withdraw
pub fn calculate_assets_out<'a>(
    is_base: bool,
    args: WithdrawArgs,
    exchange_rate: u64,
    share_decimals: u8,
    asset_decimals: u8,
    asset_data: Account<'_, AssetData>,
    price_feed: AccountInfo<'a>,
) -> Result<u64> {
    let assets_out = if is_base {
        calculate_assets_out_in_base_asset(args.share_amount, exchange_rate, share_decimals)?
    } else if asset_data.is_pegged_to_base_asset {
        // Asset is pegged to base asset, so find assets out in base then scale assets out to be in terms of withdraw asset decimals.
        let assets_out_in_base =
            calculate_assets_out_in_base_asset(args.share_amount, exchange_rate, share_decimals)?;
        let assets_out_in_base = to_decimal(assets_out_in_base, share_decimals)?;
        let assets_out = from_decimal(assets_out_in_base, asset_decimals)?;

        assets_out
    } else {
        // Query price feed.
        let feed_account = price_feed.data.borrow();
        let feed = PullFeedAccountData::parse(feed_account).unwrap();

        let price = match feed.value() {
            Some(value) => value,
            None => return Err(BoringErrorCode::InvalidPriceFeed.into()),
        };

        calculate_assets_out_using_withdraw_asset(
            args.share_amount,
            exchange_rate,
            price,
            asset_data.inverse_price_feed,
            asset_decimals,
            share_decimals,
        )?
    };

    // Verify minimum assets
    require!(
        assets_out >= args.min_assets_amount,
        BoringErrorCode::SlippageExceeded
    );

    Ok(assets_out)
}

// ================================ Exchange Rate Functions ================================

/// Gets the current exchange rate
pub fn get_rate(boring_vault_state: Account<'_, BoringVault>) -> Result<u64> {
    Ok(boring_vault_state.teller.exchange_rate)
}

/// Gets the exchange rate in terms of quote asset
pub fn get_rate_in_quote(
    boring_vault_state: Account<'_, BoringVault>,
    quote: InterfaceAccount<'_, Mint>,
    asset_data: Account<'_, AssetData>,
    price_feed: AccountInfo,
) -> Result<u64> {
    if boring_vault_state.teller.base_asset == quote.key() {
        get_rate(boring_vault_state)
    } else if asset_data.is_pegged_to_base_asset {
        // Need to convert the exchange rate from share decimals to quote decimals.
        let exchange_rate = to_decimal(
            boring_vault_state.teller.exchange_rate,
            boring_vault_state.teller.decimals,
        )?;

        let rate = from_decimal(exchange_rate, quote.decimals)?;

        Ok(rate)
    } else {
        // Query price feed.
        let feed_account = price_feed.data.borrow();
        let feed = PullFeedAccountData::parse(feed_account).unwrap();

        let price = match feed.value() {
            Some(value) => value,
            None => return Err(BoringErrorCode::InvalidPriceFeed.into()),
        };

        let price = if asset_data.inverse_price_feed {
            Decimal::from(1).checked_div(price).unwrap() // 1 / price
        } else {
            price
        };

        let exchange_rate = to_decimal(
            boring_vault_state.teller.exchange_rate,
            boring_vault_state.teller.decimals,
        )?;

        // price[base/asset]
        // exchange_rate[base/share]
        // want asset/share =  exchange_rate[base/share] / price[base/asset]
        let rate = exchange_rate.checked_div(price).unwrap();

        // Scale rate to quote decimals.
        let rate = from_decimal(rate, quote.decimals)?;

        Ok(rate)
    }
}

// ================================ Internal Helper Functions ================================

/// Calculates shares to mint using base asset
fn calculate_shares_to_mint_using_base_asset(
    deposit_amount: u64,
    exchange_rate: u64,
    deposit_asset_decimals: u8, // Deploy uses base asset decimals for share decimals, so I only need 1 decimal here.
    share_decimals: u8,
    share_premium_bps: u16,
) -> Result<u64> {
    let deposit_amount = to_decimal(deposit_amount, deposit_asset_decimals)?;
    let exchange_rate = to_decimal(exchange_rate, share_decimals)?;

    // Calculate shares_to_mint = deposit_amount[base] / exchange_rate[base/share]
    let shares_to_mint = deposit_amount.checked_div(exchange_rate).unwrap();
    let shares_to_mint = factor_in_share_premium(shares_to_mint, share_premium_bps)?;

    // Scale up shares to mint by share decimals.
    let shares_to_mint = from_decimal(shares_to_mint, share_decimals)?;

    Ok(shares_to_mint)
}

/// Calculates shares to mint using deposit asset
fn calculate_shares_to_mint_using_deposit_asset(
    deposit_amount: u64,
    exchange_rate: u64,
    asset_price: Decimal,
    inverse_price_feed: bool,
    deposit_asset_decimals: u8,
    share_decimals: u8, // same as base decimals
    share_premium_bps: u16,
) -> Result<u64> {
    let deposit_amount = to_decimal(deposit_amount, deposit_asset_decimals)?;
    let exchange_rate = to_decimal(exchange_rate, share_decimals)?;

    let asset_price = if inverse_price_feed {
        Decimal::from(1).checked_div(asset_price).unwrap() // 1 / price
    } else {
        asset_price
    };

    // Calculate shares_to_mint = deposit_amount[asset] * asset_price[base/asset] / exchange_rate[base/share]
    let shares_to_mint = deposit_amount
        .checked_mul(asset_price)
        .unwrap()
        .checked_div(exchange_rate)
        .unwrap();
    let shares_to_mint = factor_in_share_premium(shares_to_mint, share_premium_bps)?;

    // Scale up shares to mint by share decimals.
    let shares_to_mint = from_decimal(shares_to_mint, share_decimals)?;

    Ok(shares_to_mint)
}

/// Applies share premium to calculated shares
fn factor_in_share_premium(shares_to_mint: Decimal, share_premium_bps: u16) -> Result<Decimal> {
    if share_premium_bps > 0 {
        let premium_bps = to_decimal(share_premium_bps, BPS_DECIMALS)?;
        let premium_amount = shares_to_mint.checked_mul(premium_bps).unwrap();
        Ok(shares_to_mint.checked_sub(premium_amount).unwrap())
    } else {
        Ok(shares_to_mint)
    }
}

/// Calculates assets to withdraw in base asset
fn calculate_assets_out_in_base_asset(
    share_amount: u64,
    exchange_rate: u64,
    decimals: u8, // same for base and shares
) -> Result<u64> {
    let share_amount = to_decimal(share_amount, decimals)?;
    let exchange_rate = to_decimal(exchange_rate, decimals)?;

    // Calculate assets_out = share_amount[share] * exchange_rate[base/share]
    let assets_out = share_amount.checked_mul(exchange_rate).unwrap();

    // Scale up assets out by decimals.
    let assets_out = from_decimal(assets_out, decimals)?;

    Ok(assets_out)
}

/// Calculates assets to withdraw using withdraw asset
fn calculate_assets_out_using_withdraw_asset(
    share_amount: u64,
    exchange_rate: u64,
    asset_price: Decimal,
    inverse_price_feed: bool,
    withdraw_asset_decimals: u8,
    share_decimals: u8,
) -> Result<u64> {
    let share_amount = to_decimal(share_amount, share_decimals)?;
    let exchange_rate = to_decimal(exchange_rate, share_decimals)?;

    let asset_price = if inverse_price_feed {
        Decimal::from(1).checked_div(asset_price).unwrap() // 1 / price
    } else {
        asset_price
    };

    // Calculate assets_out = share_amount[share] * exchange_rate[base/share] / asset_price[base/asset]
    let assets_out = share_amount
        .checked_mul(exchange_rate)
        .unwrap()
        .checked_div(asset_price)
        .unwrap();

    // Scale up assets out by withdraw asset decimals.
    let assets_out = from_decimal(assets_out, withdraw_asset_decimals)?;

    Ok(assets_out)
}
