use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id, token_2022::ID as TOKEN_2022_ID,
};
use common::message::decode_message;

use crate::{
    constants::{PEER_SEED, SHARE_MOVER_SEED},
    error::BoringErrorCode,
    state::{
        lz::{LzAccount, LzReceiveParams},
        share_mover::ShareMover,
    },
    utils::get_accounts_for_clear,
};

#[derive(Accounts)]
pub struct LzReceiveTypes<'info> {
    /// CHECK: share mover is derived in the instruction
    pub store: UncheckedAccount<'info>,
}

pub fn lz_receive_types(
    ctx: &Context<LzReceiveTypes>,
    params: &LzReceiveParams,
) -> Result<Vec<LzAccount>> {
    let share_mover_key = ctx.accounts.store.key();
    let store_data = ctx.accounts.store.data.borrow();
    let share_mover = ShareMover::try_deserialize(&mut &store_data[..])?;
    let mint = share_mover.mint;

    let (sm_key, bump) =
        Pubkey::find_program_address(&[SHARE_MOVER_SEED, mint.as_ref()], &crate::ID);
    if share_mover_key != sm_key || bump != share_mover.bump {
        return Err(BoringErrorCode::InvalidShareMover.into());
    }

    let peer_seeds = [
        PEER_SEED,
        &share_mover_key.to_bytes(),
        &params.src_eid.to_be_bytes(),
    ];

    let peer = Pubkey::find_program_address(&peer_seeds, &crate::ID).0;

    let mut accounts = vec![
        LzAccount {
            pubkey: share_mover_key,
            is_signer: false,
            is_writable: true,
        },
        LzAccount {
            pubkey: peer,
            is_signer: false,
            is_writable: false,
        },
    ];

    let accounts_for_clear = get_accounts_for_clear(
        share_mover.endpoint_program,
        &share_mover_key,
        params.src_eid,
        &params.sender,
        params.nonce,
    );
    accounts.extend(accounts_for_clear);

    let decoded_msg = decode_message(&params.message)?;

    let recipient_ata = get_associated_token_address_with_program_id(
        &Pubkey::from(decoded_msg.recipient),
        &mint,
        // Shares are always a 2022 token
        &TOKEN_2022_ID,
    );

    accounts.extend(vec![
        LzAccount {
            pubkey: share_mover_key,
            is_signer: false,
            is_writable: false,
        },
        LzAccount {
            pubkey: share_mover.vault,
            is_signer: false,
            is_writable: false,
        },
        LzAccount {
            pubkey: mint,
            is_signer: false,
            is_writable: true,
        },
        LzAccount {
            pubkey: recipient_ata,
            is_signer: false,
            is_writable: true,
        },
        LzAccount {
            pubkey: TOKEN_2022_ID,
            is_signer: false,
            is_writable: false,
        },
        LzAccount {
            pubkey: share_mover.boring_vault_program,
            is_signer: false,
            is_writable: false,
        },
    ]);

    Ok(accounts)
}
