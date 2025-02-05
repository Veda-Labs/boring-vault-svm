use crate::constants::*;
use crate::BoringErrorCode;
use crate::{AssetData, BoringVault};
use crate::{DepositArgs, WithdrawArgs};
use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use anchor_spl::token_interface::Mint;
use rust_decimal::Decimal;
use switchboard_on_demand::on_demand::accounts::pull_feed::PullFeedAccountData;

pub fn before_deposit(is_paused: bool, allow_deposits: bool) -> Result<()> {
    require!(!is_paused, BoringErrorCode::VaultPaused);
    require!(allow_deposits, BoringErrorCode::AssetNotAllowed);
    Ok(())
}

pub fn before_withdraw(is_paused: bool, allow_withdrawals: bool) -> Result<()> {
    require!(!is_paused, BoringErrorCode::VaultPaused);
    require!(allow_withdrawals, BoringErrorCode::AssetNotAllowed);
    Ok(())
}

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
        let mut deposit_amount = Decimal::from(args.deposit_amount);
        deposit_amount.set_scale(asset_decimals as u32).unwrap();
        // Convert to base asset decimals, which is share decimals.
        deposit_amount = deposit_amount
            .checked_mul(Decimal::from(10u64.pow(share_decimals as u32)))
            .unwrap();

        let deposit_amount: u64 = deposit_amount.try_into().unwrap();

        calculate_shares_to_mint_using_base_asset(
            deposit_amount,
            exchange_rate,
            asset_decimals,
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
        let mut assets_out_in_base = Decimal::from(assets_out_in_base);
        assets_out_in_base.set_scale(share_decimals as u32).unwrap();
        let assets_out = assets_out_in_base
            .checked_mul(Decimal::from(10u64.pow(asset_decimals as u32)))
            .unwrap();
        let assets_out: u64 = assets_out.try_into().unwrap();

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

pub fn get_rate(boring_vault_state: Account<'_, BoringVault>) -> Result<u64> {
    Ok(boring_vault_state.teller.exchange_rate)
}

pub fn get_rate_in_quote(
    boring_vault_state: Account<'_, BoringVault>,
    quote: InterfaceAccount<'_, Mint>,
    asset_data: Account<'_, AssetData>,
    price_feed: AccountInfo,
) -> Result<u64> {
    if boring_vault_state.teller.base_asset == quote.key() {
        get_rate(boring_vault_state)
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

        let mut exchange_rate = Decimal::from(boring_vault_state.teller.exchange_rate);
        exchange_rate
            .set_scale(boring_vault_state.teller.decimals as u32)
            .unwrap();
        // price[base/asset]
        // exchange_rate[base/share]
        // want asset/share =  exchange_rate[base/share] / price[base/asset]
        let rate = exchange_rate.checked_div(price).unwrap();

        // Scale rate to quote decimals.
        let rate = rate
            .checked_mul(Decimal::from(10u64.pow(quote.decimals as u32)))
            .unwrap();
        Ok(rate.try_into().unwrap())
    }
}

fn calculate_shares_to_mint_using_base_asset(
    deposit_amount: u64,
    exchange_rate: u64,
    deposit_asset_decimals: u8, // Deploy uses base asset decimals for share decimals, so I only need 1 decimal here.
    share_decimals: u8,
    share_premium_bps: u16,
) -> Result<u64> {
    let mut deposit_amount = Decimal::from(deposit_amount);
    deposit_amount
        .set_scale(deposit_asset_decimals as u32)
        .unwrap();
    let mut exchange_rate = Decimal::from(exchange_rate);
    exchange_rate.set_scale(share_decimals as u32).unwrap();

    // Calculate shares_to_mint = deposit_amount[base] / exchange_rate[base/share]
    let shares_to_mint = deposit_amount.checked_div(exchange_rate).unwrap();
    let shares_to_mint = factor_in_share_premium(shares_to_mint, share_premium_bps)?;

    // Scale up shares to mint by share decimals.
    let shares_to_mint = shares_to_mint
        .checked_mul(Decimal::from(10u64.pow(share_decimals as u32)))
        .unwrap();

    let shares_to_mint: u64 = shares_to_mint.try_into().unwrap();
    Ok(shares_to_mint)
}

fn calculate_shares_to_mint_using_deposit_asset(
    deposit_amount: u64,
    exchange_rate: u64,
    asset_price: Decimal,
    inverse_price_feed: bool,
    deposit_asset_decimals: u8,
    share_decimals: u8, // same as base decimals
    share_premium_bps: u16,
) -> Result<u64> {
    let mut deposit_amount = Decimal::from(deposit_amount);
    deposit_amount
        .set_scale(deposit_asset_decimals as u32)
        .unwrap();
    let mut exchange_rate = Decimal::from(exchange_rate);
    exchange_rate.set_scale(share_decimals as u32).unwrap();

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
    let shares_to_mint = shares_to_mint
        .checked_mul(Decimal::from(10u64.pow(share_decimals as u32)))
        .unwrap();

    let shares_to_mint: u64 = shares_to_mint.try_into().unwrap();
    Ok(shares_to_mint)
}

fn factor_in_share_premium(shares_to_mint: Decimal, share_premium_bps: u16) -> Result<Decimal> {
    if share_premium_bps > 0 {
        let mut premium_bps = Decimal::from(share_premium_bps);
        premium_bps.set_scale(4).unwrap();
        let premium_amount = shares_to_mint.checked_mul(premium_bps).unwrap();
        Ok(shares_to_mint.checked_sub(premium_amount).unwrap())
    } else {
        Ok(shares_to_mint)
    }
}

fn calculate_assets_out_in_base_asset(
    share_amount: u64,
    exchange_rate: u64,
    decimals: u8, // same for base and shares
) -> Result<u64> {
    let mut share_amount = Decimal::from(share_amount);
    share_amount.set_scale(decimals as u32).unwrap();
    let mut exchange_rate = Decimal::from(exchange_rate);
    exchange_rate.set_scale(decimals as u32).unwrap();

    // Calculate assets_out = share_amount[share] * exchange_rate[base/share]
    let assets_out = share_amount.checked_mul(exchange_rate).unwrap();

    // Scale up assets out by decimals.
    let assets_out = assets_out
        .checked_mul(Decimal::from(10u64.pow(decimals as u32)))
        .unwrap();

    let assets_out: u64 = assets_out.try_into().unwrap();
    Ok(assets_out)
}

fn calculate_assets_out_using_withdraw_asset(
    share_amount: u64,
    exchange_rate: u64,
    asset_price: Decimal,
    inverse_price_feed: bool,
    withdraw_asset_decimals: u8,
    share_decimals: u8,
) -> Result<u64> {
    let mut share_amount = Decimal::from(share_amount);
    share_amount.set_scale(share_decimals as u32).unwrap();
    let mut exchange_rate = Decimal::from(exchange_rate);
    exchange_rate.set_scale(share_decimals as u32).unwrap();

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
    let assets_out = assets_out
        .checked_mul(Decimal::from(10u64.pow(withdraw_asset_decimals as u32)))
        .unwrap();

    let assets_out: u64 = assets_out.try_into().unwrap();
    Ok(assets_out)
}
