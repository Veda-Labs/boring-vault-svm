use crate::{
    error::BoringErrorCode,
    seed::{PEER_SEED, SHARE_MOVER_SEED},
    state::{
        lz::PeerConfig,
        share_mover::{PeerChain, ShareMover},
    },
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
use common::{
    error::ShareBridgeCodecError,
    message::{encode_message, ShareBridgeMessage},
};

const SEND_DISCRIMINATOR: [u8; 8] = [102, 251, 20, 187, 65, 75, 12, 69];
const BURN_SHARES_DISCRIMINATOR: [u8; 8] = [98, 168, 88, 31, 217, 221, 191, 214];

// Mininum number of LayerZero accounts needed for send
// Mandatory LayerZero accounts: [endpoint, messaging libs ...] plus event authority and program id (8 total)
// Adjusted to 8 to include event_authority PDA and the endpoint program id.
// [0] endpoint_settings (mutable)
// [1] oapp_registry
// [2] nonce
// [3] payload_hash
// [4] endpoint_program (read-only)
// [5] event_authority (read-only)
// plus any additional optional accounts
const LAYERZERO_SEND_ACCOUNTS_LEN: usize = 8;

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SendMessageParams {
    pub dst_eid: u32,        // Destination chain endpoint ID
    pub recipient: [u8; 32], // Recipient address (32 bytes for any chain)
    pub amount: u64,         // Amount of shares to bridge
    pub options: Vec<u8>,    // LayerZero messaging options
    pub native_fee: u64,     // Native fee amount (from quote)
    pub lz_token_fee: u64,   // LZ token fee amount (from quote)
}

// LayerZero SendParams structure matching their interface
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LayerZeroSendParams {
    pub dst_eid: u32,
    pub receiver: [u8; 32],
    pub message: Vec<u8>,
    pub options: Vec<u8>,
    pub native_fee: u64,
    pub lz_token_fee: u64,
}

// Data struct to avoid lifetime issues
#[derive(Clone, Copy)]
struct ShareMoverData {
    key: Pubkey,
    bump: u8,
    mint: Pubkey,
    endpoint_program: Pubkey,
    boring_vault_program: Pubkey,
}

#[derive(Accounts)]
#[instruction(params: SendMessageParams)]
pub struct Send<'info> {
    // Share burn authority
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [SHARE_MOVER_SEED, share_mover.mint.as_ref()],
        bump = share_mover.bump,
        constraint = !share_mover.is_paused @ BoringErrorCode::ShareMoverPaused
    )]
    pub share_mover: Account<'info, ShareMover>,

    #[account(
        seeds = [
            PEER_SEED,
            share_mover.key().as_ref(),
            &params.dst_eid.to_be_bytes()
        ],
        bump = peer.bump
    )]
    pub peer: Account<'info, PeerConfig>,
    // ========== BURN SHARES ACCOUNTS ==========
    /// Vault account for burning shares
    /// PDA: [BASE_SEED_BORING_VAULT_STATE, vault_id]
    #[account(
        seeds = [
            BASE_SEED_BORING_VAULT_STATE,
            &vault.config.vault_id.to_le_bytes()
        ],
        bump,
        seeds::program = share_mover.boring_vault_program,
        owner = share_mover.boring_vault_program,
        constraint = !vault.config.paused @ BoringErrorCode::VaultPaused
    )]
    pub vault: Account<'info, BoringVault>,

    /// Share mint to burn from
    /// Must match vault's share_mint
    #[account(
        mut,
        constraint = share_mint.key() == vault.config.share_mint @ BoringErrorCode::InvalidShareMint
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    /// User's token account to burn from
    /// Must be owned by user and have sufficient balance
    #[account(
        mut,
        constraint = source_token_account.mint == share_mint.key() @ BoringErrorCode::InvalidAssociatedTokenAccount,
        constraint = source_token_account.owner == user.key() @ BoringErrorCode::NotAuthorized
    )]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        address = TOKEN_2022_PROGRAM_ID
    )]
    pub token_program: Program<'info, Token2022>,

    #[account(
        address = SYSTEM_PROGRAM_ID
    )]
    pub system_program: Program<'info, System>,

    #[account(
        address = share_mover.boring_vault_program
    )]
    /// CHECK: This is the boring vault program
    pub boring_vault_program: AccountInfo<'info>,
}

