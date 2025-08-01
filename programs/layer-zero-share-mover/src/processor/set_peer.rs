use crate::state::lz::assert_type_3;
use crate::{
    constants::{PEER_SEED, SHARE_MOVER_SEED},
    error::BoringErrorCode,
    state::{lz::PeerConfig, share_mover::ShareMover},
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program::ID as SYSTEM_PROGRAM_ID;
use std::mem::size_of;

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetPeerParams {
    pub remote_eid: u32,
    pub config: PeerConfigParam,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub enum PeerConfigParam {
    PeerAddress([u8; 32]),
    EnforcedOptions {
        send: Vec<u8>,
        send_and_call: Vec<u8>,
    },
}

#[derive(Accounts)]
#[instruction(params: SetPeerParams)]
pub struct SetPeer<'info> {
    #[account(
        mut,
        constraint = signer.key() == share_mover.admin @ BoringErrorCode::NotAuthorized
    )]
    pub signer: Signer<'info>,

    #[account(
        seeds = [SHARE_MOVER_SEED, share_mover.mint.as_ref()],
        bump,
    )]
    pub share_mover: Account<'info, ShareMover>,

    #[account(
        init_if_needed,
        payer = signer,
        space = 8 + size_of::<PeerConfig>(),
        seeds = [PEER_SEED, &share_mover.key().to_bytes(), &params.remote_eid.to_be_bytes()],
        bump
    )]
    pub peer: Account<'info, PeerConfig>,

    #[account(
        address = SYSTEM_PROGRAM_ID
    )]
    pub system_program: Program<'info, System>,
}

pub fn set_peer(ctx: Context<SetPeer>, params: SetPeerParams) -> Result<()> {
    match params.config {
        PeerConfigParam::PeerAddress(addr) => {
            require!(
                addr.iter().any(|&b| b != 0),
                BoringErrorCode::InvalidPeerAddress
            );

            ctx.accounts.share_mover.peer_chain.validate(&addr)?;

            ctx.accounts.peer.peer_address = addr;
        }
        PeerConfigParam::EnforcedOptions {
            send,
            send_and_call,
        } => {
            // LayerZero requires any override blob to be type-3 so enforce it here.
            assert_type_3(&send)?;
            assert_type_3(&send_and_call)?;
            ctx.accounts.peer.enforced_options.send = send;
            ctx.accounts.peer.enforced_options.send_and_call = send_and_call;
        }
    }

    Ok(())
}
