use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum Operator {
    Noop,
    IngestInstruction(u32, u8), // (ix_index, length)
    IngestAccount(u8),          // (account_index)
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
        expected_size: u16,
    ) -> Result<[u8; 32]> {
        require!(expected_size <= 4_096, OperatorError::ExpectedSizeTooLarge);

        let mut hash_data: Vec<u8> = Vec::with_capacity(expected_size as usize);

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
            }
        }

        // Add the operators to the hash_data
        hash_data.extend(
            self.operators
                .iter()
                .flat_map(|operator| operator.to_bytes()),
        );

        require!(
            hash_data.len() == expected_size as usize,
            OperatorError::ExpectedSizeMismatch
        );

        Ok(hash(&hash_data).to_bytes())
    }
}

#[error_code]
pub enum OperatorError {
    #[msg("Invalid operator")]
    InvalidOperator,
    #[msg("Expected size too large")]
    ExpectedSizeTooLarge,
    #[msg("Expected size mismatch")]
    ExpectedSizeMismatch,
}
