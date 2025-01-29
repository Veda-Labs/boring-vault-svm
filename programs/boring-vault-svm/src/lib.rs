#![allow(unexpected_cfgs)]

use anchor_lang::{
    prelude::*,
    system_program::{create_account, CreateAccount},
};
mod state;
use anchor_lang::solana_program::{
    instruction::Instruction, program::invoke, program::invoke_signed,
};
use std::cell::RefMut;
use anchor_spl::
    token_2022::spl_token_2022::{
        extension::{
            transfer_hook::TransferHookAccount,
            BaseStateWithExtensionsMut,
            PodStateWithExtensionsMut,
        },
        pod::PodAccount,
    };
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta,
    seeds::Seed,
    state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;
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
        config.bump = ctx.bumps.config;
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
        vault.config.initialized = true;
        vault.config.paused = false;

        // Initialize teller state.
        vault.teller.base_asset = args.base_asset;
        if args.exchange_rate_provider == Pubkey::default() {
            return Err(BoringErrorCode::InvalidExchangeRateProvider.into());
        }
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

        // Initialize manager state.
        // TODO this will likely change to support multiple strategists.
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
    // TODO
    // transfer_authority
    // accept_authority
    // close_cpi_digest
    // functions to change fees, payout address, etc.

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

    pub fn update_cpi_digest(
        ctx: Context<UpdateCpiDigest>,
        args: UpdateCpiDigestArgs,
    ) -> Result<()> {
        let cpi_digest = &mut ctx.accounts.cpi_digest;
        cpi_digest.is_valid = args.is_valid;
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

    // ================================== Transfer Hook ==================================
    // TODO to make this work would need a transfer function here, that would allow users
    // to transfer shares, but it would check if their shares were locked

    // TODO could this be done in the deploy function?
    #[interface(spl_transfer_hook_interface::initialize_extra_account_meta_list)]
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>
    ) -> Result<()> {
        let extra_account_metas = InitializeExtraAccountMetaList::extra_account_metas()?;

        // initialize ExtraAccountMetaList account with extra accounts
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &extra_account_metas
        )?;

        // TODO so I think the next step is to actually make the CPI call to token2022 to set the metadata

     
        Ok(())
    }

    #[interface(spl_transfer_hook_interface::execute)]
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        // Fail this instruction if it is not called from within a transfer hook
        check_is_transferring(&ctx)?;

        // Check if allow_transfers is true
        if !ctx.accounts.transfer_config.allow_transfers {
            // Transfers are not allowed, but see if the owner is in the allowed list to make an exception
            let transfer_config = &ctx.accounts.transfer_config;
            let owner = ctx.accounts.owner.key();
            require!(transfer_config.allow_list.contains(&owner), BoringErrorCode::NotInTransferAllowList);
        } 

        Ok(())
    }

    pub fn allow_all_transfers(ctx: Context<AllowAllTransfers>, vault_id: u64) -> Result<()> {
        let transfer_config = &mut ctx.accounts.transfer_config;
        transfer_config.allow_transfers = true;

        msg!("Allowing all transfers for vault {}", vault_id);
        Ok(())
    }

    pub fn enforce_transfer_allow_list(ctx: Context<EnforceTransferAllowList>, vault_id: u64) -> Result<()> {
        let transfer_config = &mut ctx.accounts.transfer_config;
        transfer_config.allow_transfers = false;

        msg!("Enforcing transfer allow list for vault {}", vault_id);
        Ok(())
    }

    pub fn stop_all_transfers(ctx: Context<StopAllTransfers>, vault_id: u64) -> Result<()> {
        let transfer_config = &mut ctx.accounts.transfer_config;
        transfer_config.allow_transfers = false;
        // Iterate through allow_list and zero out all the accounts.
        for account in transfer_config.allow_list.iter_mut() {
            *account = Pubkey::default();
        }

        msg!("Stopping all transfers for vault {}", vault_id);
        Ok(())
    }

    pub fn add_to_transfer_allow_list(ctx: Context<AddToTransferAllowList>, vault_id: u64, args: UpdateTransferAllowListArgs) -> Result<()> {
        let transfer_config = &mut ctx.accounts.transfer_config;
        transfer_config.allow_list[args.index as usize] = args.account;

        msg!("Adding account {} to transfer allow list for vault {}", args.account, vault_id);
        Ok(())
    }

    pub fn remove_from_transfer_allow_list(ctx: Context<RemoveFromTransferAllowList>, vault_id: u64, args: UpdateTransferAllowListArgs) -> Result<()> {
        let transfer_config = &mut ctx.accounts.transfer_config;
        transfer_config.allow_list[args.index as usize] = Pubkey::default();

        msg!("Removing account {} from transfer allow list for vault {}", args.account, vault_id);
        Ok(())
    }

    // ================================ Deposit Functions ================================

    // TODO share lock period
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

    // ================================== View Functions ==================================
    // TODO preview_deposit

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


