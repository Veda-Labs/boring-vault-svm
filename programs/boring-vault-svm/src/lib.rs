use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed};

mod instruction_operators;
use instruction_operators::*;
declare_id!("26YRHAHxMa569rQ73ifQDV9haF7Njcm3v7epVPvcpJsX");

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SerializableAccount {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[program]
pub mod boring_vault_svm {
    use super::*;

    pub fn serialize_operators(
        _ctx: Context<SerializeOperators>,
        operators: Vec<Operators>,
    ) -> Result<()> {
        let res = operators.try_to_vec()?;
        msg!("Serialized operators length: {:?}", res.len());
        Ok(())
    }

    pub fn initialize(ctx: Context<Initialize>, deployer: Pubkey) -> Result<()> {
        ctx.accounts.config.vault_count = 0;
        ctx.accounts.config.deployer = deployer;
        Ok(())
    }

    pub fn deploy(ctx: Context<Deploy>, authority: Pubkey, strategist: Pubkey) -> Result<()> {
        ctx.accounts.boring_vault.authority = authority;
        ctx.accounts.boring_vault.strategist = strategist;
        ctx.accounts.config.vault_count += 1;
        Ok(())
    }

    pub fn manage(
        ctx: Context<Manage>,
        boring_vault_id: u32,
        ix_program_id: Pubkey,
        ix_data: Vec<u8>,
        operators: Vec<Operators>,
        expected_size: u16,
    ) -> Result<()> {
        // Make sure the signer is the authority
        require_keys_eq!(
            ctx.accounts.signer.key(),
            ctx.accounts.boring_vault.authority
        );
        // Create hash digest from instruction data
        let hash = instruction_decoder_and_sanitizer(
            &ix_program_id,
            &ctx.remaining_accounts,
            &ix_data,
            &operators,
            expected_size,
        )?;

        msg!("Instruction hash: {:?}", hash);

        let needs_program_signature = ctx
            .remaining_accounts
            .iter()
            .any(|account| *account.owner == crate::ID && account.is_signer);

        // Sue remaining accounts to create AccountMeta
        let accounts = ctx
            .remaining_accounts
            .iter()
            .map(|account| {
                if account.is_writable {
                    AccountMeta::new(*account.key, account.is_signer)
                } else {
                    AccountMeta::new_readonly(*account.key, account.is_signer)
                }
            })
            .collect();

        // Create the instruction
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: ix_program_id,
            accounts: accounts,
            data: ix_data,
        };

        if needs_program_signature {
            invoke_signed(
                &ix,
                ctx.accounts.to_account_infos().as_slice(),
                &[&[
                    b"boring-vault",
                    &boring_vault_id.to_le_bytes(),
                    &[ctx.bumps.boring_vault],
                ]],
            )
        } else {
            invoke(&ix, ctx.accounts.to_account_infos().as_slice())
        }
        .map_err(Into::into)
    }
}

#[derive(Accounts)]
#[instruction(boring_vault_id: u32)]
pub struct Manage<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"boring-vault", &boring_vault_id.to_le_bytes()],
        bump,
    )]
    pub boring_vault: Account<'info, BoringVault>,
}

#[derive(Accounts)]
pub struct SerializeOperators<'info> {
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deploy<'info> {
    #[account(
        mut,
        seeds = [b"boring-vault-config"],
        bump,
    )]
    pub config: Account<'info, BoringVaultConfig>,
    #[account(
        init,
        payer = signer,
        space = 8 + 32 + 32,
        seeds = [b"boring-vault", &config.vault_count.to_le_bytes()[..], &[0u8; 28]],
        bump,
    )]
    pub boring_vault: Account<'info, BoringVault>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = signer,
        space = 8 + 32 + 4,
        seeds = [b"boring-vault-config"],
        bump,
    )]
    pub config: Account<'info, BoringVaultConfig>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct BoringVaultConfig {
    deployer: Pubkey, // Who can deploy new vaults.
    vault_count: u32, // Number of vaults deployed.
}

#[account]
pub struct BoringVault {
    authority: Pubkey,
    strategist: Pubkey,
}
