use crate::{
    error::BoringErrorCode,
    seed::{PEER_SEED, SHARE_MOVER_SEED},
    state::ShareMover,
    utils::PeerConfig,
};
use anchor_lang::prelude::*;

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetPeerParams {
    pub remote_eid: u32,
    pub peer_address: [u8; 32],
}

#[derive(Accounts)]
#[instruction(params: SetPeerParams)]
pub struct SetPeer<'info> {
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
        init_if_needed,
        payer = signer,
        space = 8 + std::mem::size_of::<PeerConfig>(),
        seeds = [PEER_SEED, &share_mover.key().to_bytes(), &params.remote_eid.to_be_bytes()],
        bump
    )]
    pub peer: Account<'info, PeerConfig>,

    pub system_program: Program<'info, System>,
}

pub fn set_peer(ctx: Context<SetPeer>, params: SetPeerParams) -> Result<()> {
    ctx.accounts.peer.peer_address = params.peer_address;
    ctx.accounts.peer.bump = ctx.bumps.peer;
    Ok(())
}
