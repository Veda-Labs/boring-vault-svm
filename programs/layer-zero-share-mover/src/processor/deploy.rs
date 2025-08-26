use crate::{
    constants::{
        LZ_RECEIVE_TYPES_SEED, OAPP_REGISTER_DISCRIMINATOR, PROGRAM_CONFIG_SEED, SHARE_MOVER_SEED,
    },
    error::BoringErrorCode,
    state::{
        lz::LzReceiveTypesAccounts,
        share_mover::{PeerChain, ProgramConfig, ShareMover},
    },
};
use anchor_lang::solana_program::system_program::ID as SYSTEM_PROGRAM_ID;
use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::token_2022::spl_token_2022::ID as TOKEN_2022_PROGRAM_ID;
use anchor_spl::token_interface::Mint;
use boring_vault_svm::BoringVault;
use common::{pda::get_vault_state, rate_limit::RateLimitState};
use std::mem::size_of;

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct RegisterOAppParams {
    pub delegate: Pubkey,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct DeployParams {
    pub admin: Pubkey,
    pub delegate: Pubkey,
    pub boring_vault_program: Pubkey,
    pub vault_id: u64,
    pub peer_decimals: u8,
    pub outbound_limit: u64,  // Maximum amount allowed in the window
    pub outbound_window: u64, // Window duration in seconds
    pub inbound_limit: u64,   // Maximum amount allowed in the window
    pub inbound_window: u64,  // Window duration in seconds
    pub peer_chain: PeerChain,
}

#[derive(Accounts)]
#[instruction(params: DeployParams)]
pub struct Deploy<'info> {
    #[account(
        mut,
        constraint = signer.key() == config.authority.key() @ BoringErrorCode::NotAuthorized,
    )]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = 8 + size_of::<ShareMover>(),
        seeds = [SHARE_MOVER_SEED, mint.key().as_ref()],
        bump
    )]
    pub share_mover: Account<'info, ShareMover>,

    #[account(
        init,
        payer = signer,
        space = 8 + size_of::<LzReceiveTypesAccounts>(),
        seeds = [LZ_RECEIVE_TYPES_SEED, &share_mover.key().to_bytes()],
        bump
    )]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,

    #[account(
        seeds = [PROGRAM_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    #[account(owner = TOKEN_2022_PROGRAM_ID)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        address = get_vault_state(params.vault_id, &params.boring_vault_program),
        owner = params.boring_vault_program,
        constraint = boring_vault_state.config.share_mint == mint.key() @ BoringErrorCode::InvalidShareMint,
    )]
    pub boring_vault_state: Account<'info, BoringVault>,

    /// CHECK: oapp registry is initialized in LZ CPI call
    #[account(mut)]
    pub oapp_registry: UncheckedAccount<'info>,

    /// CHECK: config authority dictates the endpoint program in this instruction
    pub endpoint_program: UncheckedAccount<'info>,

    /// CHECK: event authority is checked in the endpoint program's register_oapp ix
    pub event_authority: UncheckedAccount<'info>,

    #[account(address = SYSTEM_PROGRAM_ID)]
    pub system_program: Program<'info, System>,
}

pub fn deploy(ctx: Context<Deploy>, params: DeployParams) -> Result<()> {
    let share_mover = &mut ctx.accounts.share_mover;
    let share_mover_key = share_mover.key();
    let clock = Clock::get()?;
    let mint_key = ctx.accounts.mint.key();
    let endpoint_program = ctx.accounts.endpoint_program.key();
    let boring_vault_program = params.boring_vault_program;

    share_mover.admin = params.admin;
    share_mover.boring_vault_program = boring_vault_program;
    share_mover.peer_decimals = params.peer_decimals;
    share_mover.peer_chain = params.peer_chain;
    share_mover.mint = mint_key;
    share_mover.endpoint_program = endpoint_program;
    share_mover.bump = ctx.bumps.share_mover;

    share_mover.vault = ctx.accounts.boring_vault_state.key();

    // eg if they want 1000 tokens per hour, they set limit=1000, window=3600
    share_mover.outbound_rate_limit = RateLimitState::new(
        params.outbound_limit,
        params.outbound_window,
        clock.unix_timestamp,
    )?;

    share_mover.inbound_rate_limit = RateLimitState::new(
        params.inbound_limit,
        params.inbound_window,
        clock.unix_timestamp,
    )?;

    ctx.accounts.lz_receive_types_accounts.store = share_mover_key;
    let accounts = vec![
        AccountMeta::new(ctx.accounts.signer.key(), true), // payer (signer)
        AccountMeta::new_readonly(share_mover_key, true),  // oapp (signer)
        AccountMeta::new(ctx.accounts.oapp_registry.key(), false), // oapp_registry
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false), // system_program
        AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false), // event_authority
        AccountMeta::new_readonly(endpoint_program, false), // endpoint_program
    ];

    let register_params = RegisterOAppParams {
        delegate: params.delegate,
    };
    let instruction_data = {
        let mut data = Vec::new();
        data.extend_from_slice(&OAPP_REGISTER_DISCRIMINATOR);
        register_params.serialize(&mut data)?;
        data
    };

    let instruction = Instruction {
        program_id: ctx.accounts.endpoint_program.key(),
        accounts,
        data: instruction_data,
    };

    let seeds = [SHARE_MOVER_SEED, mint_key.as_ref(), &[share_mover.bump]];
    let signer_seeds = &[&seeds[..]];

    invoke_signed(
        &instruction,
        &[
            ctx.accounts.signer.to_account_info(),
            share_mover.to_account_info(),
            ctx.accounts.oapp_registry.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.event_authority.to_account_info(),
            ctx.accounts.endpoint_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    msg!(
        "ShareMover deployed for mint {} with vault {} admin {} delegate {}",
        share_mover.mint,
        share_mover.vault,
        share_mover.admin,
        params.delegate
    );

    Ok(())
}
