//! Teller module - Handles exchange rate calculations, token transfers, and share calculations
//!
//! This module provides utilities for:
//! - Validating token accounts
//! - Calculating shares for deposits/withdrawals
//! - Managing token transfers
//! - Computing exchange rates

use crate::OracleSource; // enum declared in state.rs
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use rust_decimal::Decimal;
use switchboard_on_demand::on_demand::accounts::pull_feed::PullFeedAccountData;

// Internal modules
use super::math;
use crate::{constants::*, AssetData, BoringErrorCode, BoringVault, DepositArgs, WithdrawArgs};

use math::{from_decimal, to_decimal};

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

    require_keys_eq!(
        *user_ata,
        expected_user_ata,
        BoringErrorCode::InvalidAssociatedTokenAccount
    );
    require_keys_eq!(
        *vault_ata,
        expected_vault_ata,
        BoringErrorCode::InvalidAssociatedTokenAccount
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
                mint,
                to,
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
                mint,
                to,
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
        let price = read_oracle(
            asset_data.oracle_source.clone(),
            price_feed,
            asset_data.max_staleness,
        )?;

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
        from_decimal(assets_out_in_base, asset_decimals)?
    } else {
        // Query price feed.
        let price = read_oracle(
            asset_data.oracle_source.clone(),
            price_feed,
            asset_data.max_staleness,
        )?;

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
        let exchange_rate = to_decimal(
            boring_vault_state.teller.exchange_rate,
            boring_vault_state.teller.decimals,
        )?;

        // Query price feed.
        let price = read_oracle(
            asset_data.oracle_source.clone(),
            price_feed,
            asset_data.max_staleness,
        )?;

        // price[base/asset]
        // exchange_rate[base/share]
        // want asset/share =  exchange_rate[base/share] / price[base/asset]
        let rate = if asset_data.inverse_price_feed {
            // Multiply instead since we need to inverse price feed.
            exchange_rate
                .checked_mul(price)
                .ok_or(error!(BoringErrorCode::MathError))?
        } else {
            exchange_rate
                .checked_div(price)
                .ok_or(error!(BoringErrorCode::MathError))?
        };

        // Scale rate to quote decimals.
        let rate = from_decimal(rate, quote.decimals)?;

        Ok(rate)
    }
}

// ================================ Internal Helper Functions ================================

/// Reads the oracle with parameter extraction, address validation, and confidence validation
fn read_oracle(
    oracle_source: OracleSource,
    price_feed: AccountInfo,
    max_staleness: u64,
) -> Result<Decimal> {
    match oracle_source {
        OracleSource::SwitchboardV2 { feed_address, min_samples } => {
            // Validate that the provided account matches the expected feed address
            require!(
                price_feed.key() == feed_address,
                BoringErrorCode::InvalidPriceFeed
            );

            let feed_account = price_feed.data.borrow();
            let feed = PullFeedAccountData::parse(feed_account)
                .map_err(|_| error!(BoringErrorCode::InvalidPriceFeed))?;

            let price = feed
                .get_value(&Clock::get()?, max_staleness, min_samples, true)
                .map_err(|_| error!(BoringErrorCode::InvalidPriceFeed))?;
            Ok(price)
        }
        OracleSource::PythV2 { feed_id, max_conf_width_bps } => {
            // Decode Pyth Pull Oracle price update account
            let price_update_account =
                PriceUpdateV2::try_deserialize(&mut price_feed.data.borrow().as_ref())
                    .map_err(|_| error!(BoringErrorCode::InvalidPriceFeed))?;

            // Validate that the provided account contains the expected feed_id
            require!(
                price_update_account.price_message.feed_id == feed_id,
                BoringErrorCode::InvalidPriceFeed
            );

            // Convert slot staleness threshold to seconds using pure math function
            let max_age_sec = math::slots_to_seconds(max_staleness);

            // Get price with feed_id validation
            let price_data = price_update_account
                .get_price_no_older_than(&Clock::get()?, max_age_sec, &feed_id)
                .map_err(|_| error!(BoringErrorCode::InvalidPriceFeed))?;

            if price_data.price <= 0 {
                return Err(error!(BoringErrorCode::InvalidPriceFeed));
            }

            // Verify confidence is within acceptable bounds
            let max_allowed_conf = (price_data.price as u64)
                .checked_mul(max_conf_width_bps as u64)
                .ok_or(error!(BoringErrorCode::InvalidPriceFeed))?
                .checked_div(BPS_SCALE as u64)
                .ok_or(error!(BoringErrorCode::InvalidPriceFeed))?;

            if price_data.conf as u64 > max_allowed_conf {
                return Err(error!(BoringErrorCode::InvalidPriceFeed));
            }

            // Convert to decimal using pure math function
            let decimal_price = math::pyth_price_to_decimal(price_data.price, price_data.exponent)?;
            Ok(decimal_price)
        }
    }
}

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
    let shares_to_mint = deposit_amount
        .checked_div(exchange_rate)
        .ok_or(error!(BoringErrorCode::MathError))?;
    let shares_to_mint = math::apply_share_premium(shares_to_mint, share_premium_bps)?;

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

    let asset_price = math::apply_price_inversion(asset_price, inverse_price_feed)?;

    // Calculate shares_to_mint = deposit_amount[asset] * asset_price[base/asset] / exchange_rate[base/share]
    let shares_to_mint = deposit_amount
        .checked_mul(asset_price)
        .ok_or(error!(BoringErrorCode::MathError))?
        .checked_div(exchange_rate)
        .ok_or(error!(BoringErrorCode::MathError))?;
    let shares_to_mint = math::apply_share_premium(shares_to_mint, share_premium_bps)?;

    // Scale up shares to mint by share decimals.
    let shares_to_mint = from_decimal(shares_to_mint, share_decimals)?;

    Ok(shares_to_mint)
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
    let assets_out = share_amount
        .checked_mul(exchange_rate)
        .ok_or(error!(BoringErrorCode::MathError))?;

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

    // Calculate assets_out = share_amount[share] * exchange_rate[base/share] / asset_price[base/asset]
    let assets_out = if inverse_price_feed {
        // Price feed is inversed, so multiply instead of divide
        share_amount
            .checked_mul(exchange_rate)
            .ok_or(error!(BoringErrorCode::MathError))?
            .checked_mul(asset_price)
            .ok_or(error!(BoringErrorCode::MathError))?
    } else {
        share_amount
            .checked_mul(exchange_rate)
            .ok_or(error!(BoringErrorCode::MathError))?
            .checked_div(asset_price)
            .ok_or(error!(BoringErrorCode::MathError))?
    };

    // Scale up assets out by withdraw asset decimals.
    let assets_out = from_decimal(assets_out, withdraw_asset_decimals)?;

    Ok(assets_out)
}
