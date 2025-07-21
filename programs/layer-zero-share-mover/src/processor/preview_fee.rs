use crate::{
    error::BoringErrorCode,
    seed::{ENDPOINT_SEED, PEER_SEED, SHARE_MOVER_SEED},
    state::{
        lz::{EndpointSettings, MessagingFee, PeerConfig},
        share_mover::ShareMover,
    },
};
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_lang::{prelude::*, solana_program::program::get_return_data};
use common::message::{encode_message, ShareBridgeMessage};

const QUOTE_DISCRIMINATOR: [u8; 8] = [149, 42, 109, 247, 134, 146, 213, 123];

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct PreviewFeeParams {
    pub dst_eid: u32,          // Destination chain endpoint ID
    pub recipient: [u8; 32],   // Recipient address (32 bytes for any chain)
    pub amount: u128,          // Amount of shares to bridge
    pub options: Vec<u8>,      // LayerZero messaging options
    pub pay_in_lz_token: bool, // Whether to pay in LZ token
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct LzQuoteParams {
    pub sender: Pubkey,
    pub dst_eid: u32,
    pub receiver: [u8; 32],
    pub message: Vec<u8>,
    pub options: Vec<u8>,
    pub pay_in_lz_token: bool,
}

#[derive(Accounts)]
#[instruction(params: PreviewFeeParams)]
pub struct PreviewFee<'info> {
    #[account(
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

    #[account(
        seeds = [ENDPOINT_SEED],
        bump = endpoint.bump,
        seeds::program = share_mover.endpoint_program
    )]
    pub endpoint: Account<'info, EndpointSettings>,
}

pub fn preview_fee(ctx: &Context<PreviewFee>, params: PreviewFeeParams) -> Result<MessagingFee> {
    let message = ShareBridgeMessage::new(params.recipient, params.amount);
    let encoded_message = encode_message(&message);

    // Prepare LayerZero quote parameters
    let lz_quote_params = LzQuoteParams {
        sender: ctx.accounts.share_mover.key(),
        dst_eid: params.dst_eid,
        receiver: params.recipient,
        message: encoded_message,
        options: ctx
            .accounts
            .peer
            .enforced_options
            .combine_options(&None::<Vec<u8>>, &params.options)?,

        pay_in_lz_token: params.pay_in_lz_token,
    };

    // Serialize the quote parameters
    let mut quote_data = Vec::new();
    quote_data.extend_from_slice(&QUOTE_DISCRIMINATOR);
    lz_quote_params.serialize(&mut quote_data)?;

    // Prepare account metas for LayerZero quote instruction
    let mut account_metas = vec![];
    for account in ctx.remaining_accounts {
        account_metas.push(AccountMeta::new_readonly(account.key(), account.is_signer));
    }

    // Create the instruction
    let quote_instruction = Instruction {
        program_id: ctx.accounts.share_mover.endpoint_program,
        accounts: account_metas,
        data: quote_data,
    };

    // Execute the CPI call
    invoke_signed(
        &quote_instruction,
        ctx.remaining_accounts,
        &[], // No seeds needed for quote call as it's read-only
    )?;

    let (return_pid, return_data) =
        get_return_data().ok_or(ProgramError::InvalidInstructionData)?;

    require_keys_eq!(
        return_pid,
        ctx.accounts.share_mover.endpoint_program,
        BoringErrorCode::InvalidEndpointProgram
    );

    let fee = MessagingFee::try_from_slice(&return_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    Ok(fee)
}
