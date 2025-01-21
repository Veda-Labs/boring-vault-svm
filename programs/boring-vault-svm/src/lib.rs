use anchor_lang::prelude::*;
mod state;
use anchor_lang::system_program;
use anchor_spl::token_interface;
use state::*;
declare_id!("26YRHAHxMa569rQ73ifQDV9haF7Njcm3v7epVPvcpJsX");

#[program]
pub mod boring_vault_svm {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.vault_count = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn deploy(ctx: Context<Deploy>, args: DeployArgs) -> Result<()> {
        // Make sure the signer is the authority.
        require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.config.authority);

        // Make sure the authority is not the zero address.
        require_keys_neq!(args.authority, Pubkey::default());

        // Initialize vault.
        let vault = &mut ctx.accounts.boring_vault;
        vault.vault_id = ctx.accounts.config.vault_count;
        vault.authority = args.authority;
        vault.strategist = args.strategist;
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.initialized = true;
        vault.paused = false;

        // Update program config.
        ctx.accounts.config.vault_count += 1;

        msg!(
            "Boring Vault deployed successfully with share token {}",
            ctx.accounts.share_mint.key()
        );
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, args: DepositArgs) -> Result<()> {
        // Check if we are paused
        require_eq!(ctx.accounts.boring_vault.paused, false);

        let amount_in_jito_sol = match args.asset {
            DepositAsset::Sol => {
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

                // TODO: Mint JitoSOL using transferred SOL
                // This will require adding JitoSOL program accounts to the Deposit context
                // https://github.com/solana-program/stake-pool/blob/main/program/src/instruction.rs#L363C1-L378C21
                // example tx https://solscan.io/tx/2xo7GGcUtcz79viby1WW5GXimUW5ctSfynRyXtSardN73ZeUG7gmrZqjTQorNY67hQ5LTWSihyLs2nc5sDYd2eqm
                // Looks like we litearlly just serialize a 14 u8, then an amount as a u64
                // 0e40420f0000000000 example instruction

                const DEPOSIT_SOL_IX: u8 = 14; // 0x0e in hex
                let mut instruction_data = vec![DEPOSIT_SOL_IX];
                instruction_data.extend_from_slice(&args.deposit_amount.to_le_bytes());

                // Make CPI call to Jito's stake pool program
                anchor_lang::solana_program::program::invoke(
                    &anchor_lang::solana_program::instruction::Instruction {
                        program_id: jito_stake_pool_program_id, // You'll need to add this as a constant
                        accounts: vec![
                            // Add required accounts based on Jito's DepositSol instruction
                            // You'll need to add these to your Deposit context
                        ],
                        data: instruction_data,
                    },
                    &[/* Add account infos */],
                )?;
                let amount = 0;
                amount
            }
            DepositAsset::JitoSol => {
                // Transfer JitoSOL directly from user
                token_interface::transfer_checked(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        token_interface::TransferChecked {
                            from: ctx
                                .accounts
                                .user_jito_sol
                                .as_ref()
                                .unwrap()
                                .to_account_info(),
                            mint: ctx
                                .accounts
                                .jito_sol_mint
                                .as_ref()
                                .unwrap()
                                .to_account_info(),
                            to: ctx
                                .accounts
                                .vault_jito_sol
                                .as_ref()
                                .unwrap()
                                .to_account_info(),
                            authority: ctx.accounts.signer.to_account_info(),
                        },
                    ),
                    args.deposit_amount,
                    6, // JitoSOL decimals
                )?;

                args.deposit_amount
            }
        };

        let shares_to_mint =
            1000000000 * amount_in_jito_sol / ctx.accounts.boring_vault.exchange_rate;

        // Verify minimum shares
        require!(
            shares_to_mint >= args.min_mint_amount,
            ErrorCode::SlippageExceeded
        );

        // Mint shares to user
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_interface::MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_shares.to_account_info(),
                    authority: ctx.accounts.boring_vault.to_account_info(),
                },
                &[&[
                    b"boring-vault",
                    ctx.accounts.config.key().as_ref(),
                    &args.vault_id.to_le_bytes()[..],
                    &[ctx.bumps.boring_vault],
                ]],
            ),
            shares_to_mint,
        )?;
        Ok(())
    }
}

#[error_code]
pub enum ErrorCode {
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
}
