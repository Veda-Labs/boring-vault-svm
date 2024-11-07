use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub enum BaseOperators {
    Ingest { start: u16, length: u8 }, // start, length add data to the hash. Note max length is 255 bytes, maybe I should + 1 the length?
    Size,                              // Add the size of the instruction data to the hash
    AssertBytes1 { start: u16, expected: [u8; 1] },
    AssertBytes2 { start: u16, expected: [u8; 2] },
    AssertBytes4 { start: u16, expected: [u8; 4] },
    AssertBytes8 { start: u16, expected: [u8; 8] },
    AssertBytes32 { start: u16, expected: [u8; 32] },
    Noop, // Do nothing
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub enum Operators {
    Base(BaseOperators),
    AccountRead {
        ix_account_index: u8,
        operators: Vec<BaseOperators>,
    },
}

pub fn instruction_decoder_and_sanitizer(
    ix_program_id: &Pubkey,
    ix_accounts: &[AccountInfo],
    ix_data: &[u8],
    ix_operators: &[Operators],
    expected_size: u16,
) -> Result<[u8; 32]> {
    require!(
        expected_size <= 4_096,
        CustomError::InvalidInstructionDataSize
    );
    let mut hash_data = Vec::with_capacity(expected_size as usize);

    // This function needs to
    // Hash the ix_program_id
    hash_data.extend(ix_program_id.to_bytes());
    // Hash all the ix_accounts
    hash_data.extend(ix_accounts.iter().flat_map(|account| {
        let mut account_data = account.key.to_bytes().to_vec();
        account_data.push(account.is_signer as u8);
        account_data.push(account.is_writable as u8);
        account_data
    }));
    // Iterate through all operators and apply them to the ix_data
    hash_data.extend(apply_operators(ix_accounts, ix_data, ix_operators)?);
    // Hash the instruction operators
    hash_data.extend(
        ix_operators
            .iter()
            .flat_map(|operator| operator.try_to_vec().unwrap()),
    );

    require!(
        hash_data.len() == expected_size as usize,
        CustomError::InvalidInstructionDataSize
    );
    // Return the hash data
    Ok(hash(&hash_data).to_bytes())
}

fn apply_operators(
    ix_accounts: &[AccountInfo],
    ix_data: &[u8],
    ix_operators: &[Operators],
) -> Result<Vec<u8>> {
    let mut hash_data = Vec::new();

    for operator in ix_operators {
        match operator {
            Operators::Base(base_operator) => {
                let operator_data = apply_base_operator(ix_data, base_operator)?;
                hash_data.extend(operator_data);
            }
            Operators::AccountRead {
                ix_account_index,
                operators,
            } => {
                let account = &ix_accounts[*ix_account_index as usize];
                let account_data = account
                    .try_borrow_data()
                    .map_err(|_| ProgramError::InvalidInstructionData)?;
                let nested_result = apply_base_operators(&account_data, operators)?;
                hash_data.extend(nested_result);
            }
        }
    }
    Ok(hash_data)
}

fn apply_base_operators(ix_data: &[u8], operators: &[BaseOperators]) -> Result<Vec<u8>> {
    let mut hash_data = Vec::new();
    for operator in operators {
        let operator_data = apply_base_operator(ix_data, operator)?;
        hash_data.extend(operator_data);
    }
    Ok(hash_data)
}

fn apply_base_operator(ix_data: &[u8], operator: &BaseOperators) -> Result<Vec<u8>> {
    let mut hash_data = Vec::new();

    match operator {
        BaseOperators::Ingest { start, length } => {
            let operator_data = ix_data
                .get(*start as usize..(*start + *length as u16) as usize)
                .ok_or(ProgramError::InvalidInstructionData)?;
            hash_data.extend(operator_data);
        }
        BaseOperators::Size => {
            hash_data.extend(ix_data.len().to_le_bytes());
        }
        BaseOperators::AssertBytes1 { start, expected } => {
            let operator_data = ix_data
                .get(*start as usize..(*start + 1) as usize)
                .ok_or(ProgramError::InvalidInstructionData)?;
            if operator_data != expected {
                return Err(ProgramError::InvalidInstructionData.into());
            }
        }
        BaseOperators::AssertBytes2 { start, expected } => {
            let operator_data = ix_data
                .get(*start as usize..(*start + 2) as usize)
                .ok_or(ProgramError::InvalidInstructionData)?;
            if operator_data != expected {
                return Err(ProgramError::InvalidInstructionData.into());
            }
        }
        BaseOperators::AssertBytes4 { start, expected } => {
            let operator_data = ix_data
                .get(*start as usize..(*start + 4) as usize)
                .ok_or(ProgramError::InvalidInstructionData)?;
            if operator_data != expected {
                return Err(ProgramError::InvalidInstructionData.into());
            }
        }
        BaseOperators::AssertBytes8 { start, expected } => {
            let operator_data = ix_data
                .get(*start as usize..(*start + 8) as usize)
                .ok_or(ProgramError::InvalidInstructionData)?;
            if operator_data != expected {
                return Err(ProgramError::InvalidInstructionData.into());
            }
        }
        BaseOperators::AssertBytes32 { start, expected } => {
            let operator_data = ix_data
                .get(*start as usize..(*start + 32) as usize)
                .ok_or(ProgramError::InvalidInstructionData)?;
            if operator_data != expected {
                return Err(ProgramError::InvalidInstructionData.into());
            }
        }
        BaseOperators::Noop => (),
    }
    Ok(hash_data)
}

// Errors
#[error_code]
pub enum CustomError {
    #[msg("Instruction data size does not match expected size")]
    InvalidInstructionDataSize,
}
