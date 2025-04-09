use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum Operator {
    Noop,
    IngestInstruction(u32, u8), // (ix_index, length)
    IngestAccount(u8),          // (account_index)
    IngestInstructionDataSize,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Operators {
    pub operators: Vec<Operator>,
}

impl Operator {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        self.serialize(&mut bytes).unwrap();
        bytes
    }
}

impl Operators {
    pub fn apply_operators(
        &self,
        ix_program_id: &Pubkey,
        ix_accounts: &[AccountInfo],
        ix_data: &[u8],
    ) -> Result<[u8; 32]> {
        let mut hash_data: Vec<u8> = Vec::new();

        // Add the ix_program_id to the hash_data
        hash_data.extend(ix_program_id.to_bytes());

        // Iterate over operators and apply them
        for operator in &self.operators {
            match operator {
                Operator::Noop => {}
                Operator::IngestInstruction(ix_index, length) => {
                    let from = *ix_index as usize;
                    let to = from + *length as usize;
                    hash_data.extend_from_slice(&ix_data[from..to]);
                }
                Operator::IngestAccount(account_index) => {
                    let account = &ix_accounts[*account_index as usize];
                    hash_data.extend_from_slice(account.key.as_ref());
                    hash_data.push(account.is_signer as u8);
                    hash_data.push(account.is_writable as u8);
                }
                Operator::IngestInstructionDataSize => {
                    hash_data.extend_from_slice(&(ix_data.len() as u64).to_le_bytes());
                }
            }
        }

        Ok(hash(&hash_data).to_bytes())
    }
}
