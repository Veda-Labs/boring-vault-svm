#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;

use anchor_spl::token_interface;
use anchor_spl::token_interface::{Mint, TokenAccount};
use boring_vault_svm::{program::BoringVaultSvm, AssetData, BoringVault};
use rust_decimal::Decimal;

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

    pub fn initialize(ctx: Context<Initialize>, authoriy: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authoriy;
        Ok(())
    }

    pub fn deploy(ctx: Context<Deploy>, args: DeployArgs) -> Result<()> {
        let queue_state = &mut ctx.accounts.queue_state;
        queue_state.authority = args.authority;
        queue_state.boring_vault_program = args.boring_vault_program;
        queue_state.vault_id = args.vault_id;
        queue_state.solve_authority = args.solve_authority;
        queue_state.paused = false;

        // TODO create share ata
        Ok(())
    }

    pub fn update_withdraw_asset_data(
        ctx: Context<UpdateWithdrawAsset>,
        args: UpdateWithdrawAssetArgs,
    ) -> Result<()> {
        let withdraw_asset = &mut ctx.accounts.withdraw_asset_data;
        withdraw_asset.allow_withdrawals = true;
        withdraw_asset.seconds_to_maturity = args.seconds_to_maturity;
        withdraw_asset.minimum_seconds_to_deadline = args.minimum_seconds_to_deadline;
        withdraw_asset.minimum_discount = args.minimum_discount;
        withdraw_asset.maximum_discount = args.maximum_discount;
        withdraw_asset.minimum_shares = args.minimum_shares;
        Ok(())
    }

    pub fn setup_user_withdraw_state(
        ctx: Context<SetupUserWithdrawState>,
        vault_id: u64,
    ) -> Result<()> {
        ctx.accounts.user_withdraw_state.last_nonce = 0;

        msg!("Setup User Withdraw State for BoringVault {}", vault_id);
        Ok(())
    }

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

        let user_withdraw_state = &mut ctx.accounts.user_withdraw_state;
        let withdraw_request = &mut ctx.accounts.withdraw_request;
        let withdraw_asset_data = &ctx.accounts.withdraw_asset_data;
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

        withdraw_request.creation_time = ctx.accounts.clock.unix_timestamp as u64;
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
        let mut share_amount = Decimal::from(args.share_amount);
        share_amount
            .set_scale(ctx.accounts.boring_vault_state.teller.decimals as u32)
            .unwrap();
        let mut rate_d = Decimal::from(rate.get());
        rate_d
            .set_scale(ctx.accounts.withdraw_mint.decimals as u32)
            .unwrap();

        let asset_amount = share_amount.checked_mul(rate_d).unwrap();

        // Apply discount
        let mut discount = Decimal::from(args.discount);
        discount.set_scale(4).unwrap(); // BPS scale
        let discount_multiplier = Decimal::from(1).checked_sub(discount).unwrap();
        let asset_amount = asset_amount.checked_mul(discount_multiplier).unwrap();

        withdraw_request.asset_amount = asset_amount.try_into().unwrap();
        user_withdraw_state.last_nonce += 1;
        Ok(())
    }

    pub fn fulfill_withdraw(
        ctx: Context<FulfillWithdraw>,
        vault_id: u64,
        _request_id: u64, // Used in context
    ) -> Result<()> {
        let withdraw_request = &ctx.accounts.withdraw_request;
        let current_time = ctx.accounts.clock.unix_timestamp as u64;
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

        msg!("=== Account Details ===");
        msg!("signer (queue): {}", ctx.accounts.queue.key(),);
        msg!(
            "boring_vault_state: {}",
            ctx.accounts.boring_vault_state.key(),
        );
        msg!("boring_vault: {}", ctx.accounts.boring_vault.key(),);
        msg!("withdraw_mint: {}", ctx.accounts.withdraw_mint.key(),);
        msg!("vault_asset_data: {}", ctx.accounts.vault_asset_data.key(),);
        msg!("queue_ata: {}", ctx.accounts.queue_ata.key(),);
        msg!("vault_ata: {}", ctx.accounts.vault_ata.key(),);
        msg!("share_mint: {}", ctx.accounts.share_mint.key(),);
        msg!("queue_shares: {}", ctx.accounts.queue_shares.key(),);
        msg!("price_feed: {}", ctx.accounts.price_feed.key(),);

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
            &vault_id.to_le_bytes()[..],
            &[ctx.bumps.queue],
        ];

        let signer_seeds = &[&seeds[..]];

        let withdraw_args = boring_vault_svm::WithdrawArgs {
            vault_id,
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

        // Transfer asset_amount from queue to user.
        let token_program_id = ctx.accounts.withdraw_mint.to_account_info().owner;

        if token_program_id == &ctx.accounts.token_program.key() {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token_interface::TransferChecked {
                        from: ctx.accounts.queue_ata.to_account_info(),
                        to: ctx.accounts.user_ata.to_account_info(),
                        mint: ctx.accounts.withdraw_mint.to_account_info(),
                        authority: ctx.accounts.queue.to_account_info(),
                    },
                    &[&[
                        BASE_SEED_QUEUE,
                        &vault_id.to_le_bytes()[..],
                        &[ctx.bumps.queue],
                    ]],
                ),
                ctx.accounts.withdraw_request.asset_amount,
                ctx.accounts.withdraw_mint.decimals,
            )?;
        } else if token_program_id == &ctx.accounts.token_program_2022.key() {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program_2022.to_account_info(),
                    token_interface::TransferChecked {
                        from: ctx.accounts.queue_ata.to_account_info(),
                        to: ctx.accounts.user_ata.to_account_info(),
                        mint: ctx.accounts.withdraw_mint.to_account_info(),
                        authority: ctx.accounts.queue.to_account_info(),
                    },
                    &[&[
                        BASE_SEED_QUEUE,
                        &vault_id.to_le_bytes()[..],
                        &[ctx.bumps.queue],
                    ]],
                ),
                ctx.accounts.withdraw_request.asset_amount,
                ctx.accounts.withdraw_mint.decimals,
            )?;
        } else {
            return Err(QueueErrorCode::InvalidTokenProgram.into());
        }

        // TODO some issue with the return value
        // Transfer excess from queue back to boring_vault.
        // let excess = assets_out.get() - withdraw_request.asset_amount;
        // if excess > 0 {
        //     if token_program_id == &ctx.accounts.token_program.key() {
        //         token_interface::transfer_checked(
        //             CpiContext::new_with_signer(
        //                 ctx.accounts.token_program.to_account_info(),
        //                 token_interface::TransferChecked {
        //                     from: ctx.accounts.queue_ata.to_account_info(),
        //                     to: ctx.accounts.vault_ata.to_account_info(),
        //                     mint: ctx.accounts.withdraw_mint.to_account_info(),
        //                     authority: ctx.accounts.queue.to_account_info(),
        //                 },
        //                 &[&[
        //                     BASE_SEED_QUEUE,
        //                     &vault_id.to_le_bytes()[..],
        //                     &[ctx.bumps.queue],
        //                 ]],
        //             ),
        //             excess,
        //             ctx.accounts.withdraw_mint.decimals,
        //         )?;
        //     } else if token_program_id == &ctx.accounts.token_program_2022.key() {
        //         token_interface::transfer_checked(
        //             CpiContext::new_with_signer(
        //                 ctx.accounts.token_program_2022.to_account_info(),
        //                 token_interface::TransferChecked {
        //                     from: ctx.accounts.queue_ata.to_account_info(),
        //                     to: ctx.accounts.vault_ata.to_account_info(),
        //                     mint: ctx.accounts.withdraw_mint.to_account_info(),
        //                     authority: ctx.accounts.queue.to_account_info(),
        //                 },
        //                 &[&[
        //                     BASE_SEED_QUEUE,
        //                     &vault_id.to_le_bytes()[..],
        //                     &[ctx.bumps.queue],
        //                 ]],
        //             ),
        //             excess,
        //             ctx.accounts.withdraw_mint.decimals,
        //         )?;
        //     } else {
        //         return Err(QueueErrorCode::InvalidTokenProgram.into());
        //     }
        // }

        Ok(())
    }

    // TODO function to cancel withdraw, replace withdraw
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
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<WithdrawAssetData>(),
        seeds = [BASE_SEED_WITHDRAW_ASSET_DATA, withdraw_mint.key().as_ref(), &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    pub withdraw_asset_data: Account<'info, WithdrawAssetData>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct SetupUserWithdrawState<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<UserWithdrawState>(),
        seeds = [BASE_SEED_USER_WITHDRAW_STATE, signer.key().as_ref(),  &vault_id.to_le_bytes()[..]],
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
        constraint = queue_state.paused == false @ QueueErrorCode::QueuePaused
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
        seeds = [BASE_SEED_USER_WITHDRAW_STATE, signer.key().as_ref(),  &args.vault_id.to_le_bytes()[..]],
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

    // Share Token
    /// The vault's share mint
    #[account(mut)]
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

    pub clock: Sysvar<'info, Clock>,

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
#[instruction(vault_id: u64, request_id: u64)]
pub struct FulfillWithdraw<'info> {
    #[account(mut)]
    pub solver: Signer<'info>,

    /// CHECK: Used in PDA derivation
    pub user: AccountInfo<'info>,

    #[account(
        seeds = [BASE_SEED_QUEUE_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = queue_state.paused == false @ QueueErrorCode::QueuePaused,
        constraint = queue_state.solve_authority == Pubkey::default() || solver.key() == queue_state.solve_authority @ QueueErrorCode::NotAuthorized
    )]
    pub queue_state: Account<'info, QueueState>,

    // Withdraw asset account
    pub withdraw_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    /// Users's Token associated token account
    /// CHECK: Validated in instruction
    pub user_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    /// Queues's Token associated token account
    /// CHECK: Validated in instruction
    pub queue_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    /// Vault's Token associated token account
    /// CHECK: Validated in instruction
    pub vault_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [BASE_SEED_WITHDRAW_REQUEST, user.key().as_ref(), &request_id.to_le_bytes()[..]],
        bump,
        close = solver
    )]
    pub withdraw_request: Account<'info, WithdrawRequest>,

    #[account(
        mut,
        seeds = [BASE_SEED_QUEUE, &vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Account used to hold shares.
    pub queue: SystemAccount<'info>,

    // Share Token
    /// The vault's share mint
    #[account(mut)]
    pub share_mint: InterfaceAccount<'info, Mint>,

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

    pub clock: Sysvar<'info, Clock>,

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
