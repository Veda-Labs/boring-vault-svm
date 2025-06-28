use anchor_lang::prelude::*;

use crate::{
    error::BoringErrorCode,
    seed::{PEER_SEED, SHARE_MOVER_SEED},
    state::ShareMover,
    utils::PeerConfig,
};

#[derive(Accounts)]
#[instruction(remote_eid: u32)]
pub struct ClosePeer<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        seeds = [SHARE_MOVER_SEED, share_mover.mint.as_ref()],
        bump = share_mover.bump,
        constraint = share_mover.admin == signer.key() @ BoringErrorCode::NotAuthorized,
        constraint = !share_mover.is_paused @ BoringErrorCode::ShareMoverPaused,
    )]
    pub share_mover: Account<'info, ShareMover>,

    #[account(
        mut,
        close = signer,
        seeds = [PEER_SEED, &share_mover.key().to_bytes(), &remote_eid.to_be_bytes()],
        bump = peer.bump,
    )]
    pub peer: Account<'info, PeerConfig>,
}

pub fn close_peer(_ctx: Context<ClosePeer>, _remote_eid: u32) -> Result<()> {
    Ok(())
}
