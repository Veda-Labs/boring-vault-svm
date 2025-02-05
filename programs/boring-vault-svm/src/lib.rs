#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
mod state;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
pub use state::*;
mod error;
use error::*;
mod constants;
pub use constants::*;
mod utils;
use rust_decimal::Decimal;
use utils::teller;

declare_id!("26YRHAHxMa569rQ73ifQDV9haF7Njcm3v7epVPvcpJsX");

// Good resources for figuring out how to setup extensions
// https://github.com/solana-developers/program-examples/tree/main/tokens/token-2022/transfer-hook/whitelist/anchor
// https://www.quicknode.com/guides/solana-development/anchor/token-2022

#[program]
pub mod boring_vault_svm {
    use super::*;

    // =============================== Program Functions ===============================

    /// Initializes the program config with the given authority
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `authority` - The pubkey of the authority who can deploy vaults
    ///
    /// # Returns
    /// * `Result<()>` - Result indicating success or failure
    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.vault_count = 0;
        Ok(())
    }

    /// Deploys a new vault instance
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `args` - Deployment arguments including:
    ///     * `authority` - The vault authority who can manage vault settings
    ///     * `base_asset` - The base asset mint address for the vault
    ///     * `exchange_rate_provider` - Provider of exchange rates
    ///     * `exchange_rate` - Initial exchange rate between base asset and shares
    ///     * `strategist` - Address of the strategist who can execute vault strategies
    ///     * `payout_address` - Address where fees will be sent
    ///     * `decimals` - Decimals for the share token mint
    ///     * `allowed_exchange_rate_change_upper_bound` - Maximum allowed increase in exchange rate (in bps)
    ///     * `allowed_exchange_rate_change_lower_bound` - Maximum allowed decrease in exchange rate (in bps)
    ///     * `minimum_update_delay_in_seconds` - Minimum time between exchange rate updates
    ///     * `platform_fee_bps` - Platform fee in basis points
    ///     * `performance_fee_bps` - Performance fee in basis points
    ///
    /// # Errors
    /// * `BoringErrorCode::InvalidExchangeRateProvider` - If exchange rate provider is zero address
    /// * `BoringErrorCode::InvalidPayoutAddress` - If payout address is zero address
    /// * `BoringErrorCode::InvalidAllowedExchangeRateChangeUpperBound` - If upper bound is invalid
    /// * `BoringErrorCode::InvalidAllowedExchangeRateChangeLowerBound` - If lower bound is invalid
    /// * `BoringErrorCode::InvalidPlatformFeeBps` - If platform fee exceeds maximum
    /// * `BoringErrorCode::InvalidPerformanceFeeBps` - If performance fee exceeds maximum
    pub fn deploy(ctx: Context<Deploy>, args: DeployArgs) -> Result<()> {
        // Make sure the signer is the authority.
        require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.config.authority);

        // Make sure the authority is not the zero address.
        require_keys_neq!(args.authority, Pubkey::default());

        // Initialize vault.
        let vault = &mut ctx.accounts.boring_vault_state;

        // Initialize vault state.
        vault.config.vault_id = ctx.accounts.config.vault_count;
        vault.config.authority = args.authority;
        vault.config.share_mint = ctx.accounts.share_mint.key();
        vault.config.paused = false;

        // Initialize teller state.
        vault.teller.base_asset = ctx.accounts.base_asset.key();
        if args.exchange_rate_provider == Pubkey::default() {
            return Err(BoringErrorCode::InvalidExchangeRateProvider.into());
        }
        vault.teller.decimals = ctx.accounts.base_asset.decimals;
        vault.teller.exchange_rate_provider = args.exchange_rate_provider;
        vault.teller.exchange_rate = args.exchange_rate;
        vault.teller.exchange_rate_high_water_mark = args.exchange_rate;
        vault.teller.fees_owed_in_base_asset = 0;
        vault.teller.total_shares_last_update = ctx.accounts.share_mint.supply;
        vault.teller.last_update_timestamp = ctx.accounts.clock.unix_timestamp as u64;
        if args.payout_address == Pubkey::default() {
            return Err(BoringErrorCode::InvalidPayoutAddress.into());
        }
        vault.teller.payout_address = args.payout_address;
        if args.allowed_exchange_rate_change_upper_bound
            > MAXIMUM_ALLOWED_EXCHANGE_RATE_CHANGE_UPPER_BOUND
            || args.allowed_exchange_rate_change_upper_bound < BPS_SCALE
        {
            return Err(BoringErrorCode::InvalidAllowedExchangeRateChangeUpperBound.into());
        }
        vault.teller.allowed_exchange_rate_change_upper_bound =
            args.allowed_exchange_rate_change_upper_bound;
        if args.allowed_exchange_rate_change_lower_bound
            < MAXIMUM_ALLOWED_EXCHANGE_RATE_CHANGE_LOWER_BOUND
            || args.allowed_exchange_rate_change_lower_bound > BPS_SCALE
        {
            return Err(BoringErrorCode::InvalidAllowedExchangeRateChangeLowerBound.into());
        }
        vault.teller.allowed_exchange_rate_change_lower_bound =
            args.allowed_exchange_rate_change_lower_bound;
        vault.teller.minimum_update_delay_in_seconds = args.minimum_update_delay_in_seconds;
        if args.platform_fee_bps > MAXIMUM_PLATFORM_FEE_BPS {
            return Err(BoringErrorCode::InvalidPlatformFeeBps.into());
        }
        vault.teller.platform_fee_bps = args.platform_fee_bps;
        if args.performance_fee_bps > MAXIMUM_PERFORMANCE_FEE_BPS {
            return Err(BoringErrorCode::InvalidPerformanceFeeBps.into());
        }
        vault.teller.performance_fee_bps = args.performance_fee_bps;

        // Set withdraw_authority, if default, then withdraws are permissionless
        vault.teller.withdraw_authority = args.withdraw_authority;

        // Initialize manager state.
        vault.manager.strategist = args.strategist;

        // Update program config.
        ctx.accounts.config.vault_count += 1;

        msg!(
            "Boring Vault deployed successfully with share token {}",
            ctx.accounts.share_mint.key()
        );
        Ok(())
    }

    // =============================== Authority Functions ===============================

    pub fn pause(ctx: Context<Pause>, vault_id: u64) -> Result<()> {
        ctx.accounts.boring_vault_state.config.paused = true;
        msg!("Vault {} paused", vault_id);
        Ok(())
    }

    pub fn unpause(ctx: Context<Unpause>, vault_id: u64) -> Result<()> {
        ctx.accounts.boring_vault_state.config.paused = false;
        msg!("Vault {} unpaused", vault_id);
        Ok(())
    }

    /// Transfers authority to a new authority
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `vault_id` - The vault id
    /// * `pending_authority` - The new pending authority
    pub fn transfer_authority(
        ctx: Context<TransferAuthority>,
        vault_id: u64,
        pending_authority: Pubkey,
    ) -> Result<()> {
        // Set the pending authority.
        ctx.accounts.boring_vault_state.config.pending_authority = pending_authority;

        msg!(
            "Vault {} pending authority set to {}",
            vault_id,
            pending_authority
        );
        Ok(())
    }

    /// Accepts authority from a pending authority
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `vault_id` - The vault id
    pub fn accept_authority(ctx: Context<AcceptAuthority>, vault_id: u64) -> Result<()> {
        // Update the authority.
        ctx.accounts.boring_vault_state.config.authority =
            ctx.accounts.boring_vault_state.config.pending_authority;

        // Reset the pending authority.
        ctx.accounts.boring_vault_state.config.pending_authority = Pubkey::default();

        msg!(
            "Vault {} authority updated to {}",
            vault_id,
            ctx.accounts.boring_vault_state.config.authority
        );
        Ok(())
    }
    // functions to change fees, payout address, etc.

    /// Updates the asset data
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `args` - The new asset data
    pub fn update_asset_data(
        ctx: Context<UpdateAssetData>,
        args: UpdateAssetDataArgs,
    ) -> Result<()> {
        if args.asset_data.price_feed == Pubkey::default() {
            require!(
                args.asset_data.is_pegged_to_base_asset,
                BoringErrorCode::InvalidPriceFeed
            );
        }
        let asset_data = &mut ctx.accounts.asset_data;
        asset_data.allow_deposits = args.asset_data.allow_deposits;
        asset_data.allow_withdrawals = args.asset_data.allow_withdrawals;
        asset_data.share_premium_bps = args.asset_data.share_premium_bps;
        asset_data.is_pegged_to_base_asset = args.asset_data.is_pegged_to_base_asset;
        asset_data.price_feed = args.asset_data.price_feed;
        asset_data.inverse_price_feed = args.asset_data.inverse_price_feed;
        Ok(())
    }

    pub fn update_cpi_digest(
        ctx: Context<UpdateCpiDigest>,
        args: UpdateCpiDigestArgs,
    ) -> Result<()> {
        let cpi_digest = &mut ctx.accounts.cpi_digest;
        cpi_digest.is_valid = args.is_valid;
        Ok(())
    }

    pub fn close_cpi_digest(_ctx: Context<CloseCpiDigest>) -> Result<()> {
        Ok(())
    }

    pub fn update_exchange_rate_provider(
        ctx: Context<UpdateExchangeRateProvider>,
        vault_id: u64,
        new_provider: Pubkey,
    ) -> Result<()> {
        ctx.accounts
            .boring_vault_state
            .teller
            .exchange_rate_provider = new_provider;

        msg!(
            "Vault {} - Exchange Rate Provider Updated: {}",
            vault_id,
            new_provider
        );
        Ok(())
    }

    pub fn set_withdraw_authority(
        ctx: Context<SetWithdrawAuthority>,
        vault_id: u64,
        new_authority: Pubkey,
    ) -> Result<()> {
        ctx.accounts.boring_vault_state.teller.withdraw_authority = new_authority;
        msg!(
            "Vault {} - Withdraw Authority Updated: {}",
            vault_id,
            new_authority
        );
        Ok(())
    }

    pub fn set_deposit_sub_account(
        ctx: Context<SetDepositSubAccount>,
        vault_id: u64,
        new_sub_account: u8,
    ) -> Result<()> {
        ctx.accounts.boring_vault_state.config.deposit_sub_account = new_sub_account;
        msg!(
            "Vault {} - Deposit Sub Account Updated: {}",
            vault_id,
            new_sub_account
        );
        Ok(())
    }

    pub fn set_withdraw_sub_account(
        ctx: Context<SetWithdrawSubAccount>,
        vault_id: u64,
        new_sub_account: u8,
    ) -> Result<()> {
        ctx.accounts.boring_vault_state.config.withdraw_sub_account = new_sub_account;
        msg!(
            "Vault {} - Withdraw Sub Account Updated: {}",
            vault_id,
            new_sub_account
        );
        Ok(())
    }

    pub fn set_payout(ctx: Context<SetPayout>, vault_id: u64, new_payout: Pubkey) -> Result<()> {
        require_keys_neq!(
            new_payout,
            Pubkey::default(),
            BoringErrorCode::InvalidPayoutAddress
        );
        ctx.accounts.boring_vault_state.teller.payout_address = new_payout;
        msg!(
            "Vault {} - Payout Address Updated: {}",
            vault_id,
            new_payout
        );
        Ok(())
    }

    pub fn configure_exchange_rate_update_bounds(
        ctx: Context<ConfigureExchangeRateUpdateBounds>,
        vault_id: u64,
        args: ConfigureExchangeRateUpdateBoundsArgs,
    ) -> Result<()> {
        // Validate upper bound
        if args.upper_bound > MAXIMUM_ALLOWED_EXCHANGE_RATE_CHANGE_UPPER_BOUND
            || args.upper_bound < BPS_SCALE
        {
            return Err(BoringErrorCode::InvalidAllowedExchangeRateChangeUpperBound.into());
        }

        // Validate lower bound
        if args.lower_bound < MAXIMUM_ALLOWED_EXCHANGE_RATE_CHANGE_LOWER_BOUND
            || args.lower_bound > BPS_SCALE
        {
            return Err(BoringErrorCode::InvalidAllowedExchangeRateChangeLowerBound.into());
        }

        let vault = &mut ctx.accounts.boring_vault_state;
        vault.teller.allowed_exchange_rate_change_upper_bound = args.upper_bound;
        vault.teller.allowed_exchange_rate_change_lower_bound = args.lower_bound;
        vault.teller.minimum_update_delay_in_seconds = args.minimum_update_delay;

        msg!(
            "Vault {} - Exchange Rate Bounds Updated - Upper: {}, Lower: {}, Min Delay: {}",
            vault_id,
            args.upper_bound,
            args.lower_bound,
            args.minimum_update_delay
        );
        Ok(())
    }

    pub fn set_fees(
        ctx: Context<SetFees>,
        vault_id: u64,
        platform_fee_bps: u16,
        performance_fee_bps: u16,
    ) -> Result<()> {
        // Validate platform fee
        if platform_fee_bps > MAXIMUM_PLATFORM_FEE_BPS {
            return Err(BoringErrorCode::InvalidPlatformFeeBps.into());
        }

        // Validate performance fee
        if performance_fee_bps > MAXIMUM_PERFORMANCE_FEE_BPS {
            return Err(BoringErrorCode::InvalidPerformanceFeeBps.into());
        }

        let vault = &mut ctx.accounts.boring_vault_state;
        vault.teller.platform_fee_bps = platform_fee_bps;
        vault.teller.performance_fee_bps = performance_fee_bps;

        msg!(
            "Vault {} - Fees Updated - Platform: {} bps, Performance: {} bps",
            vault_id,
            platform_fee_bps,
            performance_fee_bps
        );
        Ok(())
    }

    pub fn set_strategist(
        ctx: Context<SetStrategist>,
        vault_id: u64,
        new_strategist: Pubkey,
    ) -> Result<()> {
        require_keys_neq!(new_strategist, Pubkey::default());
        ctx.accounts.boring_vault_state.manager.strategist = new_strategist;
        msg!(
            "Vault {} - Strategist Updated: {}",
            vault_id,
            new_strategist
        );
        Ok(())
    }

    pub fn claim_fees_in_base(
        ctx: Context<ClaimFeesInBase>,
        vault_id: u64,
        sub_account: u8,
    ) -> Result<()> {
        // Determine which token program to use based on the mint's owner
        let token_program_id = ctx.accounts.base_mint.to_account_info().owner;
        // Validate ATAs by checking against derived PDAs
        teller::validate_associated_token_accounts(
            &ctx.accounts.base_mint.key(),
            &token_program_id,
            &ctx.accounts.boring_vault_state.teller.payout_address,
            &ctx.accounts.boring_vault.key(),
            &ctx.accounts.payout_ata.key(),
            &ctx.accounts.vault_ata.key(),
        )?;

        // Save assets_out
        let assets_out = ctx
            .accounts
            .boring_vault_state
            .teller
            .fees_owed_in_base_asset;

        // Zero out fees owed
        ctx.accounts
            .boring_vault_state
            .teller
            .fees_owed_in_base_asset = 0;

        let seeds = &[
            // PDA signer seeds for vault state
            BASE_SEED_BORING_VAULT,
            &vault_id.to_le_bytes()[..],
            &[sub_account],
            &[ctx.bumps.boring_vault],
        ];

        // Transfer asset to payout.
        teller::transfer_tokens_to(
            if token_program_id == &ctx.accounts.token_program.key() {
                ctx.accounts.token_program.to_account_info()
            } else if token_program_id == &ctx.accounts.token_program_2022.key() {
                ctx.accounts.token_program_2022.to_account_info()
            } else {
                return Err(BoringErrorCode::InvalidTokenProgram.into());
            },
            ctx.accounts.vault_ata.to_account_info(),
            ctx.accounts.payout_ata.to_account_info(),
            ctx.accounts.base_mint.to_account_info(),
            ctx.accounts.boring_vault.to_account_info(),
            assets_out,
            ctx.accounts.base_mint.decimals,
            &[seeds],
        )?;
        Ok(())
    }

    // =============================== Exchange Rate Functions ===============================

    pub fn update_exchange_rate(
        ctx: Context<UpdateExchangeRate>,
        vault_id: u64,
        new_exchange_rate: u64,
    ) -> Result<()> {
        let current_time = ctx.accounts.clock.unix_timestamp as u64;
        let vault_decimals = ctx.accounts.share_mint.decimals;
        let new_exchange_rate_d = teller::to_decimal(new_exchange_rate, vault_decimals)?;
        let current_exchange_rate = ctx.accounts.boring_vault_state.teller.exchange_rate;
        let current_exchange_rate_d = teller::to_decimal(current_exchange_rate, vault_decimals)?;
        let upper_bound = teller::to_decimal(
            ctx.accounts
                .boring_vault_state
                .teller
                .allowed_exchange_rate_change_upper_bound,
            BPS_DECIMALS,
        )?;
        let lower_bound = teller::to_decimal(
            ctx.accounts
                .boring_vault_state
                .teller
                .allowed_exchange_rate_change_lower_bound,
            BPS_DECIMALS,
        )?;

        let last_update_time = ctx.accounts.boring_vault_state.teller.last_update_timestamp;
        let total_shares_last_update = ctx
            .accounts
            .boring_vault_state
            .teller
            .total_shares_last_update;
        let current_total_shares = ctx.accounts.share_mint.supply;

        let mut should_pause = current_time
            < last_update_time
                + ctx
                    .accounts
                    .boring_vault_state
                    .teller
                    .minimum_update_delay_in_seconds as u64;

        should_pause = should_pause
            || new_exchange_rate_d > current_exchange_rate_d.checked_mul(upper_bound).unwrap();

        should_pause = should_pause
            || new_exchange_rate_d < current_exchange_rate_d.checked_mul(lower_bound).unwrap();

        if should_pause {
            ctx.accounts.boring_vault_state.config.paused = true;
            msg!("Vault {} paused due to exchange rate update", vault_id);
        } else {
            // Not pausing so calculate fees owed.
            let mut platform_fees_owed_in_base_asset: u64 = 0;
            let mut performance_fees_owed_in_base_asset: u64 = 0;
            // First determine platform fee
            let share_supply_to_use_d = if current_total_shares > total_shares_last_update {
                teller::to_decimal(total_shares_last_update, vault_decimals)?
            } else {
                teller::to_decimal(current_total_shares, vault_decimals)?
            };

            if ctx.accounts.boring_vault_state.teller.platform_fee_bps > 0 {
                let platform_fee_d = teller::to_decimal(
                    ctx.accounts.boring_vault_state.teller.platform_fee_bps,
                    BPS_DECIMALS,
                )?;
                // Figure out how much time as passed since last update.
                let time_passed = current_time - last_update_time;

                // Minimum assets is the exchange rate times the share supply.
                let minimum_assets = if share_supply_to_use_d.is_zero() {
                    Decimal::ZERO
                } else if new_exchange_rate > current_exchange_rate {
                    current_exchange_rate_d
                        .checked_mul(share_supply_to_use_d)
                        .unwrap()
                } else {
                    new_exchange_rate_d
                        .checked_mul(share_supply_to_use_d)
                        .unwrap()
                };
                let platform_fee_in_base_asset =
                    minimum_assets.checked_mul(platform_fee_d).unwrap();
                let time_passed_in_years = Decimal::from(time_passed)
                    .checked_div(Decimal::from(365 * 86400))
                    .unwrap();
                let platform_fee_in_base_asset = platform_fee_in_base_asset
                    .checked_mul(time_passed_in_years)
                    .unwrap();
                platform_fees_owed_in_base_asset =
                    teller::from_decimal(platform_fee_in_base_asset, vault_decimals)?;
            }

            if new_exchange_rate
                > ctx
                    .accounts
                    .boring_vault_state
                    .teller
                    .exchange_rate_high_water_mark
            {
                if ctx.accounts.boring_vault_state.teller.performance_fee_bps > 0 {
                    let high_water_mark_d = teller::to_decimal(
                        ctx.accounts
                            .boring_vault_state
                            .teller
                            .exchange_rate_high_water_mark,
                        vault_decimals,
                    )?;
                    let performance_fee_d = teller::to_decimal(
                        ctx.accounts.boring_vault_state.teller.performance_fee_bps,
                        BPS_DECIMALS,
                    )?;
                    let delta_rate = new_exchange_rate_d.checked_sub(high_water_mark_d).unwrap();
                    let yield_earned = delta_rate.checked_mul(share_supply_to_use_d).unwrap();
                    let performance_fee_in_base_asset =
                        yield_earned.checked_mul(performance_fee_d).unwrap();
                    performance_fees_owed_in_base_asset =
                        teller::from_decimal(performance_fee_in_base_asset, vault_decimals)?;
                }

                // Always update high water mark
                ctx.accounts
                    .boring_vault_state
                    .teller
                    .exchange_rate_high_water_mark = new_exchange_rate;
            }

            msg!("Platform fees owed: {}", platform_fees_owed_in_base_asset);
            msg!(
                "Performance fees owed: {}",
                performance_fees_owed_in_base_asset
            );
            // Update fees owed
            ctx.accounts
                .boring_vault_state
                .teller
                .fees_owed_in_base_asset +=
                platform_fees_owed_in_base_asset + performance_fees_owed_in_base_asset;
        }

        // Update exchange rate, last update time, and total shares.
        ctx.accounts.boring_vault_state.teller.exchange_rate = new_exchange_rate;
        ctx.accounts.boring_vault_state.teller.last_update_timestamp = current_time;
        ctx.accounts
            .boring_vault_state
            .teller
            .total_shares_last_update = current_total_shares;

        msg!(
            "Vault {} exchange rate updated to {}",
            vault_id,
            new_exchange_rate
        );
        Ok(())
    }

    // =============================== Strategist Functions ===============================

    pub fn manage(ctx: Context<Manage>, args: ManageArgs) -> Result<()> {
        let cpi_digest = &ctx.accounts.cpi_digest;
        require!(cpi_digest.is_valid, BoringErrorCode::InvalidCpiDigest);

        let ix_accounts = ctx.remaining_accounts;

        // Hash the CPI call down to a digest and confirm it matches the digest in the args.
        let digest = args.operators.apply_operators(
            &args.ix_program_id,
            &ix_accounts,
            &args.ix_data,
            args.expected_size,
        )?;

        // Derive the expected PDA for this digest
        let boring_vault_state_key = ctx.accounts.boring_vault_state.key();
        let seeds = &[
            BASE_SEED_CPI_DIGEST,
            boring_vault_state_key.as_ref(),
            digest.as_ref(),
        ];
        let (expected_pda, _) = Pubkey::find_program_address(seeds, &crate::ID);
        require!(
            expected_pda == cpi_digest.key(),
            BoringErrorCode::InvalidCpiDigest
        );

        // Create new Vec<AccountInfo> with replacements
        let vault_key = ctx.accounts.boring_vault.key();
        let accounts: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|account| {
                let key = account.key();
                let is_signer = if key == vault_key {
                    true // default to true if key is vault
                } else {
                    account.is_signer
                };
                let is_writable = account.is_writable;

                if is_writable {
                    AccountMeta::new(key, is_signer)
                } else {
                    AccountMeta::new_readonly(key, is_signer)
                }
            })
            .collect();

        // Create the instruction
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: args.ix_program_id,
            accounts: accounts,
            data: args.ix_data,
        };

        let vault_seeds = &[
            BASE_SEED_BORING_VAULT,
            &args.vault_id.to_le_bytes()[..],
            &[args.sub_account],
            &[ctx.bumps.boring_vault],
        ];

        // Make the CPI call.
        invoke_signed(&ix, ctx.remaining_accounts, &[vault_seeds])?;

        Ok(())
    }

    // ================================ Deposit Functions ================================

    pub fn deposit_sol(ctx: Context<DepositSol>, args: DepositArgs) -> Result<u64> {
        teller::before_deposit(
            ctx.accounts.boring_vault_state.config.paused,
            ctx.accounts.asset_data.allow_deposits,
        )?;

        // Transfer SOL from user to vault
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.signer.to_account_info(),
                    to: ctx.accounts.boring_vault.to_account_info(),
                },
            ),
            args.deposit_amount,
        )?;

        let is_base = NATIVE.key() == ctx.accounts.boring_vault_state.teller.base_asset.key();

        let shares_out = teller::calculate_shares_and_mint(
            is_base,
            args,
            ctx.accounts.boring_vault_state.teller.exchange_rate,
            ctx.accounts.share_mint.decimals,
            NATIVE_DECIMALS,
            ctx.accounts.asset_data.to_owned(),
            ctx.accounts.price_feed.to_account_info(),
            ctx.accounts.token_program_2022.to_account_info(),
            ctx.accounts.share_mint.to_account_info(),
            ctx.accounts.user_shares.to_account_info(),
            ctx.accounts.boring_vault_state.to_account_info(),
            ctx.bumps.boring_vault_state,
        )?;

        Ok(shares_out)
    }

    pub fn deposit(ctx: Context<Deposit>, args: DepositArgs) -> Result<u64> {
        teller::before_deposit(
            ctx.accounts.boring_vault_state.config.paused,
            ctx.accounts.asset_data.allow_deposits,
        )?;

        // Determine which token program to use based on the mint's owner
        let token_program_id = ctx.accounts.deposit_mint.to_account_info().owner;
        // Validate ATAs by checking against derived PDAs
        teller::validate_associated_token_accounts(
            &ctx.accounts.deposit_mint.key(),
            &token_program_id,
            &ctx.accounts.signer.key(),
            &ctx.accounts.boring_vault.key(),
            &ctx.accounts.user_ata.key(),
            &ctx.accounts.vault_ata.key(),
        )?;
        teller::transfer_tokens_from(
            if token_program_id == &ctx.accounts.token_program.key() {
                ctx.accounts.token_program.to_account_info()
            } else if token_program_id == &ctx.accounts.token_program_2022.key() {
                ctx.accounts.token_program_2022.to_account_info()
            } else {
                return Err(BoringErrorCode::InvalidTokenProgram.into());
            },
            ctx.accounts.user_ata.to_account_info(),
            ctx.accounts.vault_ata.to_account_info(),
            ctx.accounts.deposit_mint.to_account_info(),
            ctx.accounts.signer.to_account_info(),
            args.deposit_amount,
            ctx.accounts.deposit_mint.decimals,
        )?;

        let is_base = ctx.accounts.deposit_mint.key()
            == ctx.accounts.boring_vault_state.teller.base_asset.key();

        let shares_out = teller::calculate_shares_and_mint(
            is_base,
            args,
            ctx.accounts.boring_vault_state.teller.exchange_rate,
            ctx.accounts.share_mint.decimals,
            ctx.accounts.deposit_mint.decimals,
            ctx.accounts.asset_data.to_owned(),
            ctx.accounts.price_feed.to_account_info(),
            ctx.accounts.token_program_2022.to_account_info(),
            ctx.accounts.share_mint.to_account_info(),
            ctx.accounts.user_shares.to_account_info(),
            ctx.accounts.boring_vault_state.to_account_info(),
            ctx.bumps.boring_vault_state,
        )?;

        Ok(shares_out)
    }

    // ================================ Withdraw Functions ================================

    pub fn withdraw(ctx: Context<Withdraw>, args: WithdrawArgs) -> Result<u64> {
        teller::before_withdraw(
            ctx.accounts.boring_vault_state.config.paused,
            ctx.accounts.asset_data.allow_withdrawals,
        )?;

        // Determine which token program to use based on the mint's owner
        let token_program_id = ctx.accounts.withdraw_mint.to_account_info().owner;
        // Validate ATAs by checking against derived PDAs
        teller::validate_associated_token_accounts(
            &ctx.accounts.withdraw_mint.key(),
            &token_program_id,
            &ctx.accounts.signer.key(),
            &ctx.accounts.boring_vault.key(),
            &ctx.accounts.user_ata.key(),
            &ctx.accounts.vault_ata.key(),
        )?;

        // Burn shares from user.
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program_2022.to_account_info(),
                token_interface::Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.user_shares.to_account_info(),
                    authority: ctx.accounts.signer.to_account_info(),
                },
            ),
            args.share_amount,
        )?;

        // Calculate assets to user.
        let is_base = ctx.accounts.withdraw_mint.key()
            == ctx.accounts.boring_vault_state.teller.base_asset.key();

        let vault_id = args.vault_id;
        let assets_out = teller::calculate_assets_out(
            is_base,
            args,
            ctx.accounts.boring_vault_state.teller.exchange_rate,
            ctx.accounts.share_mint.decimals,
            ctx.accounts.withdraw_mint.decimals,
            ctx.accounts.asset_data.to_owned(),
            ctx.accounts.price_feed.to_account_info(),
        )?;

        let seeds = &[
            // PDA signer seeds for vault state
            BASE_SEED_BORING_VAULT,
            &vault_id.to_le_bytes()[..],
            &[ctx.accounts.boring_vault_state.config.withdraw_sub_account],
            &[ctx.bumps.boring_vault],
        ];

        // Transfer asset to user.
        teller::transfer_tokens_to(
            if token_program_id == &ctx.accounts.token_program.key() {
                ctx.accounts.token_program.to_account_info()
            } else if token_program_id == &ctx.accounts.token_program_2022.key() {
                ctx.accounts.token_program_2022.to_account_info()
            } else {
                return Err(BoringErrorCode::InvalidTokenProgram.into());
            },
            ctx.accounts.vault_ata.to_account_info(),
            ctx.accounts.user_ata.to_account_info(),
            ctx.accounts.withdraw_mint.to_account_info(),
            ctx.accounts.boring_vault.to_account_info(),
            assets_out,
            ctx.accounts.withdraw_mint.decimals,
            &[seeds],
        )?;

        Ok(assets_out)
    }

    // ================================== View Functions ==================================

    pub fn view_cpi_digest(ctx: Context<ViewCpiDigest>, args: ManageArgs) -> Result<[u8; 32]> {
        // Hash the CPI call down to a digest
        let digest = args.operators.apply_operators(
            &args.ix_program_id,
            ctx.remaining_accounts,
            &args.ix_data,
            args.expected_size,
        )?;

        Ok(digest)
    }

    pub fn get_rate(ctx: Context<GetRate>, _vault_id: u64) -> Result<u64> {
        teller::get_rate(ctx.accounts.boring_vault_state.to_owned())
    }

    pub fn get_rate_safe(ctx: Context<GetRateSafe>, _vault_id: u64) -> Result<u64> {
        teller::get_rate(ctx.accounts.boring_vault_state.to_owned())
    }

    pub fn get_rate_in_quote(ctx: Context<GetRateInQuote>, _vault_id: u64) -> Result<u64> {
        teller::get_rate_in_quote(
            ctx.accounts.boring_vault_state.to_owned(),
            ctx.accounts.quote_mint.to_owned(),
            ctx.accounts.asset_data.to_owned(),
            ctx.accounts.price_feed.to_owned(),
        )
    }

    pub fn get_rate_in_quote_safe(ctx: Context<GetRateInQuoteSafe>, _vault_id: u64) -> Result<u64> {
        teller::get_rate_in_quote(
            ctx.accounts.boring_vault_state.to_owned(),
            ctx.accounts.quote_mint.to_owned(),
            ctx.accounts.asset_data.to_owned(),
            ctx.accounts.price_feed.to_owned(),
        )
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<ProgramConfig>(),
        seeds = [BASE_SEED_CONFIG],
        bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: DeployArgs)]
