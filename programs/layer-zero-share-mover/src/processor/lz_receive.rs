use crate::{
    error::BoringErrorCode,
    seed::{PEER_SEED, SHARE_MOVER_SEED},
    state::{
        lz::{LzReceiveParams, PeerConfig},
        share_mover::ShareMover,
    },
};
use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::token_2022::spl_token_2022::ID as TOKEN_2022_PROGRAM_ID;
use common::message::decode_message;

// min accounts len for clear cpi, found here:
// https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/solana/programs/programs/endpoint/src/instructions/oapp/clear.rs
// 5 original + event_authority + endpoint_program
pub const CLEAR_MIN_ACCOUNTS_LEN: usize = 7;
// Accounts passed to execute_mint slice:
// 0 share_mover (signer), 1 vault_state, 2 share_mint, 3 recipient_ata,
// 4 token_program_2022, 5 boring_vault_program (program account)
pub const MINT_ACCOUNTS_LEN: usize = 6;

pub const CLEAR_DISCRIMINATOR: [u8; 8] = [250, 39, 28, 213, 123, 163, 133, 5];
pub const MINT_SHARES_DISCRIMINATOR: [u8; 8] = [24, 196, 132, 0, 183, 158, 216, 142];

#[derive(Clone, Copy)]
struct ShareMoverData {
    key: Pubkey,
    bump: u8,
    mint: Pubkey,
    endpoint_program: Pubkey,
    boring_vault_program: Pubkey,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct ClearParams {
    pub receiver: Pubkey,
    pub src_eid: u32,
    pub sender: [u8; 32],
    pub nonce: u64,
    pub guid: [u8; 32],
    pub message: Vec<u8>,
}

#[derive(Accounts)]
#[instruction(params: LzReceiveParams)]
pub struct LzReceive<'info> {
    #[account(
        mut,
        seeds = [SHARE_MOVER_SEED, share_mover.mint.as_ref()],
        bump = share_mover.bump,
        constraint = !share_mover.is_paused @ BoringErrorCode::ShareMoverPaused
    )]
    pub share_mover: Account<'info, ShareMover>,

    #[account(
        seeds = [PEER_SEED, &share_mover.key().to_bytes(), &params.src_eid.to_be_bytes()],
        bump = peer.bump,
        constraint = params.sender == peer.peer_address @ BoringErrorCode::PeerNotAuthorized
    )]
    pub peer: Account<'info, PeerConfig>,
}

impl<'info> LzReceive<'info> {
    fn execute_clear(
        share_mover_data: &ShareMoverData,
        accounts: &[AccountInfo<'info>],
        signer_seeds: &[&[u8]],
        params: &LzReceiveParams,
    ) -> Result<()> {
        require_eq!(
            accounts.len(),
            CLEAR_MIN_ACCOUNTS_LEN,
            BoringErrorCode::InvalidClearAccounts
        );

        // Expect the signer and endpoint program to be the correct ones
        require_eq!(
            accounts[0].key(),
            share_mover_data.key,
            BoringErrorCode::InvalidClearAccounts
        );
        require_eq!(
            accounts[6].key(),
            share_mover_data.endpoint_program,
            BoringErrorCode::InvalidClearAccounts
        );

        let clear_data = Self::build_clear_data(share_mover_data.key, params)?;

        let clear_ix = Instruction {
            program_id: share_mover_data.endpoint_program,
            accounts: vec![
                AccountMeta::new_readonly(accounts[0].key(), true), // signer
                AccountMeta::new_readonly(accounts[1].key(), false), // oapp_registry
                AccountMeta::new_readonly(accounts[2].key(), false), // nonce
                AccountMeta::new(accounts[3].key(), false),         // payload_hash (closes)
                AccountMeta::new(accounts[4].key(), false),         // endpoint
                AccountMeta::new_readonly(accounts[5].key(), false), // event_authority
                AccountMeta::new_readonly(accounts[6].key(), false), // endpoint program
            ],
            data: clear_data,
        };

        invoke_signed(&clear_ix, accounts, &[signer_seeds])?;

        Ok(())
    }

    fn execute_mint(
        accounts: &'info [AccountInfo<'info>],
        share_mover_data: &ShareMoverData,
        signer_seeds: &[&[u8]],
        recipient: &Pubkey,
        amount: u128,
    ) -> Result<()> {
        require_eq!(
            accounts.len(),
            MINT_ACCOUNTS_LEN,
            BoringErrorCode::InvalidMintAccounts
        );

        // Additional sanity checks to ensure the expected accounts are forwarded
        require_eq!(
            accounts[0].key(),
            share_mover_data.key,
            BoringErrorCode::InvalidMintAccounts
        );
        require_eq!(
            accounts[2].key(),
            share_mover_data.mint,
            BoringErrorCode::InvalidMintAccounts
        );
        require_eq!(
            accounts[4].key(),
            TOKEN_2022_PROGRAM_ID,
            BoringErrorCode::InvalidMintAccounts
        );
        require_eq!(
            accounts[5].key(),
            share_mover_data.boring_vault_program,
            BoringErrorCode::InvalidMintAccounts
        );

        let mint_data = Self::build_mint_data(recipient, u64::try_from(amount)?)?;

        let mint_ix = Instruction {
            program_id: share_mover_data.boring_vault_program,
            accounts: vec![
                AccountMeta::new_readonly(accounts[0].key(), true), // share_mover (signer, read-only suffices)
                AccountMeta::new_readonly(accounts[1].key(), false), // vault state
                AccountMeta::new(accounts[2].key(), false),         // share_mint
                AccountMeta::new(accounts[3].key(), false),         // recipient_ata
                AccountMeta::new_readonly(accounts[4].key(), false), // token_program
                AccountMeta::new_readonly(accounts[5].key(), false), // boring_vault_program
            ],
            data: mint_data,
        };

        invoke_signed(&mint_ix, &accounts, &[signer_seeds])?;

        Ok(())
    }

