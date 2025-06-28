#![allow(unexpected_cfgs)]
#![allow(clippy::too_many_arguments)]

mod error;
mod message;
mod processor;
mod rate_limit;
mod seed;
mod state;
mod utils;

use anchor_lang::prelude::*;
use processor::*;

use crate::{state::LzAccount, utils::LzReceiveParams};

declare_id!("3f2EpbAR6sGNy3wUpWugtwN2EHGDbyiG8ZpySFVnmY9q");

#[program]
pub mod layer_zero_share_mover {

    use crate::utils::MessagingFee;

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

    pub fn set_peer_decimals(ctx: Context<SetPeerDecimals>, new_decimals: u8) -> Result<()> {
        processor::set_peer_decimals(ctx, new_decimals)
    }

    pub fn transfer_authority(ctx: Context<TransferAuthority>, new_admin: Pubkey) -> Result<()> {
        processor::transfer_authority(ctx, new_admin)
    }
}
