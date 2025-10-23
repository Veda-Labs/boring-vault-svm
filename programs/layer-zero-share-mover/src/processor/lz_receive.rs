use crate::constants::{CLEAR_DISCRIMINATOR, MINT_SHARES_DISCRIMINATOR};
use crate::utils::get_accounts_for_clear;
use crate::{
    constants::{PEER_SEED, SHARE_MOVER_SEED},
    error::BoringErrorCode,
    state::{
        lz::{LzReceiveParams, PeerConfig},
        share_mover::ShareMover,
    },
};
use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_2022::spl_token_2022::ID as TOKEN_2022_PROGRAM_ID,
};
use common::message::decode_message;

// Minimum number of LayerZero accounts required for a clear operation.
// The clear CPI into the LayerZero endpoint expects exactly 7 accounts:
// [0] share_mover          – signer PDA derived from [SHARE_MOVER_SEED, mint]
// [1] oapp_registry        – read-only, registry holding OApp configs
// [2] nonce                – read-only, tracks per-source-chain nonce
// [3] payload_hash         – mutable, closed by the endpoint once processed
// [4] endpoint             – mutable, LayerZero endpoint settings account
// [5] event_authority      – read-only PDA derived from EVENT_AUTHORITY_SEED
// [6] endpoint_program     – read-only, actual endpoint program id
pub const CLEAR_MIN_ACCOUNTS_LEN: usize = 7;

// Accounts slice forwarded to `execute_mint` (boring-vault CPI):
// [0] share_mover          – signer PDA (read-only is sufficient)
// [1] vault_state         – vault PDA holding config & balances
// [2] boring_vault_program – read-only, on-chain boring-vault program id
pub const MINT_ACCOUNTS_LEN: usize = 3;

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
    // TODO: constrain share_mover.executor == executor, after testing
    // add executor to share_mover data, and add it to the lz_receive_types function
    // add set_executor_ix
    #[account(mut)]
    pub executor: Signer<'info>,

    #[account(
        mut,
        seeds = [SHARE_MOVER_SEED, share_mover.mint.as_ref()],
        constraint = !share_mover.is_paused @ BoringErrorCode::ShareMoverPaused,
        bump
    )]
    pub share_mover: Account<'info, ShareMover>,

    #[account(
        seeds = [PEER_SEED, &share_mover.key().to_bytes(), &params.src_eid.to_be_bytes()],
        constraint = params.sender == peer.peer_address @ BoringErrorCode::PeerNotAuthorized,
        bump
    )]
    pub peer: Account<'info, PeerConfig>,

    #[account(
        mut,
        constraint = share_mint.key() == share_mover.mint @ BoringErrorCode::InvalidShareMint,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,

    #[account(
        constraint = recipient.key()
            == Pubkey::from(decode_message(&params.message)?.recipient)
            @ BoringErrorCode::InvalidMessageRecipient,
    )]
    /// CHECK: Only the pubkey is used to derive the recipient ATA
    pub recipient: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = executor,
        associated_token::mint = share_mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program_2022,
    )]
    pub recipient_ata: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program_2022: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
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

        let expected = get_accounts_for_clear(
            share_mover_data.endpoint_program,
            &share_mover_data.key,
            params.src_eid,
            &params.sender,
            params.nonce,
        );

        for (idx, exp) in expected.iter().enumerate() {
            require_eq!(
                accounts[idx].key(),
                exp.pubkey,
                BoringErrorCode::InvalidClearAccounts
            );
        }

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
        share_mint_account: &AccountInfo<'info>,
        recipient_ata_account: &AccountInfo<'info>,
        token_program_2022_account: &AccountInfo<'info>,
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

        require_eq!(
            accounts[0].key(),
            share_mover_data.key,
            BoringErrorCode::InvalidMintAccounts
        );
        require_eq!(
            accounts[1].key(),
            share_mover_data.vault,
            BoringErrorCode::InvalidMintAccounts
        );
        require_eq!(
            share_mint_account.key(),
            share_mover_data.mint,
            BoringErrorCode::InvalidMintAccounts
        );

        require_eq!(
            recipient_ata_account.key(),
            get_associated_token_address_with_program_id(
                recipient,
                &share_mover_data.mint,
                &TOKEN_2022_PROGRAM_ID,
            ),
            BoringErrorCode::InvalidAssociatedTokenAccount
        );

        require_eq!(
            token_program_2022_account.key(),
            TOKEN_2022_PROGRAM_ID,
            BoringErrorCode::InvalidMintAccounts
        );
        require_eq!(
            accounts[2].key(),
            share_mover_data.boring_vault_program,
            BoringErrorCode::InvalidMintAccounts
        );

        let mint_data = Self::build_mint_data(recipient, u64::try_from(amount)?)?;

        let mint_ix = Instruction {
            program_id: share_mover_data.boring_vault_program,
            accounts: vec![
                AccountMeta::new_readonly(accounts[0].key(), true), // share_mover (signer, read-only suffices)
                AccountMeta::new_readonly(accounts[1].key(), false), // vault state
                AccountMeta::new(share_mint_account.key(), false),  // share_mint
                AccountMeta::new(recipient_ata_account.key(), false), // recipient_ata
                AccountMeta::new_readonly(token_program_2022_account.key(), false), // token_program
                AccountMeta::new_readonly(accounts[2].key(), false), // boring_vault_program
            ],
            data: mint_data,
        };

        // Order must match metas above
        let mint_infos = [
            accounts[0].clone(),
            accounts[1].clone(),
            share_mint_account.clone(),
            recipient_ata_account.clone(),
            token_program_2022_account.clone(),
            accounts[2].clone(),
        ];

        invoke_signed(&mint_ix, &mint_infos, &[signer_seeds])?;

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

    let remaining_accounts = ctx.remaining_accounts;

    require!(
        remaining_accounts.len() == CLEAR_MIN_ACCOUNTS_LEN + MINT_ACCOUNTS_LEN,
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

    // Inbound packets are already authenticated by the Endpoint & ULN.
    // No additional peer-chain validation needed here.

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
        vault: ctx.accounts.share_mover.vault,
    };

    // ShareMover PDA seeds
    let share_mover_seeds = &[
        SHARE_MOVER_SEED,
        share_mover_data.mint.as_ref(),
        &[share_mover_data.bump],
    ];

    // Split remaining accounts into two groups with explicit validation
    let (clear_accounts, mint_accounts) = remaining_accounts.split_at(CLEAR_MIN_ACCOUNTS_LEN);

    LzReceive::execute_clear(&share_mover_data, clear_accounts, share_mover_seeds, params)?;

    LzReceive::execute_mint(
        mint_accounts,
        &ctx.accounts.share_mint.to_account_info(),
        &ctx.accounts.recipient_ata.to_account_info(),
        &ctx.accounts.token_program_2022.to_account_info(),
        &share_mover_data,
        share_mover_seeds,
        &Pubkey::from(decoded_msg.recipient),
        decoded_msg.amount,
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
    vault: Pubkey,
}