    // Helper methods for building instruction data
    fn build_clear_data(receiver: Pubkey, params: &LzReceiveParams) -> Result<Vec<u8>> {
        let mut data = CLEAR_DISCRIMINATOR.to_vec();

        let clear_params = ClearParams {
            receiver,
            src_eid: params.src_eid,
            sender: params.sender,
            nonce: params.nonce,
            guid: params.guid,
            message: params.message.clone(),
        };

        clear_params.serialize(&mut data)?;
        Ok(data)
    }

    fn build_mint_data(recipient: &Pubkey, amount: u64) -> Result<Vec<u8>> {
        let mut data = MINT_SHARES_DISCRIMINATOR.to_vec();
        recipient.serialize(&mut data)?;
        amount.serialize(&mut data)?;
        Ok(data)
    }
}

pub fn lz_receive<'info>(
    ctx: Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    params: &LzReceiveParams,
) -> Result<()> {
    require!(
        ctx.accounts.share_mover.allow_from,
        BoringErrorCode::NotAllowedFrom
    );
    require!(
        ctx.remaining_accounts.len() == CLEAR_MIN_ACCOUNTS_LEN + MINT_ACCOUNTS_LEN,
        BoringErrorCode::InvalidLzReceiveRemainingAccounts
    );

    let decoded_msg = decode_message(&params.message)?;

    require!(
        decoded_msg.amount > 0,
        BoringErrorCode::InvalidMessageAmount
    );
    require!(
        Pubkey::from(decoded_msg.recipient) != Pubkey::default(),
        BoringErrorCode::InvalidMessageRecipient
    );

    // Now that all checks have passed, safely update the inbound rate-limit state
    let clock = Clock::get()?;
    ctx.accounts
        .share_mover
        .check_inbound_rate_limit(decoded_msg.amount, clock.unix_timestamp)?;

    let share_mover_data = ShareMoverData {
        key: ctx.accounts.share_mover.key(),
        bump: ctx.accounts.share_mover.bump,
        mint: ctx.accounts.share_mover.mint,
        endpoint_program: ctx.accounts.share_mover.endpoint_program,
        boring_vault_program: ctx.accounts.share_mover.boring_vault_program,
    };

    // ShareMover PDA seeds
    let share_mover_seeds = &[
        SHARE_MOVER_SEED,
        share_mover_data.mint.as_ref(),
        &[share_mover_data.bump],
    ];

    let remaining_accounts = ctx.remaining_accounts;

    // Split remaining accounts into two groups with explicit validation
    let (clear_accounts, mint_accounts) = remaining_accounts.split_at(CLEAR_MIN_ACCOUNTS_LEN);

    LzReceive::execute_clear(&share_mover_data, clear_accounts, share_mover_seeds, params)?;

    LzReceive::execute_mint(
        mint_accounts,
        &share_mover_data,
        share_mover_seeds,
        &Pubkey::from(decoded_msg.recipient),
        decoded_msg.amount,
    )?;

    Ok(())
}
