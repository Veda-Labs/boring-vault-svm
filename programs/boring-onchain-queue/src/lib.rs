//! Boring Queue Program - A Solana program for managing boring vault withdraw requests
//!
//! This program implements functionality for:
//! - Managing withdraw requests in a queue system
//! - Handling share token transfers
//! - Processing withdrawals with maturity periods
//! - Managing queue state and configurations
//! - Validating and executing withdraw requests

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{self, Mint, TokenAccount},
};
mod utils;
use boring_vault_svm::{program::BoringVaultSvm, AssetData, BoringVault};
use rust_decimal::Decimal;
use utils::utils::{
    from_decimal, to_decimal, transfer_tokens_to, validate_associated_token_accounts,
};
mod constants;
use constants::*;
mod error;
use error::*;
mod state;
use state::*;

declare_id!("E1mW9wpynHjwU3YhAHALh2x4sB2Jq8M3H5NgGYZnvUkg");

#[program]
pub mod boring_onchain_queue {
    use super::*;

    // ================================ Program Functions ================================

    /// Initializes the program configuration
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `authority` - The authority address to set
    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authority;
        Ok(())
    }

    /// Deploys a new queue for a vault
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `args` - The deployment arguments containing vault configuration
    pub fn deploy(ctx: Context<Deploy>, args: DeployArgs) -> Result<()> {
        // Derive the vault state PDA
        let (vault_state, _) = Pubkey::find_program_address(
            &[
                boring_vault_svm::BASE_SEED_BORING_VAULT_STATE,
                &args.vault_id.to_le_bytes(),
            ],
            &args.boring_vault_program,
        );

        // Derive the expected share mint PDA
        let (expected_share_mint, _) = Pubkey::find_program_address(
            &[
                boring_vault_svm::BASE_SEED_SHARE_TOKEN,
                vault_state.as_ref(),
            ],
            &args.boring_vault_program,
        );

        // Verify the provided share mint matches the derived one
        require!(
            expected_share_mint == args.share_mint,
            QueueErrorCode::InvalidShareMint
        );

        let queue_state = &mut ctx.accounts.queue_state;
        queue_state.authority = args.authority;
        queue_state.boring_vault_program = args.boring_vault_program;
        queue_state.vault_id = args.vault_id;
        queue_state.share_mint = args.share_mint;
        queue_state.solve_authority = args.solve_authority;
        queue_state.paused = false;

        Ok(())
    }

    // ================================= Admin Functions =================================

    /// Sets the solve authority for the queue
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `vault_id` - The vault ID
    /// * `new_solve_authority` - The new solve authority address
    pub fn set_solve_authority(
        ctx: Context<SetSolveAuthority>,
        vault_id: u64,
        new_solve_authority: Pubkey,
    ) -> Result<()> {
        let queue_state = &mut ctx.accounts.queue_state;
        queue_state.solve_authority = new_solve_authority;
        msg!(
            "Set solve authority for vault {} to {}",
            vault_id,
            new_solve_authority
        );
        Ok(())
    }

    /// Pauses the queue, preventing new withdraw requests
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `vault_id` - The vault ID
    pub fn pause(ctx: Context<Pause>, vault_id: u64) -> Result<()> {
        let queue_state = &mut ctx.accounts.queue_state;
        queue_state.paused = true;
        msg!("Paused withdraw queue for vault {}", vault_id);
        Ok(())
    }

    /// Unpauses the queue, allowing new withdraw requests
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `vault_id` - The vault ID
    pub fn unpause(ctx: Context<Unpause>, vault_id: u64) -> Result<()> {
        let queue_state = &mut ctx.accounts.queue_state;
        queue_state.paused = false;
        msg!("Unpaused withdraw queue for vault {}", vault_id);
        Ok(())
    }

    /// Updates withdraw asset configuration
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `args` - The configuration parameters to update
    ///
    /// # Errors
    /// * `MaximumDeadlineExceeded` - If minimum_seconds_to_deadline exceeds MAXIMUM_DEADLINE (90 days)
    /// * `MaximumMaturityExceeded` - If seconds_to_maturity exceeds MAXIMUM_MATURITY (90 days)
    /// * `InvalidDiscount` - If maximum_discount is less than minimum_discount
    /// * `MaximumDiscountExceeded` - If maximum_discount exceeds MAXIMUM_DISCOUNT (10%)
    pub fn update_withdraw_asset_data(
        ctx: Context<UpdateWithdrawAsset>,
        args: UpdateWithdrawAssetArgs,
    ) -> Result<()> {
        // Validate deadline and maturity constraints
        require!(
            args.minimum_seconds_to_deadline <= MAXIMUM_DEADLINE,
            QueueErrorCode::MaximumDeadlineExceeded
        );
        require!(
            args.seconds_to_maturity <= MAXIMUM_MATURITY,
            QueueErrorCode::MaximumMaturityExceeded
        );

        // Validate discount constraints
        require!(
            args.maximum_discount > args.minimum_discount,
            QueueErrorCode::InvalidDiscount
        );
        require!(
            args.maximum_discount <= MAXIMUM_DISCOUNT,
            QueueErrorCode::MaximumDiscountExceeded
        );

        let withdraw_asset = &mut ctx.accounts.withdraw_asset_data;
        withdraw_asset.allow_withdrawals = args.allow_withdraws;
        withdraw_asset.seconds_to_maturity = args.seconds_to_maturity;
        withdraw_asset.minimum_seconds_to_deadline = args.minimum_seconds_to_deadline;
        withdraw_asset.minimum_discount = args.minimum_discount;
        withdraw_asset.maximum_discount = args.maximum_discount;
        withdraw_asset.minimum_shares = args.minimum_shares;
        Ok(())
    }

    // ================================== User Functions ==================================

    /// Initializes a user's withdraw state
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    pub fn setup_user_withdraw_state(ctx: Context<SetupUserWithdrawState>) -> Result<()> {
        ctx.accounts.user_withdraw_state.last_nonce = 0;
        Ok(())
    }

    /// Requests a withdrawal from the queue
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `args` - The withdraw request arguments containing:
    ///   - vault_id: The vault to withdraw from
    ///   - share_amount: Amount of shares to withdraw
    ///   - discount: Discount rate in BPS
    ///   - seconds_to_deadline: Time until request expires
    ///
    /// # Errors
    /// * `InvalidShareMint` - If share mint doesn't match queue state
    /// * `InvalidDiscount` - If discount is outside allowed range
    /// * `InvalidShareAmount` - If share amount is below minimum
    /// * `InvalidSecondsToDeadline` - If deadline is too short
    pub fn request_withdraw(
        ctx: Context<RequestWithdraw>,
        args: RequestWithdrawArgs,
    ) -> Result<()> {
        // Transfer shares to queue.
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program_2022.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.user_shares.to_account_info(),
                    to: ctx.accounts.queue_shares.to_account_info(),
                    mint: ctx.accounts.share_mint.to_account_info(),
                    authority: ctx.accounts.signer.to_account_info(),
                },
            ),
            args.share_amount,
            ctx.accounts.share_mint.decimals,
        )?;

        let withdraw_request = &mut ctx.accounts.withdraw_request;
        let withdraw_asset_data = &ctx.accounts.withdraw_asset_data;
        withdraw_request.vault_id = args.vault_id;
        withdraw_request.asset_out = ctx.accounts.withdraw_mint.key();
        withdraw_request.share_amount = args.share_amount;

        // Make sure that user provided discount is within the range
        if args.discount < withdraw_asset_data.minimum_discount
            || args.discount > withdraw_asset_data.maximum_discount
        {
            return Err(QueueErrorCode::InvalidDiscount.into());
        }

        // Make sure user is withdrawing enough shares
        if args.share_amount < withdraw_asset_data.minimum_shares {
            return Err(QueueErrorCode::InvalidShareAmount.into());
        }

        // Make sure user provided deadline is greater than minimum
        if args.seconds_to_deadline < withdraw_asset_data.minimum_seconds_to_deadline {
            return Err(QueueErrorCode::InvalidSecondsToDeadline.into());
        }

        // Make sure user provided deadline is less than maximum
        if args.seconds_to_deadline > MAXIMUM_DEADLINE {
            return Err(QueueErrorCode::MaximumDeadlineExceeded.into());
        }

        let clock = &Clock::get()?;
        withdraw_request.creation_time = clock.unix_timestamp as u64;
        withdraw_request.seconds_to_maturity = withdraw_asset_data.seconds_to_maturity;
        withdraw_request.seconds_to_deadline = args.seconds_to_deadline;

        // Get rate in quote through CPI
        let cpi_program = ctx.accounts.boring_vault_program.to_account_info();
        let cpi_accounts = boring_vault_svm::cpi::accounts::GetRateInQuoteSafe {
            boring_vault_state: ctx.accounts.boring_vault_state.to_account_info(),
            quote_mint: ctx.accounts.withdraw_mint.to_account_info(),
            asset_data: ctx.accounts.vault_asset_data.to_account_info(),
            price_feed: ctx.accounts.price_feed.to_account_info(),
        };

        // We want this to fail if the vault is paused
        let rate = boring_vault_svm::cpi::get_rate_in_quote_safe(
            CpiContext::new(cpi_program, cpi_accounts),
            args.vault_id,
        )?;

        // Calculate asset amount using rate and share amount
        let share_amount = to_decimal(
            args.share_amount,
            ctx.accounts.boring_vault_state.teller.decimals,
        )?;
        let rate_d = to_decimal(rate.get(), ctx.accounts.withdraw_mint.decimals)?;
        let asset_amount = share_amount.checked_mul(rate_d).unwrap();

        // Apply discount
        let discount = to_decimal(args.discount, BPS_DECIMALS)?;
        let discount_multiplier = Decimal::from(1).checked_sub(discount).unwrap();
        let asset_amount = asset_amount.checked_mul(discount_multiplier).unwrap();
        // Scale up asset_amount by decimals.
        let asset_amount = from_decimal(asset_amount, ctx.accounts.withdraw_mint.decimals)?;

        withdraw_request.asset_amount = asset_amount;
        ctx.accounts.user_withdraw_state.last_nonce += 1;

        Ok(())
    }

    /// Cancels a withdraw request and returns shares to user
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `request_id` - The request ID to cancel
    ///
    /// # Errors
    /// * `RequestDeadlineNotPassed` - If request deadline hasn't passed yet
    /// * `InvalidShareMint` - If share mint doesn't match queue state
    pub fn cancel_withdraw(ctx: Context<CancelWithdraw>, _request_id: u64) -> Result<()> {
        let withdraw_request = &ctx.accounts.withdraw_request;
        let clock = &Clock::get()?;
        let current_time = clock.unix_timestamp as u64;

        // Calculate deadline
        let creation_time = withdraw_request.creation_time;
        let maturity = creation_time + withdraw_request.seconds_to_maturity as u64;
        let deadline = maturity + withdraw_request.seconds_to_deadline as u64;

        require!(
            current_time > deadline,
            QueueErrorCode::RequestDeadlineNotPassed
        );

        // Transfer shares back to signer.
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_2022.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.queue_shares.to_account_info(),
                    to: ctx.accounts.user_shares.to_account_info(),
                    mint: ctx.accounts.share_mint.to_account_info(),
                    authority: ctx.accounts.queue.to_account_info(),
                },
                &[&[
                    BASE_SEED_QUEUE,
                    &withdraw_request.vault_id.to_le_bytes()[..],
                    &[ctx.bumps.queue],
                ]],
            ),
            ctx.accounts.withdraw_request.share_amount,
            ctx.accounts.share_mint.decimals,
        )?;
        Ok(())
    }

    // =============================== Solver/User Functions ===============================

    /// Fulfills a withdraw request by transferring assets to user
    ///
    /// # Arguments
    /// * `ctx` - The context of accounts
    /// * `request_id` - The request ID to fulfill
    ///
    /// # Errors
    /// * `RequestNotMature` - If maturity period hasn't passed
    /// * `RequestDeadlinePassed` - If request has expired
    /// * `InvalidWithdrawMint` - If withdraw mint doesn't match request
    /// * `QueuePaused` - If queue is paused
    /// * `InvalidTokenProgram` - If token program doesn't match mint
    pub fn fulfill_withdraw(
        ctx: Context<FulfillWithdraw>,
        _request_id: u64, // Used in context
    ) -> Result<()> {
        let withdraw_request = &ctx.accounts.withdraw_request;

        let clock = &Clock::get()?;
        let current_time = clock.unix_timestamp as u64;
        let creation_time = withdraw_request.creation_time;
        let maturity = creation_time + withdraw_request.seconds_to_maturity as u64;
        let deadline = maturity + withdraw_request.seconds_to_deadline as u64;

        if current_time < maturity {
            return Err(QueueErrorCode::RequestNotMature.into());
        }

        if current_time > deadline {
            return Err(QueueErrorCode::RequestDeadlinePassed.into());
        }

        if ctx.accounts.withdraw_mint.key() != withdraw_request.asset_out {
            return Err(QueueErrorCode::InvalidWithdrawMint.into());
        }

        // Validate user's ata. Cpi Withdraw validates vault and queue atas
        let token_program_id = ctx.accounts.withdraw_mint.to_account_info().owner;
        validate_associated_token_accounts(
            &ctx.accounts.withdraw_mint.key(),
            token_program_id,
            &ctx.accounts.user.key(),
            &ctx.accounts.user_ata.key(),
        )?;

        // Withdraw from vault using CPI
        let withdraw_accounts = boring_vault_svm::cpi::accounts::Withdraw {
            signer: ctx.accounts.queue.to_account_info(),
            boring_vault_state: ctx.accounts.boring_vault_state.to_account_info(),
            boring_vault: ctx.accounts.boring_vault.to_account_info(),
            withdraw_mint: ctx.accounts.withdraw_mint.to_account_info(),
            asset_data: ctx.accounts.vault_asset_data.to_account_info(),
            user_ata: ctx.accounts.queue_ata.to_account_info(),
            vault_ata: ctx.accounts.vault_ata.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            token_program_2022: ctx.accounts.token_program_2022.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            share_mint: ctx.accounts.share_mint.to_account_info(),
            user_shares: ctx.accounts.queue_shares.to_account_info(),
            price_feed: ctx.accounts.price_feed.to_account_info(),
        };

        let seeds = &[
            BASE_SEED_QUEUE,
            &withdraw_request.vault_id.to_le_bytes()[..],
            &[ctx.bumps.queue],
        ];

        let signer_seeds = &[&seeds[..]];

        let withdraw_args = boring_vault_svm::WithdrawArgs {
            vault_id: withdraw_request.vault_id,
            share_amount: withdraw_request.share_amount,
            min_assets_amount: withdraw_request.asset_amount, // Min out should be assets needed for request.
        };

        let assets_out = boring_vault_svm::cpi::withdraw(
            CpiContext::new_with_signer(
                ctx.accounts.boring_vault_program.to_account_info(),
                withdraw_accounts,
                signer_seeds,
            ),
            withdraw_args,
        )?;

        let assets_out = assets_out.get();
        // Cannot underflow as withdraw min amount out is asset_amount
        let excess = assets_out - withdraw_request.asset_amount;

        // Transfer asset_amount from queue to user
        let token_program = if token_program_id == &ctx.accounts.token_program.key() {
            ctx.accounts.token_program.to_account_info()
        } else if token_program_id == &ctx.accounts.token_program_2022.key() {
            ctx.accounts.token_program_2022.to_account_info()
        } else {
            return Err(QueueErrorCode::InvalidTokenProgram.into());
        };

        transfer_tokens_to(
            token_program.clone(),
            ctx.accounts.queue_ata.to_account_info(),
            ctx.accounts.user_ata.to_account_info(),
            ctx.accounts.withdraw_mint.to_account_info(),
            ctx.accounts.queue.to_account_info(),
            ctx.accounts.withdraw_request.asset_amount,
            ctx.accounts.withdraw_mint.decimals,
            signer_seeds,
        )?;

        // Transfer excess from queue back to boring_vault if any
        if excess > 0 {
            transfer_tokens_to(
                token_program,
                ctx.accounts.queue_ata.to_account_info(),
                ctx.accounts.vault_ata.to_account_info(),
                ctx.accounts.withdraw_mint.to_account_info(),
                ctx.accounts.queue.to_account_info(),
                excess,
                ctx.accounts.withdraw_mint.decimals,
                signer_seeds,
            )?;
        }

        Ok(())
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
        seeds = [BASE_SEED_CONFIG],
        bump,
        constraint = config.authority == signer.key() @ QueueErrorCode::NotAuthorized
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<QueueState>(),
        seeds = [BASE_SEED_QUEUE_STATE, &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    pub queue_state: Account<'info, QueueState>,

    #[account(
        mut,
        seeds = [BASE_SEED_QUEUE, &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Account used to hold shares.
    pub queue: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct SetSolveAuthority<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_QUEUE_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = queue_state.authority == signer.key() @ QueueErrorCode::NotAuthorized
    )]
    pub queue_state: Account<'info, QueueState>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Pause<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_QUEUE_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = queue_state.authority == signer.key() @ QueueErrorCode::NotAuthorized
    )]
    pub queue_state: Account<'info, QueueState>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Unpause<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_QUEUE_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = queue_state.authority == signer.key() @ QueueErrorCode::NotAuthorized
    )]
    pub queue_state: Account<'info, QueueState>,
}

