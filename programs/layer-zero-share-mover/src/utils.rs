use anchor_lang::prelude::Pubkey;

use crate::{
    seed::{ENDPOINT_SEED, EVENT_SEED, NONCE_SEED, OAPP_SEED, PAYLOAD_HASH_SEED},
    state::lz::LzAccount,
};

pub fn get_accounts_for_clear(
    endpoint_program: Pubkey,
    receiver: &Pubkey,
    src_eid: u32,
    sender: &[u8; 32],
    nonce: u64,
) -> Vec<LzAccount> {
    let (nonce_account, _) = Pubkey::find_program_address(
        &[
            NONCE_SEED,
            &receiver.to_bytes(),
            &src_eid.to_be_bytes(),
            sender,
        ],
        &endpoint_program,
    );

    let (payload_hash_account, _) = Pubkey::find_program_address(
        &[
            PAYLOAD_HASH_SEED,
            &receiver.to_bytes(),
            &src_eid.to_be_bytes(),
            sender,
            &nonce.to_be_bytes(),
        ],
        &endpoint_program,
    );

    let (oapp_registry_account, _) =
        Pubkey::find_program_address(&[OAPP_SEED, &receiver.to_bytes()], &endpoint_program);

    let (endpoint_settings_account, _) =
        Pubkey::find_program_address(&[ENDPOINT_SEED], &endpoint_program);

    vec![
        LzAccount {
            pubkey: *receiver,
            is_signer: false,
            is_writable: false,
        },
        LzAccount {
            pubkey: oapp_registry_account,
            is_signer: false,
            is_writable: false,
        },
        LzAccount {
            pubkey: nonce_account,
            is_signer: false,
            is_writable: true,
        },
        LzAccount {
            pubkey: payload_hash_account,
            is_signer: false,
            is_writable: true,
        },
        LzAccount {
            pubkey: endpoint_settings_account,
            is_signer: false,
            is_writable: true,
        },
    ]
}
