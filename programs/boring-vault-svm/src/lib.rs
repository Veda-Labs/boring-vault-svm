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
use rust_decimal::Decimal;
use switchboard_on_demand::on_demand::accounts::pull_feed::PullFeedAccountData;
mod utils;

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

    // Need to set all the other state
    pub fn deploy(ctx: Context<Deploy>, args: DeployArgs) -> Result<()> {
        // Make sure the signer is the authority.
        require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.config.authority);

        // Make sure the authority is not the zero address.
        require_keys_neq!(args.authority, Pubkey::default());

        // Initialize vault.
        let vault = &mut ctx.accounts.boring_vault;
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

    // TODO this could check that the decimals is correct by making a cpi
    pub fn update_asset_data(
        ctx: Context<UpdateAssetData>,
        args: UpdateAssetDataArgs,
    ) -> Result<()> {
        let asset_data = &mut ctx.accounts.asset_data;
        asset_data.decimals = args.asset_data.decimals;
        asset_data.allow_deposits = args.asset_data.allow_deposits;
        asset_data.allow_withdrawals = args.asset_data.allow_withdrawals;
        asset_data.share_premium_bps = args.asset_data.share_premium_bps;
        asset_data.price_feed = args.asset_data.price_feed;
        asset_data.inverse_price_feed = args.asset_data.inverse_price_feed;
        Ok(())
    }

    // TODO Create deposit functions for Sol, Token2022, and Token.
    pub fn deposit(ctx: Context<Deposit>, args: DepositArgs) -> Result<()> {
        // Handle transferring the deposit asset into the vault.
        let mut deposit_is_base_asset = false;
        match &ctx.accounts.deposit_mint {
            Some(mint) => {
                if mint.key() == ctx.accounts.boring_vault.teller.base_asset.key() {
                    deposit_is_base_asset = true;
                }
                let user_ata = ctx.accounts.user_ata.as_ref().unwrap();
                let vault_ata = ctx.accounts.vault_ata.as_ref().unwrap();
                // Accepting a Token2022
                // Transfer Token2022 from user to vault
                token_interface::transfer_checked(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        token_interface::TransferChecked {
                            from: user_ata.to_account_info(),
                            to: vault_ata.to_account_info(),
                            mint: mint.to_account_info(),
                            authority: ctx.accounts.signer.to_account_info(),
                        },
                    ),
                    args.deposit_amount,
                    ctx.accounts.asset_data.decimals,
                )?;
            }
            None => {
                if NATIVE.key() == ctx.accounts.boring_vault.teller.base_asset.key() {
                    deposit_is_base_asset = true;
                }
                // Accepting native SOL
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
            }
        }

        // TODO not a bad idea to use this Decimal logic for any math we are doing.
        let exchange_rate = ctx.accounts.boring_vault.teller.exchange_rate;
        let mut deposit_amount = Decimal::from(args.deposit_amount);
        deposit_amount
            .set_scale(ctx.accounts.asset_data.decimals as u32)
            .unwrap();
        msg!("Deposit amount: {:?}", deposit_amount);
        let mut exchange_rate = Decimal::from(exchange_rate);
        exchange_rate
            .set_scale(ctx.accounts.asset_data.decimals as u32)
            .unwrap();
        msg!("Exchange rate: {:?}", exchange_rate);

        let mut shares_to_mint = if deposit_is_base_asset {
            let res = deposit_amount.checked_mul(exchange_rate).unwrap();
            res
        } else {
            // Query price feed.
            let feed_account = ctx.accounts.price_feed.data.borrow();
            let feed = PullFeedAccountData::parse(feed_account).unwrap();

            let mut price = match feed.value() {
                Some(value) => value,
                None => return Err(BoringErrorCode::InvalidPriceFeed.into()),
            };
            msg!("Price: {:?}", price);

            if ctx.accounts.asset_data.inverse_price_feed {
                price = Decimal::from(PRECISION).checked_div(price).unwrap(); // 1 / price
            }

            let shares_to_mint = deposit_amount
                .checked_mul(price)
                .unwrap()
                .checked_div(exchange_rate)
                .unwrap();
            shares_to_mint
        };

        // Factor in share premium.
        if ctx.accounts.asset_data.share_premium_bps > 0 {
            let mut premium_bps = Decimal::from(ctx.accounts.asset_data.share_premium_bps);
            premium_bps.set_scale(4).unwrap();
            let premium_amount = shares_to_mint.checked_mul(premium_bps).unwrap();
            shares_to_mint = shares_to_mint.checked_sub(premium_amount).unwrap();
        }

        // Scale up to share decimals.
        // TODO note this uses precision right now which just so happens to be the same as the share decimals, but this is not guaranteed.
        let shares_to_mint = shares_to_mint
            .checked_mul(Decimal::from(PRECISION))
            .unwrap();

        let shares_to_mint = shares_to_mint.try_into().unwrap();
        msg!("Shares to mint: {:?}", shares_to_mint);

        // Verify minimum shares
        require!(
            shares_to_mint >= args.min_mint_amount,
            BoringErrorCode::SlippageExceeded
        );

        // Mint shares to user
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_2022.to_account_info(),
                token_interface::MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_shares.to_account_info(),
                    authority: ctx.accounts.boring_vault.to_account_info(),
                },
                &[&[
                    // PDA signer seeds for vault
                    b"boring-vault",
                    &args.vault_id.to_le_bytes()[..],
                    &[ctx.bumps.boring_vault],
                ]],
            ),
            shares_to_mint,
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

    // This code base is doing what I need to , passing in remaining accounts and then doing the CPI call with them.
    // TODO: https://github.com/coral-xyz/multisig
    // https://github.com/coral-xyz/multisig/blob/master/programs/multisig/src/lib.rs
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
        let boring_vault_key = ctx.accounts.boring_vault.key();
        let seeds = &[b"cpi-digest", boring_vault_key.as_ref(), digest.as_ref()];
        let (expected_pda, _) = Pubkey::find_program_address(seeds, &crate::ID);
        require!(
            expected_pda == cpi_digest.key(),
            BoringErrorCode::InvalidCpiDigest
        );

        msg!("Constructing CPI call");

        // Create new Vec<AccountInfo> with replacements
        let bank_key = ctx.accounts.boring_vault_bank.key();
        let vault_key = ctx.accounts.boring_vault.key();
        let accounts: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|account| {
                let key = account.key();
                let is_signer = if key == bank_key || key == vault_key {
                    true // default to true if key is bank or vault
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

        msg!("Validating account keys match");
        for (i, ix_account) in ix.accounts.iter().enumerate() {
            let remaining_account = &ctx.remaining_accounts[i];
            if ix_account.pubkey != remaining_account.key() {
                msg!(
                    "Account mismatch at index {}: ix account {} != remaining account {}",
                    i,
                    ix_account.pubkey,
                    remaining_account.key()
                );
                return Err(BoringErrorCode::InvalidAccounts.into());
            }
        }

        msg!("Making CPI call");

        let vault_seeds = &[
            b"boring-vault",
            &args.vault_id.to_le_bytes()[..],
            &[ctx.bumps.boring_vault],
        ];
        let bank_seeds = &[
            b"boring-vault-bank",
            &args.vault_id.to_le_bytes()[..],
            &[ctx.bumps.boring_vault_bank],
        ];

        // msg!("ix.accounts {:?}", ix.accounts);

        // msg!("remaining_accounts {:?}", ctx.remaining_accounts);

        // Make the CPI call.
        invoke_signed(&ix, ctx.remaining_accounts, &[vault_seeds, bank_seeds])?;

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

        msg!("Digest: {:?}", digest);

        Ok(ViewCpiDigestReturn { digest })
    }

    pub fn deposit_to_bank(ctx: Context<DepositToBank>, args: TransferSolArgs) -> Result<()> {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.signer.to_account_info(),
                    to: ctx.accounts.boring_vault_bank.to_account_info(),
                },
            ),
            args.amount,
        )?;

        Ok(())
    }

    pub fn transfer_sol(ctx: Context<TransferSol>, args: TransferSolArgs) -> Result<()> {
        // we expect remaining accounts to be of length 2
        let from = &ctx.remaining_accounts[0];
        let recipient = &ctx.remaining_accounts[1];

        // Create CPI context with PDA signer seeds
        let vault_seeds = &[
            b"boring-vault-bank",
            &args.vault_id.to_le_bytes()[..],
            &[ctx.bumps.boring_vault_bank],
        ];
        let seeds = &[&vault_seeds[..]];

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &from.key(),
            &recipient.key(),
            args.amount,
        );
        let is_bank_signer = ix.accounts[0].is_signer;
        msg!("is_bank_signer: {}", is_bank_signer);

        invoke_signed(&ix, ctx.remaining_accounts, seeds)?;

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
        seeds = [b"boring-vault", &config.vault_count.to_le_bytes()[..]],
        bump,
    )]
    pub boring_vault: Account<'info, BoringVault>,

    /// The mint of the share token.
    #[account(
        init,
        payer = signer,
        mint::decimals = args.decimals,
        mint::authority = boring_vault.key(),
        seeds = [b"share-token", boring_vault.key().as_ref()],
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
        mut,
        seeds = [b"boring-vault", &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault.config.authority == signer.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault: Account<'info, BoringVault>,
    pub system_program: Program<'info, System>,

    /// CHECK: can be zero account, or a Token2022 mint
    pub asset: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + std::mem::size_of::<AssetData>(),
        seeds = [
            b"asset-data",
            boring_vault.key().as_ref(),
            asset.key().as_ref(),
        ],
        bump
    )]
    pub asset_data: Account<'info, AssetData>,
}

