use crate::{
    constants::{BURN_SHARES_DISCRIMINATOR, PEER_SEED, SEND_DISCRIMINATOR, SHARE_MOVER_SEED},
    error::BoringErrorCode,
    state::{lz::PeerConfig, share_mover::ShareMover},
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    system_program::ID as SYSTEM_PROGRAM_ID,
};
use anchor_spl::{
    token_2022::{spl_token_2022::ID as TOKEN_2022_PROGRAM_ID, Token2022},
    token_interface::{Mint, TokenAccount},
};
use boring_vault_svm::{BoringVault, BASE_SEED_BORING_VAULT_STATE};
use common::message::{encode_message, ShareBridgeMessage};

// top level cpi (endpoint::send) accounts:

// [0] sender (signer)
// [1] send_library_program
// [2] send_library_config
// [3] default_send_library_config
// [4] send_library_info
// [5] endpoint_settings
// [6] nonce
// [7] event_authority
// [8] endpoint_program
const LAYERZERO_SEND_ACCOUNTS_LEN: usize = 9;

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendMessageParams {
    pub dst_eid: u32,        // Destination chain endpoint ID
    pub recipient: [u8; 32], // Recipient address (32 bytes for any chain)
    pub amount: u64,         // Amount of shares to bridge
    pub options: Vec<u8>,    // LayerZero messaging options
    pub native_fee: u64,     // Native fee amount (from quote)
    pub lz_token_fee: u64,   // LZ token fee amount (from quote)
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LayerZeroSendParams {
    pub dst_eid: u32,
    pub receiver: [u8; 32],
    pub message: Vec<u8>,
    pub options: Vec<u8>,
    pub native_fee: u64,
    pub lz_token_fee: u64,
}

#[derive(Accounts)]
#[instruction(params: SendMessageParams)]
pub struct Send<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [SHARE_MOVER_SEED, vault.config.share_mint.as_ref()],
        constraint = !share_mover.is_paused @ BoringErrorCode::ShareMoverPaused,
        bump,

    )]
    pub share_mover: Account<'info, ShareMover>,

    #[account(
        seeds = [
            PEER_SEED,
            share_mover.key().as_ref(),
            &params.dst_eid.to_be_bytes()
        ],
        bump
    )]
    pub peer: Account<'info, PeerConfig>,

    #[account(
        seeds = [
            BASE_SEED_BORING_VAULT_STATE,
            &vault.config.vault_id.to_le_bytes()
        ],
        bump,
        seeds::program = share_mover.boring_vault_program,
        constraint = !vault.config.paused @ BoringErrorCode::VaultPaused
    )]
    pub vault: Account<'info, BoringVault>,

    #[account(
        mut,
        constraint = share_mint.key() == vault.config.share_mint @ BoringErrorCode::InvalidShareMint
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = source_token_account.amount >= params.amount @ BoringErrorCode::InsufficientBalance,
        associated_token::mint = share_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(address = TOKEN_2022_PROGRAM_ID)]
    pub token_program: Program<'info, Token2022>,

    #[account(address = SYSTEM_PROGRAM_ID)]
    pub system_program: Program<'info, System>,

    #[account(address = share_mover.boring_vault_program)]
    /// CHECK: Configured by admin, known boring vault program
    pub boring_vault_program: AccountInfo<'info>,
}