pub struct Deploy<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_CONFIG],
        bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<BoringVault>(),
        seeds = [BASE_SEED_BORING_VAULT_STATE, &config.vault_count.to_le_bytes()[..]],
        bump,
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    /// The mint of the share token.
    #[account(
        init,
        payer = signer,
        mint::decimals = base_asset.decimals,
        mint::authority = boring_vault_state.key(),
        seeds = [BASE_SEED_SHARE_TOKEN, boring_vault_state.key().as_ref()],
        bump,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Checked in the instruction
    pub base_asset: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Pause<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Unpause<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64, pending_authority: Pubkey)]
pub struct TransferAuthority<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct AcceptAuthority<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.pending_authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(args: UpdateAssetDataArgs)]
pub struct UpdateAssetData<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    // State
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
    pub system_program: Program<'info, System>,

    /// CHECK: can be zero account, or a Token2022 mint
    pub asset: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + std::mem::size_of::<AssetData>(),
        seeds = [
            BASE_SEED_ASSET_DATA,
            boring_vault_state.key().as_ref(),
            asset.key().as_ref(),
        ],
        bump
    )]
    pub asset_data: Account<'info, AssetData>,
}

#[derive(Accounts)]
#[instruction(args: DepositArgs)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program_2022: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    // State
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [
            BASE_SEED_BORING_VAULT,
            &args.vault_id.to_le_bytes()[..],
            &[boring_vault_state.config.deposit_sub_account]
            ],
        bump,
    )]
    /// CHECK: Account used to hold assets.
    pub boring_vault: SystemAccount<'info>,

    #[account(
        seeds = [
            BASE_SEED_ASSET_DATA,
            boring_vault_state.key().as_ref(),
            NATIVE.as_ref(),
        ],
        bump,
        constraint = asset_data.allow_deposits @ BoringErrorCode::AssetNotAllowed
    )]
    pub asset_data: Account<'info, AssetData>,

    // Share Token
    /// The vault's share mint
    #[account(
        mut,
        seeds = [BASE_SEED_SHARE_TOKEN, boring_vault_state.key().as_ref()],
        bump,
        constraint = share_mint.key() == boring_vault_state.config.share_mint @ BoringErrorCode::InvalidShareMint
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    /// The user's share token 2022 account
    #[account(
            init_if_needed,
            payer = signer,
            associated_token::mint = share_mint,
            associated_token::authority = signer,
            associated_token::token_program = token_program_2022,
        )]
    pub user_shares: InterfaceAccount<'info, TokenAccount>,

    // Pricing
    #[account(
            constraint = price_feed.key() == asset_data.price_feed @ BoringErrorCode::InvalidPriceFeed
        )]
    /// CHECK: Checked in the constraint
    pub price_feed: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(args: DepositArgs)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [
            BASE_SEED_BORING_VAULT,
            &args.vault_id.to_le_bytes()[..],
            &[boring_vault_state.config.deposit_sub_account]
            ],
        bump,
    )]
    /// CHECK: Account used to hold assets.
    pub boring_vault: SystemAccount<'info>,

    // Deposit asset account
    pub deposit_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [
            BASE_SEED_ASSET_DATA,
            boring_vault_state.key().as_ref(),
            deposit_mint.key().as_ref(),
        ],
        bump,
        constraint = asset_data.allow_deposits @ BoringErrorCode::AssetNotAllowed
    )]
    pub asset_data: Account<'info, AssetData>,

    #[account(mut)]
    /// User's Token associated token account
    /// CHECK: Validated in instruction
    pub user_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    /// Vault's Token associated token account
    /// CHECK: Validated in instruction
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    // Programs
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    // Share Token
    /// The vault's share mint
    #[account(
            mut,
            seeds = [BASE_SEED_SHARE_TOKEN, boring_vault_state.key().as_ref()],
            bump,
            constraint = share_mint.key() == boring_vault_state.config.share_mint @ BoringErrorCode::InvalidShareMint
        )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    /// The user's share token 2022 account
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = share_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program_2022,
    )]
    pub user_shares: InterfaceAccount<'info, TokenAccount>,

    // Pricing
    #[account(
        constraint = price_feed.key() == asset_data.price_feed @ BoringErrorCode::InvalidPriceFeed
    )]
    /// CHECK: Checked in the constraint
    pub price_feed: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(args: WithdrawArgs)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.teller.withdraw_authority == Pubkey::default() || signer.key() == boring_vault_state.teller.withdraw_authority @ BoringErrorCode::NotAuthorized,
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [
            BASE_SEED_BORING_VAULT,
            &args.vault_id.to_le_bytes()[..],
            &[boring_vault_state.config.withdraw_sub_account]
            ],
        bump,
    )]
    /// CHECK: Account used to hold assets.
    pub boring_vault: SystemAccount<'info>,

    // Withdraw asset account
    pub withdraw_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [
            BASE_SEED_ASSET_DATA,
            boring_vault_state.key().as_ref(),
            withdraw_mint.key().as_ref(),
        ],
        bump,
    )]
    pub asset_data: Account<'info, AssetData>,

    #[account(mut)]
    /// User's Token associated token account
    /// CHECK: Validated in instruction
    pub user_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    /// Vault's Token associated token account
    /// CHECK: Validated in instruction
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    // Programs
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    // Share Token
    /// The vault's share mint
    #[account(
            mut,
            seeds = [BASE_SEED_SHARE_TOKEN, boring_vault_state.key().as_ref()],
            bump,
            constraint = share_mint.key() == boring_vault_state.config.share_mint @ BoringErrorCode::InvalidShareMint
        )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    /// The user's share token 2022 account
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = share_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program_2022,
    )]
    pub user_shares: InterfaceAccount<'info, TokenAccount>,

    // Pricing
    #[account(
        constraint = price_feed.key() == asset_data.price_feed @ BoringErrorCode::InvalidPriceFeed
    )]
    /// CHECK: Checked in the constraint
    pub price_feed: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(args: UpdateCpiDigestArgs)]