#[derive(Accounts)]
#[instruction(args: DepositArgs)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // State
    #[account(
        mut,
        seeds = [b"boring-vault", &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault.config.paused == false @ BoringErrorCode::VaultPaused
    )]
    pub boring_vault: Account<'info, BoringVault>,

    // Deposit asset accounts
    // Optional Deposit asset mint accont
    // Some => trying to deposit a Token2022
    // None => trying to deposit NATIVE
    pub deposit_mint: Option<InterfaceAccount<'info, Mint>>,

    #[account(
        seeds = [
            b"asset-data",
            boring_vault.key().as_ref(),
            deposit_mint.as_ref().map_or(NATIVE, |mint| mint.key()).as_ref(),
        ],
        bump,
        constraint = asset_data.allow_deposits @ BoringErrorCode::AssetNotAllowed
    )]
    pub asset_data: Account<'info, AssetData>,

    /// User's Token associated token account
    #[account(
            mut,
            associated_token::mint = deposit_mint.as_ref().unwrap(),
            associated_token::authority = signer,
            associated_token::token_program = token_program,
        )]
    pub user_ata: Option<InterfaceAccount<'info, TokenAccount>>,

    /// Vault's Token associated token account
    #[account(
            mut,
            associated_token::mint = deposit_mint.as_ref().unwrap(),
            associated_token::authority = boring_vault,
            associated_token::token_program = token_program,
        )]
    pub vault_ata: Option<InterfaceAccount<'info, TokenAccount>>,

    // Programs
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    // Share Token
    /// The vault's share mint
    #[account(
            mut,
            seeds = [b"share-token", boring_vault.key().as_ref()],
            bump,
            constraint = share_mint.key() == boring_vault.config.share_mint @ BoringErrorCode::InvalidShareMint
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
        seeds = [b"boring-vault", &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault.config.paused == false @ BoringErrorCode::VaultPaused,
        constraint = signer.key() == boring_vault.config.authority.key() @ BoringErrorCode::NotAuthorized
    )]
    pub boring_vault: Account<'info, BoringVault>,

    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + std::mem::size_of::<CpiDigest>(),
        seeds = [
            b"cpi-digest",
            boring_vault.key().as_ref(),
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
        seeds = [b"boring-vault", &args.vault_id.to_le_bytes()[..]],
        bump,
        constraint = boring_vault.config.paused == false @ BoringErrorCode::VaultPaused,
        constraint = signer.key() == boring_vault.config.authority.key() @ BoringErrorCode::NotAuthorized // TODO make this strategist
    )]
    pub boring_vault: Account<'info, BoringVault>,

    #[account(
        mut,
        seeds = [b"boring-vault-bank", &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Bank account used to hold SOL.
    pub boring_vault_bank: AccountInfo<'info>,

    #[account()]
    /// CHECK: Checked in instruction
    pub cpi_digest: Account<'info, CpiDigest>,
}