impl<'info> Send<'info> {
    fn execute_burn_shares<'a>(
        user: &AccountInfo<'a>,
        vault: &AccountInfo<'a>,
        share_mint: &AccountInfo<'a>,
        source_token_account: &AccountInfo<'a>,
        token_program: &AccountInfo<'a>,
        boring_vault_program: &AccountInfo<'a>,
        share_mover_data: &ShareMoverData,
        amount: u64,
    ) -> Result<()> {
        let mut burn_data = BURN_SHARES_DISCRIMINATOR.to_vec();
        burn_data.extend_from_slice(&amount.to_le_bytes());

        let burn_ix = Instruction {
            program_id: share_mover_data.boring_vault_program,
            accounts: vec![
                AccountMeta::new_readonly(user.key(), true),   // signer
                AccountMeta::new_readonly(vault.key(), false), // vault
                AccountMeta::new(share_mint.key(), false),     // share_mint (mut)
                AccountMeta::new(source_token_account.key(), false), // source_token_account (mut)
                AccountMeta::new_readonly(token_program.key(), false), // token_program
                AccountMeta::new_readonly(boring_vault_program.key(), false), // boring_vault_program
            ],
            data: burn_data,
        };

        // Prepare account infos for burn CPI
        let burn_accounts = vec![
            user.clone(),
            vault.clone(),
            share_mint.clone(),
            source_token_account.clone(),
            token_program.clone(),
        ];

        // Execute burn CPI (user signs, no PDA needed)
        invoke_signed(&burn_ix, &burn_accounts, &[])?;

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
        // Validate we have the right number of accounts
        require!(
            accounts.len() >= LAYERZERO_SEND_ACCOUNTS_LEN,
            BoringErrorCode::InvalidMessage
        );

        // Basic sanity check – ensure the forwarded endpoint program matches expectation
        require_eq!(
            accounts[4].key(),
            share_mover_data.endpoint_program,
            BoringErrorCode::InvalidMessage
        );

        // Prepare LayerZero send parameters
        let lz_send_params = LayerZeroSendParams {
            dst_eid: params.dst_eid,
            receiver: *peer_address,
            message,
            options: combined_options,
            native_fee: params.native_fee,
            lz_token_fee: params.lz_token_fee,
        };

        // Serialize the send parameters
        let mut send_data = Vec::new();
        send_data.extend_from_slice(&SEND_DISCRIMINATOR);
        lz_send_params.serialize(&mut send_data)?;

        // Build the send instruction
        // The first account must be the sender (ShareMover PDA)
        let mut account_metas = vec![
            AccountMeta::new_readonly(share_mover_data.key, true), // sender (signer)
        ];

        // Add accounts that were passed in. The first six are the mandatory but anything after that
        // is optional and will be forwarded to the message-library call (e.g. fee-payment, vaults)
        for account in accounts.iter() {
            account_metas.push(AccountMeta {
                pubkey: account.key(),
                is_signer: account.is_signer,
                is_writable: account.is_writable,
            });
        }

        // Create the instruction
        let send_instruction = Instruction {
            program_id: share_mover_data.endpoint_program,
            accounts: account_metas,
            data: send_data,
        };

        // Prepare account infos for the CPI call
        let mut account_infos = vec![share_mover.clone()];

        // Add *all* LayerZero / message-library accounts (not just the first six) so the
        // endpoint program can forward any optional accounts to the library implementation.
        account_infos.extend_from_slice(accounts);

        // Execute the CPI call with ShareMover as signer
        invoke_signed(
            &send_instruction,
            &account_infos,
            &[signer_seeds], // ShareMover PDA signs as the message sender
        )?;

        Ok(())
    }
}

pub fn send<'info>(
    ctx: Context<'_, '_, 'info, 'info, Send<'info>>,
    params: SendMessageParams,
) -> Result<()> {
    // Validate allow to
    require!(
        ctx.accounts.share_mover.allow_to,
        BoringErrorCode::NotAllowedTo
    );

    // Ensure a positive amount is being bridged
    require!(params.amount > 0, BoringErrorCode::InvalidMessageAmount);

    // Validate we have enough remaining accounts for LayerZero send
    require!(
        ctx.remaining_accounts.len() >= LAYERZERO_SEND_ACCOUNTS_LEN,
        BoringErrorCode::InvalidMessage
    );

    let share_mint_decimals = ctx.accounts.share_mint.decimals;
    let peer_decimals = ctx.accounts.share_mover.peer_decimals;

    let message_amount = ShareBridgeMessage::convert_amount_decimals(
        params.amount as u128,
        share_mint_decimals,
        peer_decimals,
    )
    .ok_or(BoringErrorCode::SendAmountConversionFailed)?;

    // Validate user has sufficient balance
    require!(
        ctx.accounts.source_token_account.amount >= params.amount,
        BoringErrorCode::InsufficientBalance
    );

    // At this point we have verified that the user has sufficient balance and the message parameters
    // are valid for the selected peer-chain. We can now safely consume the outbound rate-limit before
    // performing any external CPIs.
    let clock = Clock::get()?;
    ctx.accounts
        .share_mover
        .check_outbound_rate_limit(params.amount, clock.unix_timestamp)?;

    // Create data struct to avoid lifetime issues
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

    // Step 1: Burn shares before sending cross-chain message
    Send::execute_burn_shares(
        &ctx.accounts.user,
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.share_mint.to_account_info(),
        &ctx.accounts.source_token_account.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.boring_vault_program.to_account_info(),
        &share_mover_data,
        params.amount,
    )?;

    match ctx.accounts.share_mover.peer_chain {
        PeerChain::Evm => {
            // Check if the recipient is a valid EVM address
            require!(
                ShareBridgeMessage::is_valid_padded_evm_address(&params.recipient),
                ShareBridgeCodecError::InvalidEVMRecipientAddress
            );
        }
        PeerChain::Sui => {
            // Sui addresses are also 32 bytes; no additional validation needed here.
        }
        _ => {
            return Err(error!(BoringErrorCode::InvalidPeerChain));
        }
    }

    let message = ShareBridgeMessage::new(params.recipient, message_amount);
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