pub struct UpdateCpiDigest<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,

    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + std::mem::size_of::<CpiDigest>(),
        seeds = [
            BASE_SEED_CPI_DIGEST,
            boring_vault_state.key().as_ref(),
            args.cpi_digest.as_ref(),
        ],
        bump,
    )]
    pub cpi_digest: Account<'info, CpiDigest>,
}

#[derive(Accounts)]
#[instruction(args: UpdateCpiDigestArgs)]
pub struct CloseCpiDigest<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [
            BASE_SEED_CPI_DIGEST,
            boring_vault_state.key().as_ref(),
            args.cpi_digest.as_ref(),
        ],
        bump,
        close = signer,
    )]
    pub cpi_digest: Account<'info, CpiDigest>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct UpdateExchangeRateProvider<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct SetWithdrawAuthority<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct SetDepositSubAccount<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct SetWithdrawSubAccount<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct SetPayout<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct ConfigureExchangeRateUpdateBounds<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct SetFees<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct SetStrategist<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64, sub_account: u8)]
pub struct ClaimFeesInBase<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // base asset account
    pub base_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized,
        constraint = base_mint.key() == boring_vault_state.teller.base_asset @ BoringErrorCode::InvalidBaseAsset,
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [
            BASE_SEED_BORING_VAULT,
            &vault_id.to_le_bytes()[..],
            &[sub_account]
            ],
        bump,
    )]
    /// CHECK: Account used to hold assets.
    pub boring_vault: SystemAccount<'info>,

    #[account(mut)]
    /// Payout's Token associated token account
    /// CHECK: Validated in instruction
    pub payout_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    /// Vault's Token associated token account
    /// CHECK: Validated in instruction
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    // Programs
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64, new_exchange_rate: u64)]
pub struct UpdateExchangeRate<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused,
        constraint = signer.key() == boring_vault_state.teller.exchange_rate_provider.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        seeds = [BASE_SEED_SHARE_TOKEN, boring_vault_state.key().as_ref()],
        bump,
        constraint = share_mint.key() == boring_vault_state.config.share_mint @ BoringErrorCode::InvalidShareMint
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
#[instruction(args: ManageArgs)]
pub struct Manage<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused,
        constraint = signer.key() == boring_vault_state.manager.strategist.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [
            BASE_SEED_BORING_VAULT,
            &args.vault_id.to_le_bytes()[..],
            &[args.sub_account]
            ],
        bump,
    )]
    /// CHECK: Account used to hold assets.
    pub boring_vault: AccountInfo<'info>,

    #[account()]
    /// CHECK: Checked in instruction
    pub cpi_digest: Account<'info, CpiDigest>,
}