#[derive(Accounts)]
#[instruction(args: ManageArgs)]
pub struct ViewCpiDigest<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [b"boring-vault", &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    pub boring_vault: Account<'info, BoringVault>,
}

#[derive(Accounts)]
#[instruction(args: TransferSolArgs)]
pub struct DepositToBank<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"boring-vault-bank", &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Bank account used to hold SOL.
    pub boring_vault_bank: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: TransferSolArgs)]
pub struct TransferSol<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"boring-vault-bank", &args.vault_id.to_le_bytes()[..]],
        bump,
    )]
    /// CHECK: Bank account used to hold SOL.
    pub boring_vault_bank: AccountInfo<'info>,

    // /// CHECK: Just receiving SOL
    // #[account(mut)]
    // pub recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct TransferSolArgs {
    pub vault_id: u64,
    pub amount: u64,
}
//         // TODO: Mint JitoSOL using transferred SOL
//         // This will require adding JitoSOL program accounts to the Deposit context
//         // https://github.com/solana-program/stake-pool/blob/main/program/src/instruction.rs#L363C1-L378C21
//         // example tx https://solscan.io/tx/2xo7GGcUtcz79viby1WW5GXimUW5ctSfynRyXtSardN73ZeUG7gmrZqjTQorNY67hQ5LTWSihyLs2nc5sDYd2eqm
//         // Looks like we litearlly just serialize a 14 u8, then an amount as a u64
//         // 0e40420f0000000000 example instruction

//         const DEPOSIT_SOL_IX: u8 = 14; // 0x0e in hex
//         let mut instruction_data = vec![DEPOSIT_SOL_IX];
//         instruction_data.extend_from_slice(&args.deposit_amount.to_le_bytes());

//         // Make CPI call to Jito's stake pool program
//         // anchor_lang::solana_program::program::invoke(
//         //     &anchor_lang::solana_program::instruction::Instruction {
//         //         program_id: jito_stake_pool_program_id, // You'll need to add this as a constant
//         //         accounts: vec![
//         //             // Add required accounts based on Jito's DepositSol instruction
//         //             // You'll need to add these to your Deposit context
//         //         ],
//         //         data: instruction_data,
//         //     },
//         //     &[/* Add account infos */],
//         // )?;
//         let amount = 0;
//         amount
