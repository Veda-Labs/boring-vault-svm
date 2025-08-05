#![allow(unexpected_cfgs)]
#![allow(clippy::too_many_arguments)]

mod constants;
mod error;
mod processor;
mod state;
mod utils;

use anchor_lang::prelude::*;
use processor::*;

use crate::state::lz::{LzAccount, LzReceiveParams, MessagingFee};

declare_id!("CU9XermEoiawu8eYwSyXBHgMESRwWEycDU9jjk9MHSgN");

#[program]
pub mod layer_zero_share_mover {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        processor::initialize(ctx, authority)
    }

    pub fn deploy(ctx: Context<Deploy>, params: DeployParams) -> Result<()> {
        processor::deploy(ctx, params)
    }

    pub fn lz_receive_types(
        ctx: Context<LzReceiveTypes>,
        params: LzReceiveParams,
    ) -> Result<Vec<LzAccount>> {
        processor::lz_receive_types(&ctx, &params)
    }

    pub fn lz_receive<'info>(
        ctx: Context<'_, '_, 'info, 'info, LzReceive<'info>>,
        params: LzReceiveParams,
    ) -> Result<()> {
        processor::lz_receive(ctx, &params)
    }

    pub fn set_peer(ctx: Context<SetPeer>, params: SetPeerParams) -> Result<()> {
        processor::set_peer(ctx, params)
    }

    pub fn close_peer(ctx: Context<ClosePeer>, remote_eid: u32) -> Result<()> {
        processor::close_peer(ctx, remote_eid)
    }

    pub fn preview_fee(ctx: Context<PreviewFee>, params: PreviewFeeParams) -> Result<MessagingFee> {
        processor::preview_fee(&ctx, params)
    }

    pub fn send<'info>(
        ctx: Context<'_, '_, 'info, 'info, Send<'info>>,
        params: SendMessageParams,
    ) -> Result<()> {
        processor::send(ctx, params)
    }

    pub fn set_rate_limit(
        ctx: Context<SetRateLimit>,
        outbound_limit: u64,
        outbound_capacity: u64,
        inbound_limit: u64,
        inbound_capacity: u64,
    ) -> Result<()> {
        processor::set_rate_limit(
            ctx,
            outbound_limit,
            outbound_capacity,
            inbound_limit,
            inbound_capacity,
        )
    }

    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        processor::set_pause(ctx, paused)
    }

    pub fn set_executor_program(ctx: Context<SetExecutorProgram>, executor: Pubkey) -> Result<()> {
        processor::set_executor_program(ctx, executor)
    }

    pub fn set_endpoint_program(ctx: Context<SetEndpointProgram>, endpoint: Pubkey) -> Result<()> {
        processor::set_endpoint_program(ctx, endpoint)
    }

    pub fn set_allow(ctx: Context<SetAllow>, allow_from: bool, allow_to: bool) -> Result<()> {
        processor::set_allow(ctx, allow_from, allow_to)
    }

    pub fn transfer_authority(ctx: Context<TransferAuthority>, new_admin: Pubkey) -> Result<()> {
        processor::transfer_authority(ctx, new_admin)
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        processor::accept_authority(ctx)
    }
}
