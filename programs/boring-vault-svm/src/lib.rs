use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash, instruction::AccountMeta, program::invoke, program::invoke_signed,
};
mod instruction_parser;
use instruction_parser::*;
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

    pub fn manage(
        ctx: Context<Manage>,
        target_program_id: Pubkey,
        serialized_accounts: Vec<SerializableAccount>,
        instruction_data: Vec<u8>,
        parser: InstructionParser,
    ) -> Result<()> {
        let accounts: Vec<AccountMeta> = serialized_accounts
            .into_iter()
            .map(|acc| AccountMeta {
                pubkey: acc.pubkey,
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            })
            .collect();

        // Create hash digest from instruction data
        let mut hash_data = Vec::new();

        // 1. Hash important instruction elements
        let parsed_data = parser.parse_and_hash(&instruction_data)?;
        hash_data.extend(parsed_data);

        // 2. Hash the parser configuration itself
        let parser_bytes = parser.try_to_vec()?;
        hash_data.extend(parser_bytes);

        // 3. Hash target program
        hash_data.extend(target_program_id.as_ref());

        // Create final hash
        let hash = hash::hash(&hash_data);
        msg!("Instruction hash: {:?}", hash);

        // Check if we need invoke_signed
        let (program_address, bump) = Pubkey::find_program_address(&[b"some-seed"], &crate::ID);

        let needs_program_signature = accounts
            .iter()
            .any(|meta| meta.pubkey == program_address && meta.is_signer);

        // Create the instruction
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: target_program_id,
            accounts,
            data: instruction_data,
        };

        if needs_program_signature {
            invoke_signed(
                &ix,
                ctx.accounts.to_account_infos().as_slice(),
                &[&[b"some-seed", &[bump]]],
            )
        } else {
            invoke(&ix, ctx.accounts.to_account_infos().as_slice())
        }
        .map_err(Into::into)
    }
}

#[derive(Accounts)]
pub struct Manage<'info> {
    pub payer: Signer<'info>,
    // Add other required accounts
    pub system_program: Program<'info, System>,
}
