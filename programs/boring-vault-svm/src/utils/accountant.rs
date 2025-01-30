use anchor_lang::prelude::*;
use rust_decimal::Decimal;

pub fn calculate_shares_to_mint_using_base_asset(
    deposit_amount: u64,
    exchange_rate: u64,
    deposit_asset_decimals: u8,
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

pub fn calculate_shares_to_mint_using_deposit_asset(
    deposit_amount: u64,
    exchange_rate: u64,
    asset_price: Decimal,
    inverse_price_feed: bool,
    deposit_asset_decimals: u8,
    share_decimals: u8,
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