#[derive(Accounts)]
pub struct ViewCpiDigest<'info> {
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct GetRate<'info> {
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct GetRateSafe<'info> {
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused,
    )]
    pub boring_vault_state: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct GetRateInQuote<'info> {
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    // Quote asset account
    pub quote_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [
            BASE_SEED_ASSET_DATA,
            boring_vault_state.key().as_ref(),
            quote_mint.key().as_ref(),
        ],
        bump,
    )]
    pub asset_data: Account<'info, AssetData>,

    // Pricing
    #[account(
            constraint = price_feed.key() == asset_data.price_feed @ BoringErrorCode::InvalidPriceFeed
        )]
    /// CHECK: Checked in the constraint
    pub price_feed: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct GetRateInQuoteSafe<'info> {
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused,
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    // Quote asset account
    pub quote_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [
            BASE_SEED_ASSET_DATA,
            boring_vault_state.key().as_ref(),
            quote_mint.key().as_ref(),
        ],
        bump,
    )]
    pub asset_data: Account<'info, AssetData>,

    // Pricing
    #[account(
            constraint = price_feed.key() == asset_data.price_feed @ BoringErrorCode::InvalidPriceFeed
        )]
    /// CHECK: Checked in the constraint
    pub price_feed: AccountInfo<'info>,
}