#[derive(Accounts)]
#[instruction(args: UpdateWithdrawAssetArgs)]
pub struct UpdateWithdrawAsset<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [BASE_SEED_QUEUE_STATE, &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = queue_state.authority == signer.key() @ QueueErrorCode::NotAuthorized
    )]
    pub queue_state: Account<'info, QueueState>,

    // Withdraw asset account
    pub withdraw_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + std::mem::size_of::<WithdrawAssetData>(),
        seeds = [BASE_SEED_WITHDRAW_ASSET_DATA, withdraw_mint.key().as_ref(), &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    pub withdraw_asset_data: Account<'info, WithdrawAssetData>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetupUserWithdrawState<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<UserWithdrawState>(),
        seeds = [BASE_SEED_USER_WITHDRAW_STATE, signer.key().as_ref()],
        bump,
    )]
    pub user_withdraw_state: Account<'info, UserWithdrawState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: RequestWithdrawArgs)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [BASE_SEED_QUEUE_STATE, &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = queue_state.paused == false @ QueueErrorCode::QueuePaused,
        constraint = queue_state.share_mint == share_mint.key() @ QueueErrorCode::InvalidShareMint,
    )]
    pub queue_state: Account<'info, QueueState>,

    // Withdraw asset account
    pub withdraw_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [BASE_SEED_WITHDRAW_ASSET_DATA, withdraw_mint.key().as_ref(), &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = withdraw_asset_data.allow_withdrawals == true @ QueueErrorCode::WithdrawsNotAllowedForAsset
    )]
    pub withdraw_asset_data: Account<'info, WithdrawAssetData>,

    #[account(
        mut,
        seeds = [BASE_SEED_USER_WITHDRAW_STATE, signer.key().as_ref()],
        bump,
    )]
    pub user_withdraw_state: Account<'info, UserWithdrawState>,

    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<WithdrawRequest>(),
        seeds = [BASE_SEED_WITHDRAW_REQUEST, signer.key().as_ref(), &user_withdraw_state.last_nonce.to_le_bytes()[..]],
        bump,
    )]
    pub withdraw_request: Account<'info, WithdrawRequest>,

    #[account(
        mut,
        seeds = [BASE_SEED_QUEUE, &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Account used to hold shares.
    pub queue: SystemAccount<'info>,

    /// The vault's share mint
    #[account(mut)]
    /// CHECK: Validated in instruction explicitly, even though
    /// it is implicitly validated by the cpi
    pub share_mint: InterfaceAccount<'info, Mint>,

    /// The user's share token 2022 account
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = signer,
        associated_token::token_program = token_program_2022,
    )]
    pub user_shares: InterfaceAccount<'info, TokenAccount>,

    /// The queue's share token 2022 account
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = queue,
        associated_token::token_program = token_program_2022,
    )]
    pub queue_shares: InterfaceAccount<'info, TokenAccount>,

    pub token_program_2022: Program<'info, Token2022>,

    pub system_program: Program<'info, System>,

    #[account(
        constraint = boring_vault_program.key() == queue_state.boring_vault_program @ QueueErrorCode::InvalidBoringVaultProgram
    )]
    /// The Boring Vault program
    pub boring_vault_program: Program<'info, BoringVaultSvm>,

    /// The vault state account
    /// CHECK: Validated in CPI call
    pub boring_vault_state: Account<'info, BoringVault>,

    /// The vault's asset data for the withdraw mint
    /// CHECK: Validated in CPI call
    pub vault_asset_data: Account<'info, AssetData>,

    /// Price feed for the withdraw asset
    /// CHECK: Validated in CPI call
    pub price_feed: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct FulfillWithdraw<'info> {
    #[account(mut)]
    pub solver: Signer<'info>,

    /// CHECK: Used in PDA derivation
    pub user: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [BASE_SEED_WITHDRAW_REQUEST, user.key().as_ref(), &request_id.to_le_bytes()[..]],
        bump,
        close = solver
    )]
    pub withdraw_request: Account<'info, WithdrawRequest>,

    // Share Token
    /// The vault's share mint
    #[account(mut)]
    pub share_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [BASE_SEED_QUEUE_STATE, &withdraw_request.vault_id.to_le_bytes()[..]],
        bump,
        constraint = queue_state.paused == false @ QueueErrorCode::QueuePaused,
        constraint = queue_state.solve_authority == Pubkey::default() || solver.key() == queue_state.solve_authority @ QueueErrorCode::NotAuthorized,
        constraint = queue_state.share_mint == share_mint.key() @ QueueErrorCode::InvalidShareMint,
    )]
    pub queue_state: Account<'info, QueueState>,

    // Withdraw asset account
    /// CHECK: Validated in instruction against request
    pub withdraw_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    /// Users's Token associated token account
    /// CHECK: Validated in instruction
    pub user_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    /// Queues's Token associated token account
    /// CHECK: Validated in cpi
    pub queue_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    /// Vault's Token associated token account
    /// CHECK: Validated in cpi
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [BASE_SEED_QUEUE, &withdraw_request.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Account used to hold shares.
    pub queue: SystemAccount<'info>,

    /// The queue's share token 2022 account
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = queue,
        associated_token::token_program = token_program_2022,
    )]
    pub queue_shares: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    #[account(
        constraint = boring_vault_program.key() == queue_state.boring_vault_program @ QueueErrorCode::InvalidBoringVaultProgram
    )]
    /// The Boring Vault program
    pub boring_vault_program: Program<'info, BoringVaultSvm>,

    /// The vault state account
    #[account(mut)]
    /// CHECK: Validated in CPI call
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(mut)]
    /// CHECK: Checked in boring vault program instruction
    pub boring_vault: SystemAccount<'info>,

    /// The vault's asset data for the withdraw mint
    /// CHECK: Validated in CPI call
    pub vault_asset_data: Account<'info, AssetData>,

    /// Price feed for the withdraw asset
    /// CHECK: Validated in CPI call
    pub price_feed: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct CancelWithdraw<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // Share Token
    /// The vault's share mint
    #[account(mut)]
    pub share_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [BASE_SEED_WITHDRAW_REQUEST, signer.key().as_ref(), &request_id.to_le_bytes()[..]],
        bump,
        close = signer,
    )]
    /// CHECK: Signer key used in seeds, so request must belong to signer.
    pub withdraw_request: Account<'info, WithdrawRequest>,

    #[account(
        seeds = [BASE_SEED_QUEUE_STATE, &withdraw_request.vault_id.to_le_bytes()[..]],
        bump,
        constraint = queue_state.share_mint == share_mint.key() @ QueueErrorCode::InvalidShareMint,
    )]
    pub queue_state: Account<'info, QueueState>,

    #[account(
        mut,
        seeds = [BASE_SEED_QUEUE, &withdraw_request.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Account used to hold shares.
    pub queue: SystemAccount<'info>,

    /// The user's share token 2022 account
    #[account(
            mut,
            associated_token::mint = share_mint,
            associated_token::authority = signer,
            associated_token::token_program = token_program_2022,
        )]
    pub user_shares: InterfaceAccount<'info, TokenAccount>,

    /// The queue's share token 2022 account
    #[account(
        mut,
        associated_token::mint = share_mint,
        associated_token::authority = queue,
        associated_token::token_program = token_program_2022,
    )]
    pub queue_shares: InterfaceAccount<'info, TokenAccount>,

    pub token_program_2022: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
