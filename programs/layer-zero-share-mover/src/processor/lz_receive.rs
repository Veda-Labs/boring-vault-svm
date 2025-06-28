use crate::{
    error::BoringErrorCode,
    message::{decode_message, ShareBridgeMessage},
    seed::{PEER_SEED, SHARE_MOVER_SEED},
    state::ShareMover,
    utils::{ClearParams, LzReceiveParams, PeerConfig},
};
use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::token_interface::Mint;

// min accounts len for clear cpi, found here:
// https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/packages/layerzero-v2/solana/programs/programs/endpoint/src/instructions/oapp/clear.rs
pub const CLEAR_MIN_ACCOUNTS_LEN: usize = 5;
pub const MINT_ACCOUNTS_LEN: usize = 5;

// Add discriminators as constants for better maintainability
pub const CLEAR_DISCRIMINATOR: [u8; 8] = [250, 39, 28, 213, 123, 163, 133, 5];
pub const MINT_SHARES_DISCRIMINATOR: [u8; 8] = [24, 196, 132, 0, 183, 158, 216, 142];

#[derive(Clone, Copy)]
struct ShareMoverData {
    key: Pubkey,
    bump: u8,
    mint: Pubkey,
    peer_decimals: u8,
    endpoint_program: Pubkey,
    boring_vault_program: Pubkey,
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
        constraint = params.sender == peer.peer_address @ BoringErrorCode::NotAuthorized
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
        // Validate we have the right number of accounts
        require_eq!(
            accounts.len(),
            CLEAR_MIN_ACCOUNTS_LEN,
            BoringErrorCode::InvalidMessage
        );

        // Build clear instruction data
        let clear_data = Self::build_clear_data(share_mover_data.key, params)?;

        // Build instruction with validated account metas
        let clear_ix = Instruction {
            program_id: share_mover_data.endpoint_program,
            accounts: vec![
                AccountMeta::new_readonly(share_mover_data.key, true), // signer
                AccountMeta::new_readonly(accounts[0].key(), false),   // oapp_registry
                AccountMeta::new_readonly(accounts[1].key(), false),   // nonce
                AccountMeta::new(accounts[2].key(), false),            // payload_hash (closes)
                AccountMeta::new(accounts[3].key(), false),            // endpoint
            ],
            data: clear_data,
        };

        // Execute with proper error handling
        invoke_signed(&clear_ix, accounts, &[signer_seeds]).map_err(|e| {
            msg!("Clear CPI failed: {}", e);
            anchor_lang::error::Error::from(e)
        })?;

        Ok(())
    }

    fn execute_mint(
        accounts: &'info [AccountInfo<'info>],
        share_mover_data: &ShareMoverData,
        signer_seeds: &[&[u8]],
        vault_id: u64,
        amount: u128,
    ) -> Result<()> {
        // Validate we have the right number of accounts
        require!(
            accounts.len() >= MINT_ACCOUNTS_LEN,
            BoringErrorCode::InvalidMessage
        );

        // convert amount to u64 and appropriate decimals for the mint
        // deserialize the mint to get solana mint decimals
        let mint_account = &accounts[2];
        let mint_data = InterfaceAccount::<'info, Mint>::try_from(mint_account)?;

        let mint_amount = u64::try_from(
            ShareBridgeMessage::convert_amount_decimals(
                amount,
                share_mover_data.peer_decimals,
                mint_data.decimals,
            )
            .ok_or(BoringErrorCode::InvalidMessageAmount)?,
        )
        .map_err(|_| BoringErrorCode::InvalidMessageAmount)?;

        // Build mint instruction data
        let mint_data = Self::build_mint_data(vault_id, mint_amount);

        // Build instruction
        let mint_ix = Instruction {
            program_id: share_mover_data.boring_vault_program,
            accounts: vec![
                AccountMeta::new_readonly(accounts[0].key(), true), // bridge_authority (signer)
                AccountMeta::new_readonly(accounts[1].key(), false), // vault
                AccountMeta::new(accounts[2].key(), false),         // share_mint
                AccountMeta::new(accounts[3].key(), false),         // recipient_ata
                AccountMeta::new_readonly(accounts[4].key(), false), // token_program
            ],
            data: mint_data,
        };

        // Get exactly the accounts we need
        let mint_accounts = &accounts[..MINT_ACCOUNTS_LEN];

        invoke_signed(&mint_ix, mint_accounts, &[signer_seeds]).map_err(|e| {
            msg!("Mint CPI failed: {}", e);
            anchor_lang::error::Error::from(e)
        })?;

        Ok(())
    }

    // Helper methods for building instruction data
    fn build_clear_data(receiver: Pubkey, params: &LzReceiveParams) -> Result<Vec<u8>> {
        let mut data = Vec::with_capacity(256); // Pre-allocate reasonable size
        data.extend_from_slice(&CLEAR_DISCRIMINATOR);

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

    fn build_mint_data(vault_id: u64, amount: u64) -> Vec<u8> {
        let mut data = Vec::with_capacity(24); // discriminator + 2 u64s
        data.extend_from_slice(&MINT_SHARES_DISCRIMINATOR);
        data.extend_from_slice(&vault_id.to_le_bytes());
        data.extend_from_slice(&amount.to_le_bytes());
        data
    }
}

pub fn lz_receive<'info>(
    ctx: Context<'_, '_, 'info, 'info, LzReceive<'info>>,
    params: &LzReceiveParams,
) -> Result<()> {
    // Validate we have enough remaining accounts
    require!(
        ctx.remaining_accounts.len() >= CLEAR_MIN_ACCOUNTS_LEN + MINT_ACCOUNTS_LEN,
        BoringErrorCode::InvalidMessage
    );

    // Decode and validate the cross-chain message
    let decoded_msg = decode_message(&params.message)?;

    let clock = Clock::get()?;
    ctx.accounts
        .share_mover
        .check_inbound_rate_limit(decoded_msg.amount, clock.unix_timestamp)?;

    // Additional validation on decoded message
    require!(
        decoded_msg.amount > 0,
        BoringErrorCode::InvalidMessageAmount
    );
    require!(
        Pubkey::from(decoded_msg.recipient) != Pubkey::default(),
        BoringErrorCode::InvalidMessageRecipient
    );

    let share_mover_data = ShareMoverData {
        key: ctx.accounts.share_mover.key(),
        bump: ctx.accounts.share_mover.bump,
        mint: ctx.accounts.share_mover.mint,
        peer_decimals: ctx.accounts.share_mover.peer_decimals,
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
    let (clear_accounts, remaining) = remaining_accounts.split_at(CLEAR_MIN_ACCOUNTS_LEN);
    let (mint_accounts, extra) = remaining.split_at(MINT_ACCOUNTS_LEN);

    // validate no extra accounts
    require_eq!(extra.len(), 0, BoringErrorCode::InvalidMessageExtraAccounts);

    // Validate the ShareMover account is passed as the bridge authority
    require_keys_eq!(
        mint_accounts[0].key(),
        share_mover_data.key,
        BoringErrorCode::InvalidBridgeAuthority
    );

    // Execute clear CPI
    LzReceive::execute_clear(&share_mover_data, clear_accounts, share_mover_seeds, params)?;

    // Execute mint CPI
    LzReceive::execute_mint(
        mint_accounts,
        &share_mover_data,
        share_mover_seeds,
        decoded_msg.vault_id,
        decoded_msg.amount,
    )?;

    msg!(
        "Minted {} shares to {} via LayerZero bridge from chain {}",
        decoded_msg.amount,
        Pubkey::from(decoded_msg.recipient),
        params.src_eid
    );
    Ok(())
}
