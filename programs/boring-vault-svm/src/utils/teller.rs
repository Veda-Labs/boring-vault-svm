use crate::accountant;
use crate::constants::*;
use crate::AssetData;
use crate::BoringErrorCode;
use crate::DepositArgs;
use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use rust_decimal::Decimal;
use switchboard_on_demand::on_demand::accounts::pull_feed::PullFeedAccountData;

pub fn before_deposit(is_paused: bool, allow_deposits: bool) -> Result<()> {
    require!(!is_paused, BoringErrorCode::VaultPaused);
    require!(allow_deposits, BoringErrorCode::AssetNotAllowed);
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
) -> Result<()> {
    let shares_to_mint = if is_base {
        accountant::calculate_shares_to_mint_using_base_asset(
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

        accountant::calculate_shares_to_mint_using_base_asset(
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

        accountant::calculate_shares_to_mint_using_deposit_asset(
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
    Ok(())
}
