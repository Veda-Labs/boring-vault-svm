#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
mod state;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use state::*;
mod error;
use error::*;
mod constants;
use constants::*;
mod utils;
use utils::accountant;
use utils::teller;
declare_id!("26YRHAHxMa569rQ73ifQDV9haF7Njcm3v7epVPvcpJsX");

#[program]
pub mod boring_vault_svm {
    use switchboard_on_demand::prelude::invoke_signed;

    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.vault_count = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    // TODO this needs to set up the remaining state.
    // Need to set all the other state
    pub fn deploy(ctx: Context<Deploy>, args: DeployArgs) -> Result<()> {
        // Make sure the signer is the authority.
        require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.config.authority);

        // Make sure the authority is not the zero address.
        require_keys_neq!(args.authority, Pubkey::default());

        // Initialize vault.
        let vault = &mut ctx.accounts.boring_vault_state;
        vault.config.vault_id = ctx.accounts.config.vault_count;
        vault.config.authority = args.authority;
        vault.config.share_mint = ctx.accounts.share_mint.key();
        vault.config.initialized = true;
        vault.config.paused = false;

        vault.teller.exchange_rate = 1000000000;

        // Update program config.
        ctx.accounts.config.vault_count += 1;

        msg!(
            "Boring Vault deployed successfully with share token {}",
            ctx.accounts.share_mint.key()
        );
        Ok(())
    }

    // TODO more admin functions for changing authority

    pub fn update_asset_data(
        ctx: Context<UpdateAssetData>,
        args: UpdateAssetDataArgs,
    ) -> Result<()> {
        let asset_data = &mut ctx.accounts.asset_data;
        asset_data.allow_deposits = args.asset_data.allow_deposits;
        asset_data.allow_withdrawals = args.asset_data.allow_withdrawals;
        asset_data.share_premium_bps = args.asset_data.share_premium_bps;
        asset_data.price_feed = args.asset_data.price_feed;
        asset_data.inverse_price_feed = args.asset_data.inverse_price_feed;
        Ok(())
    }

    pub fn deposit_sol(ctx: Context<DepositSol>, args: DepositArgs) -> Result<()> {
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

        teller::calculate_shares_and_mint(
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

        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, args: DepositArgs) -> Result<()> {
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
        if token_program_id == &ctx.accounts.token_program.key() {
            // Transfer Token from user to vault
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token_interface::TransferChecked {
                        from: ctx.accounts.user_ata.to_account_info(),
                        to: ctx.accounts.vault_ata.to_account_info(),
                        mint: ctx.accounts.deposit_mint.to_account_info(),
                        authority: ctx.accounts.signer.to_account_info(),
                    },
                ),
                args.deposit_amount,
                ctx.accounts.deposit_mint.decimals,
            )?;
        } else if token_program_id == &ctx.accounts.token_program_2022.key() {
            // Transfer Token2022 from user to vault
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program_2022.to_account_info(),
                    token_interface::TransferChecked {
                        from: ctx.accounts.user_ata.to_account_info(),
                        to: ctx.accounts.vault_ata.to_account_info(),
                        mint: ctx.accounts.deposit_mint.to_account_info(),
                        authority: ctx.accounts.signer.to_account_info(),
                    },
                ),
                args.deposit_amount,
                ctx.accounts.deposit_mint.decimals,
            )?;
        } else {
            return Err(BoringErrorCode::InvalidTokenProgram.into());
        };

        let is_base = ctx.accounts.deposit_mint.key()
            == ctx.accounts.boring_vault_state.teller.base_asset.key();

        teller::calculate_shares_and_mint(
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

        Ok(())
    }

    // TODO could have a function to close accounts
    pub fn update_cpi_digest(
        ctx: Context<UpdateCpiDigest>,
        args: UpdateCpiDigestArgs,
    ) -> Result<()> {
        let cpi_digest = &mut ctx.accounts.cpi_digest;
        cpi_digest.is_valid = args.is_valid;
        Ok(())
    }

    pub fn manage(ctx: Context<Manage>, args: ManageArgs) -> Result<()> {
        let current_slot = ctx.accounts.clock.slot;
        msg!("Current slot: {}", current_slot); // This will log the current slot

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
            b"cpi-digest",
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
            b"boring-vault",
            &args.vault_id.to_le_bytes()[..],
            &[ctx.bumps.boring_vault],
        ];

        // Make the CPI call.
        invoke_signed(&ix, ctx.remaining_accounts, &[vault_seeds])?;

        Ok(())
    }

    pub fn view_cpi_digest(
        ctx: Context<ViewCpiDigest>,
        args: ManageArgs,
    ) -> Result<ViewCpiDigestReturn> {
        // Hash the CPI call down to a digest
        let digest = args.operators.apply_operators(
            &args.ix_program_id,
            ctx.remaining_accounts,
            &args.ix_data,
            args.expected_size,
        )?;

        Ok(ViewCpiDigestReturn { digest })
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
        seeds = [b"config"],
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
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<BoringVault>(),
        seeds = [b"boring-vault-state", &config.vault_count.to_le_bytes()[..]],
        bump,
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [b"boring-vault", &config.vault_count.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Account used to hold assets.
    pub boring_vault: SystemAccount<'info>,

    /// The mint of the share token.
    #[account(
        init,
        payer = signer,
        mint::decimals = args.decimals,
        mint::authority = boring_vault_state.key(),
        seeds = [b"share-token", boring_vault_state.key().as_ref()],
        bump,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(args: UpdateAssetDataArgs)]
pub struct UpdateAssetData<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    // State
    #[account(
        seeds = [b"boring-vault-state", &args.vault_id.to_le_bytes()[..]],
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
            b"asset-data",
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
        seeds = [b"boring-vault-state", &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [b"boring-vault", &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Account used to hold assets.
    pub boring_vault: SystemAccount<'info>,

    #[account(
        seeds = [
            b"asset-data",
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
        seeds = [b"share-token", boring_vault_state.key().as_ref()],
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
        seeds = [b"boring-vault-state", &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [b"boring-vault", &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Account used to hold assets.
    pub boring_vault: SystemAccount<'info>,

    // Deposit asset account
    pub deposit_mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [
            b"asset-data",
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
            seeds = [b"share-token", boring_vault_state.key().as_ref()],
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
        seeds = [b"boring-vault-state", &args.vault_id.to_le_bytes()[..]],
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
            b"cpi-digest",
            boring_vault_state.key().as_ref(),
            args.cpi_digest.as_ref(),
        ],
        bump,
    )]
    pub cpi_digest: Account<'info, CpiDigest>,
}

#[derive(Accounts)]
#[instruction(args: ManageArgs)]
pub struct Manage<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [b"boring-vault-state", &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.paused == false @ BoringErrorCode::VaultPaused,
        constraint = signer.key() == boring_vault_state.config.authority.key() @ BoringErrorCode::NotAuthorized // TODO make this strategist
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [b"boring-vault", &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Account used to hold assets.
    pub boring_vault: AccountInfo<'info>,

    #[account()]
    /// CHECK: Checked in instruction
    pub cpi_digest: Account<'info, CpiDigest>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct ViewCpiDigest {}
