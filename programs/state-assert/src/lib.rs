#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

declare_id!("72mmDHDfvH1hGgo4thWjhpQRASkebRW1fjFMRzE5zimG");

const MAX_STACK_SIZE: u8 = 16;

#[program]
pub mod state_assert {
    use super::*;

    pub fn setup_stack(ctx: Context<SetupStack>) -> Result<()> {
        msg!("Setting up stack for: {:?}", ctx.accounts.signer);
        Ok(())
    }

    pub fn push_state_assert(
        ctx: Context<PushStateAssert>,
        data_offset: u16,
        compare_to: u64,
        comparison_method: ComparisonMethod,
        direction: ChangeDirection,
    ) -> Result<()> {
        // Get account data as a byte slice
        let account_data = ctx.accounts.target_account.try_borrow_data()?;

        // Check if we have enough data
        require!(
            (data_offset as usize) + 8 <= account_data.len(),
            ErrorCode::InvalidDataOffset
        );

        // Extract the u64 from the data at the offset
        let data_start = data_offset as usize;
        let data_end = data_start + 8;
        let initial_value_bytes = &account_data[data_start..data_end];
        let initial_value = u64::from_le_bytes(initial_value_bytes.try_into().unwrap());

        // Create the state assert object
        let state_assert = StateAssert {
            target_account: ctx.accounts.target_account.key(),
            data_offset,
            initial_value,
            compare_to,
            comparison_method,
            direction,
        };

        // Push to the stack
        ctx.accounts.user_stack.push(state_assert)?;

        msg!("Pushed assert");
        Ok(())
    }

    pub fn pop_state_assert(ctx: Context<PopStateAssert>) -> Result<()> {
        // Make sure we have at least one item in the stack
        require!(
            !ctx.accounts.user_stack.stack.is_empty(),
            ErrorCode::EmptyStack
        );

        // Pop the last state assert from the stack
        let state_assert = ctx.accounts.user_stack.pop()?;

        // Check that the target account matches
        require!(
            ctx.accounts.target_account.key() == state_assert.target_account,
            ErrorCode::AccountMismatch
        );

        // Get the current value from the account
        let account_data = ctx.accounts.target_account.try_borrow_data()?;

        // Check if we have enough data
        require!(
            (state_assert.data_offset as usize) + 8 <= account_data.len(),
            ErrorCode::InvalidDataOffset
        );

        // Extract the current u64 value
        let data_start = state_assert.data_offset as usize;
        let data_end = data_start + 8;
        let current_bytes = &account_data[data_start..data_end];
        let current_value = u64::from_le_bytes(current_bytes.try_into().unwrap());

        // Check direction constraint
        match state_assert.direction {
            ChangeDirection::Increase => {
                require!(
                    current_value >= state_assert.initial_value,
                    ErrorCode::DirectionConstraintViolated
                );
            }
            ChangeDirection::Decrease => {
                require!(
                    current_value <= state_assert.initial_value,
                    ErrorCode::DirectionConstraintViolated
                );
            }
            ChangeDirection::Any => {
                // No direction constraint
            }
        }

        // Calculate the difference
        let difference = if current_value >= state_assert.initial_value {
            current_value - state_assert.initial_value
        } else {
            state_assert.initial_value - current_value
        };

        // Perform the assertion
        match state_assert.comparison_method {
            ComparisonMethod::Log => {
                msg!(
                    "Log assert - Current: {}, Saved: {}, Diff: {}, Compare To: {}",
                    current_value,
                    state_assert.initial_value,
                    difference,
                    state_assert.compare_to
                );
            }
            ComparisonMethod::GT => {
                require!(
                    difference > state_assert.compare_to,
                    ErrorCode::AssertionFailed
                );
            }
            ComparisonMethod::LT => {
                require!(
                    difference < state_assert.compare_to,
                    ErrorCode::AssertionFailed
                );
            }
            ComparisonMethod::GTE => {
                require!(
                    difference >= state_assert.compare_to,
                    ErrorCode::AssertionFailed
                );
            }
            ComparisonMethod::LTE => {
                require!(
                    difference <= state_assert.compare_to,
                    ErrorCode::AssertionFailed
                );
            }
            ComparisonMethod::EQ => {
                require!(
                    difference == state_assert.compare_to,
                    ErrorCode::AssertionFailed
                );
            }
        }

        msg!(
            "Assertion passed - Type: {:?}",
            state_assert.comparison_method
        );
        Ok(())
    }
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid data offset")]
    InvalidDataOffset,
    #[msg("Empty stack")]
    EmptyStack,
    #[msg("Account mismatch")]
    AccountMismatch,
    #[msg("Assertion failed")]
    AssertionFailed,
    #[msg("Stack overflow - maximum capacity of StackAsserts reached")]
    StackOverflow,
    #[msg("Direction constraint violated")]
    DirectionConstraintViolated,
}

#[account]
#[derive(Debug)]
pub struct StateAssertStack {
    pub stack: [StateAssert; MAX_STACK_SIZE as usize],
    pub len: u8,
}

impl StateAssertStack {
    pub fn push(&mut self, sa: StateAssert) -> Result<()> {
        require!(self.len < MAX_STACK_SIZE, ErrorCode::StackOverflow);
        self.stack[self.len as usize] = sa;
        self.len += 1;

        Ok(())
    }

    // Note this does not clear the old value, the space in the account does not change,
    // and since we are tracking the len, we can safely ignore zeroing this struct.
    pub fn pop(&mut self) -> Result<StateAssert> {
        require!(self.len > 0, ErrorCode::EmptyStack);
        let sa = self.stack[(self.len - 1) as usize].clone();
        self.len -= 1;

        Ok(sa)
    }
}

// Add a direction enum to specify expected change direction
#[derive(Debug, AnchorSerialize, AnchorDeserialize, Clone)]
pub enum ChangeDirection {
    Increase, // Value should go up (or stay same)
    Decrease, // Value should go down (or stay same)
    Any,      // No direction enforcement
}

#[derive(Debug, AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StateAssert {
    pub target_account: Pubkey, // the account we need to read data from
    pub data_offset: u16, // how many bytes in target_account data to index before extracting initial_value
    pub initial_value: u64, // where the initial value is stored on push operations
    pub compare_to: u64,  // the value we are comparing the change in value to
    pub comparison_method: ComparisonMethod, // how to compare the delta value and compare_to
    pub direction: ChangeDirection, // the direction we expect delta value to change in
}

#[derive(Debug, AnchorSerialize, AnchorDeserialize, Clone)]
pub enum ComparisonMethod {
    Log,
    GT,
    LT,
    GTE,
    LTE,
    EQ,
}

#[derive(Accounts)]
pub struct SetupStack<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = 8 + std::mem::size_of::<StateAssertStack>(),
        seeds = [b"stack", signer.key().as_ref()],
        bump,
    )]
    pub user_stack: Account<'info, StateAssertStack>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PushStateAssert<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: READ ONLY
    pub target_account: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"stack", signer.key().as_ref()],
        bump,
    )]
    pub user_stack: Account<'info, StateAssertStack>,
}

#[derive(Accounts)]
pub struct PopStateAssert<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: READ ONLY
    pub target_account: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"stack", signer.key().as_ref()],
        bump,
    )]
    pub user_stack: Account<'info, StateAssertStack>,
}