impl<'info> Send<'info> {
    fn execute_burn_shares<'a>(
        user: &AccountInfo<'a>,
        share_mover: &AccountInfo<'a>,
        vault: &AccountInfo<'a>,
        share_mint: &AccountInfo<'a>,
        source_token_account: &AccountInfo<'a>,
        token_program: &AccountInfo<'a>,
        boring_vault_program: &AccountInfo<'a>,
        share_mover_data: &ShareMoverData,
        share_mover_seeds: &[&[u8]],
        amount: u64,
    ) -> Result<()> {
        let mut burn_data = BURN_SHARES_DISCRIMINATOR.to_vec();
        burn_data.extend_from_slice(&amount.to_le_bytes());

        let burn_ix = Instruction {
            program_id: share_mover_data.boring_vault_program,
            accounts: vec![
                AccountMeta::new_readonly(user.key(), true),   // signer
                AccountMeta::new(share_mover.key(), true),     // share_mover (signer)
                AccountMeta::new_readonly(vault.key(), false), // vault
                AccountMeta::new(share_mint.key(), false),     // share_mint (mut)
                AccountMeta::new(source_token_account.key(), false), // source_token_account (mut)
                AccountMeta::new_readonly(token_program.key(), false), // token_program
                AccountMeta::new_readonly(boring_vault_program.key(), false), // boring_vault_program
            ],
            data: burn_data,
        };

        let burn_accounts = vec![
            user.clone(),
            share_mover.clone(),
            vault.clone(),
            share_mint.clone(),
            source_token_account.clone(),
            token_program.clone(),
            boring_vault_program.clone(),
        ];

        invoke_signed(&burn_ix, &burn_accounts, &[share_mover_seeds])?;

        Ok(())
    }

    fn execute_layerzero_send(
        share_mover: &AccountInfo<'info>,
        accounts: &[AccountInfo<'info>],
        share_mover_data: &ShareMoverData,
        signer_seeds: &[&[u8]],
        peer_address: &[u8; 32],
        params: &SendMessageParams,
        combined_options: Vec<u8>,
        message: Vec<u8>,
    ) -> Result<()> {
        require!(
            accounts.len() >= LAYERZERO_SEND_ACCOUNTS_LEN,
            BoringErrorCode::InvalidMessage
        );

        let lz_send_params = LayerZeroSendParams {
            dst_eid: params.dst_eid,
            receiver: *peer_address,
            message,
            options: combined_options,
            native_fee: params.native_fee,
            lz_token_fee: params.lz_token_fee,
        };

        let mut send_data = Vec::new();
        send_data.extend_from_slice(&SEND_DISCRIMINATOR);
        lz_send_params.serialize(&mut send_data)?;

        // NOTE: After top level accounts, this is what we expect in the remaining accounts:
        // if native fee, cpi (unl::send) to dvn accounts:
        // [0] signer (endpoint)
        // [1] unl
        // [2] send config
        // [3] default send config
        // [4] payer (signer)
        // [5] treasury (native)
        // [6] system_program

        // if lz token fee, cpi (unl::send_with_lz_token) to lz token program:
        // [0] signer (endpoint)
        // [1] unl
        // [2] send config
        // [3] default send config
        // [4] payer (signer)
        // [5] treasury (native)
        // [6] system_program
        // [7] lz_token_source
        // [8] lz_token_treasury
        // [9] lz_token_mint
        // [10] token_program

        // should we be validating the accounts here? on the one hand, its redundant,
        // and we should trust LZ contracts, frontend has responsiblity to pass the correct state
        // on the other hand, paranoia

        // NOTE: We need to add share_mover here instead of passing it due to solana tx size constraints,
        // if share_mover is added as a signer to remaining accounts, we are over the 1232kb limit.
        // see send_lz.ts for more details on how to pass in accounts
        let mut account_metas = vec![
            AccountMeta::new_readonly(share_mover_data.key, true), // sender (signer)
        ];

        for account in accounts.iter() {
            account_metas.push(AccountMeta {
                pubkey: account.key(),
                is_signer: account.is_signer,
                is_writable: account.is_writable,
            });
        }

        let send_instruction = Instruction {
            program_id: share_mover_data.endpoint_program,
            accounts: account_metas,
            data: send_data,
        };

        let mut account_infos = vec![share_mover.clone()];
        account_infos.extend_from_slice(accounts);

        invoke_signed(&send_instruction, &account_infos, &[signer_seeds])?;

        Ok(())
    }
}

pub fn send<'info>(
    ctx: Context<'_, '_, 'info, 'info, Send<'info>>,
    params: SendMessageParams,
) -> Result<()> {
    require!(
        ctx.accounts.share_mover.allow_to,
        BoringErrorCode::NotAllowedTo
    );

    require!(params.amount > 0, BoringErrorCode::InvalidMessageAmount);

    ctx.accounts
        .share_mover
        .peer_chain
        .validate(&params.recipient)?;

    let clock = Clock::get()?;
    ctx.accounts
        .share_mover
        .outbound_rate_limit
        .check_and_consume(params.amount, clock.unix_timestamp)?;

    let message_amount = ShareBridgeMessage::convert_amount_decimals(
        params.amount as u128,
        ctx.accounts.share_mint.decimals,
        ctx.accounts.share_mover.peer_decimals,
    )?;

    let share_mover_data = ShareMoverData {
        key: ctx.accounts.share_mover.key(),
        bump: ctx.accounts.share_mover.bump,
        mint: ctx.accounts.share_mover.mint,
        endpoint_program: ctx.accounts.share_mover.endpoint_program,
        boring_vault_program: ctx.accounts.share_mover.boring_vault_program,
    };

    let share_mover_seeds = &[
        SHARE_MOVER_SEED,
        share_mover_data.mint.as_ref(),
        &[share_mover_data.bump],
    ];

    Send::execute_burn_shares(
        &ctx.accounts.user,
        &ctx.accounts.share_mover.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.share_mint.to_account_info(),
        &ctx.accounts.source_token_account.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.boring_vault_program.to_account_info(),
        &share_mover_data,
        share_mover_seeds,
        params.amount,
    )?;

    let message = ShareBridgeMessage::new(params.recipient, message_amount)?;
    let encoded_message = encode_message(&message);

    Send::execute_layerzero_send(
        &ctx.accounts.share_mover.to_account_info(),
        ctx.remaining_accounts,
        &share_mover_data,
        share_mover_seeds,
        &ctx.accounts.peer.peer_address,
        &params,
        ctx.accounts
            .peer
            .enforced_options
            .combine_options(&None::<Vec<u8>>, &params.options)?,
        encoded_message,
    )?;

    Ok(())
}

#[derive(Clone, Copy)]
struct ShareMoverData {
    key: Pubkey,
    bump: u8,
    mint: Pubkey,
    endpoint_program: Pubkey,
    boring_vault_program: Pubkey,
}