fn check_is_transferring(ctx: &Context<TransferHook>) -> Result<()> {
    let source_token_info = ctx.accounts.source_token.to_account_info();
    let mut account_data_ref: RefMut<&mut [u8]> = source_token_info.try_borrow_mut_data()?;
    let mut account = PodStateWithExtensionsMut::<PodAccount>::unpack(*account_data_ref)?;
    let account_extension = account.get_extension_mut::<TransferHookAccount>()?;

    if !bool::from(account_extension.transferring) {
        return err!(BoringErrorCode::IsNotCurrentlyTransferring);
    }

    Ok(())
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
        bump = config.bump,
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

    #[account(
        mut,
        seeds = [BASE_SEED_BORING_VAULT, &config.vault_count.to_le_bytes()[..]],
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
        extensions::transfer_hook::program_id = crate::ID,
        seeds = [BASE_SEED_SHARE_TOKEN, boring_vault_state.key().as_ref()],
        bump,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
    pub clock: Sysvar<'info, Clock>,
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
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    payer: Signer<'info>,

    /// CHECK: ExtraAccountMetaList Account, must use these seeds
    #[account(
        init,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
        space = ExtraAccountMetaList::size_of(
            InitializeExtraAccountMetaList::extra_account_metas()?.len()
        )?,
        payer = payer
    )]
    pub extra_account_meta_list: AccountInfo<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program_2022: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<TransferConfig>(),
        seeds = [b"transfer-config", mint.key().as_ref()],
        bump,
    )]
    pub transfer_config: Account<'info, TransferConfig>,
}

// Define extra account metas to store on extra_account_meta_list account
impl<'info> InitializeExtraAccountMetaList<'info> {
    pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
        Ok(
            vec![
                ExtraAccountMeta::new_with_seeds(
                    &[
                        Seed::Literal {
                            bytes: "transfer-config".as_bytes().to_vec(),
                        },
                        Seed::AccountKey { index: 2 }, // Index of mint in InitializeExtraAccountMetaList context
                    ],
                    false, // is_signer
                    true // is_writable
                )?
            ]
        )
    }
}

// Order of accounts matters for this struct.
// The first 4 accounts are the accounts required for token transfer (source, mint, destination, owner)
// Remaining accounts are the extra accounts required from the ExtraAccountMetaList account
// These accounts are provided via CPI to this program from the token2022 program
#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(
        token::mint = mint, 
        token::authority = owner,
    )]
    pub source_token: InterfaceAccount<'info, TokenAccount>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        token::mint = mint,
    )]
    pub destination_token: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: source token account owner, can be SystemAccount or PDA owned by another program
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList Account,
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()], 
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    #[account(
        seeds = [b"transfer-config", mint.key().as_ref()],
        bump,
    )]
    pub transfer_config: Account<'info, TransferConfig>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct AllowAllTransfers<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [b"transfer-config", boring_vault_state.config.share_mint.key().as_ref()],
        bump,
    )]
    pub transfer_config: Account<'info, TransferConfig>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct EnforceTransferAllowList<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [b"transfer-config", boring_vault_state.config.share_mint.key().as_ref()],
        bump,
    )]
    pub transfer_config: Account<'info, TransferConfig>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct StopAllTransfers<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [b"transfer-config", boring_vault_state.config.share_mint.key().as_ref()],
        bump,
    )]
    pub transfer_config: Account<'info, TransferConfig>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64, args: UpdateTransferAllowListArgs)]
pub struct AddToTransferAllowList<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [b"transfer-config", boring_vault_state.config.share_mint.key().as_ref()],
        bump,
    )]
    pub transfer_config: Account<'info, TransferConfig>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64, args: UpdateTransferAllowListArgs)]
pub struct RemoveFromTransferAllowList<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        seeds = [BASE_SEED_BORING_VAULT_STATE, &vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault_state.config.authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [b"transfer-config", boring_vault_state.config.share_mint.key().as_ref()],
        bump,
    )]
    pub transfer_config: Account<'info, TransferConfig>,
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
        seeds = [BASE_SEED_BORING_VAULT, &args.vault_id.to_le_bytes()[..]],
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
        seeds = [BASE_SEED_BORING_VAULT, &args.vault_id.to_le_bytes()[..]],
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
        seeds = [BASE_SEED_BORING_VAULT, &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Account used to hold assets.
    pub boring_vault: AccountInfo<'info>,

    #[account()]
    /// CHECK: Checked in instruction
    pub cpi_digest: Account<'info, CpiDigest>,
}

#[derive(Accounts)]
pub struct ViewCpiDigest {}
