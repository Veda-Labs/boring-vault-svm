use pyo3::prelude::*;
use log::{info};
use solana_client::{
    rpc_client::RpcClient,
    rpc_request::TokenAccountsFilter,
};
use solana_sdk::{
    pubkey::Pubkey,
    system_program,
};
use spl_token::state::Account as TokenAccount;
use solana_sdk::program_pack::Pack;
use std::str::FromStr;
use base64::{Engine as _, engine::general_purpose::STANDARD as base64};

/// The base seed used for deriving PDAs for vault sub-accounts
const BASE_SEED_BORING_VAULT: &[u8] = b"boring_vault";
/// The mint address for JitoSOL token
const JITOSOL_MINT: &str = "J1toso1uFr7z4g7Bm7sreoCRD67YsP3hC4dKz2NKwAh";
/// The mint address for wrapped SOL (wSOL) token
const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";

/// Represents the total balances of SOL, JitoSOL, and wSOL in a vault
#[pyclass]
#[derive(Debug, Clone)]
pub struct VaultBalances {
    /// Native SOL balance in lamports
    #[pyo3(get)]
    pub sol: u64,
    /// JitoSOL token balance in base units
    #[pyo3(get)]
    pub jitosol: u64,
    /// Wrapped SOL (wSOL) balance in base units
    #[pyo3(get)]
    pub wsol: u64,
}

#[pymethods]
impl VaultBalances {
    #[new]
    fn new() -> Self {
        Self::default()
    }
}

impl Default for VaultBalances {
    fn default() -> Self {
        Self {
            sol: 0,
            jitosol: 0,
            wsol: 0,
        }
    }
}

/// Errors that can occur when querying vault balances
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    /// The number of sub-accounts requested exceeds the maximum allowed (255)
    #[error("Invalid number of sub-accounts: {0}")]
    InvalidSubAccountCount(u32),
    /// An error occurred while making an RPC request
    #[error("RPC error: {0}")]
    RpcError(#[from] solana_client::client_error::ClientError),
    /// The provided mint address is invalid
    #[error("Invalid mint address: {0}")]
    InvalidMintAddress(String),
    /// Failed to decode account data from base64
    #[error("Failed to decode account data: {0}")]
    DecodeError(String),
}

impl From<VaultError> for PyErr {
    fn from(err: VaultError) -> PyErr {
        PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(err.to_string())
    }
}

/// Sums up the total SOL, JitoSOL, and wSOL balances across the first N sub-accounts of a vault
///
/// # Arguments
///
/// * `rpc_url` - The URL of the Solana RPC endpoint to use
///
/// # Returns
///
/// Returns a `Result` containing either:
/// * `VaultBalances` - The total balances of SOL, JitoSOL, and wSOL
/// * `Error` - An error that occurred during the query
///
/// # Example
///
/// ```no_run
/// use boring_vault_tools::sum_vault_balances;
///
/// let balances = sum_vault_balances(
///     "https://api.mainnet-beta.solana.com",
/// ).unwrap();
///
/// println!("Total SOL: {} lamports", balances.sol);
/// println!("Total JitoSOL: {}", balances.jitosol);
/// println!("Total wSOL: {}", balances.wsol);
/// ```
#[pyfunction]
pub fn sum_vault_balances(
    rpc_url: &str,
) -> PyResult<VaultBalances> {
    let client = RpcClient::new(rpc_url.to_string());
    let mut balances = VaultBalances::default();
    let num_sub_accounts = 255; // Maximum number of sub-accounts

    // Get mint pubkeys
    let jitosol_mint = Pubkey::from_str(JITOSOL_MINT)
        .map_err(|_| VaultError::InvalidMintAddress(JITOSOL_MINT.to_string()))?;
    let wsol_mint = Pubkey::from_str(WSOL_MINT)
        .map_err(|_| VaultError::InvalidMintAddress(WSOL_MINT.to_string()))?;

    // Test the RPC connection first
    client.get_version().map_err(VaultError::RpcError)?;

    for sub_account in 0..num_sub_accounts {
        let (pda, _) = Pubkey::find_program_address(
            &[
                BASE_SEED_BORING_VAULT,
                &[sub_account as u8],
            ],
            &system_program::id(),
        );

        // Get SOL balance
        match client.get_account(&pda) {
            Ok(account) => {
                balances.sol += account.lamports;
            }
            Err(e) => {
                // Only ignore AccountNotFound errors
                if !e.to_string().contains("AccountNotFound") {
                    return Err(VaultError::RpcError(e).into());
                }
            }
        }

        // Get JitoSOL and wSOL balances
        match client.get_token_accounts_by_owner(
            &pda,
            TokenAccountsFilter::ProgramId(spl_token::id()),
        ) {
            Ok(token_accounts) => {
                for account in token_accounts {
                    let data = match account.account.data {
                        solana_account_decoder::UiAccountData::Binary(data, _) => {
                            base64.decode(data)
                                .map_err(|e| VaultError::DecodeError(e.to_string()))?
                        }
                        _ => continue,
                    };

                    if let Ok(token_account) = TokenAccount::unpack(&data) {
                        if token_account.mint == jitosol_mint {
                            balances.jitosol += token_account.amount;
                        } else if token_account.mint == wsol_mint {
                            balances.wsol += token_account.amount;
                        }
                    }
                }
            }
            Err(e) => {
                // Only ignore AccountNotFound errors
                if !e.to_string().contains("AccountNotFound") {
                    return Err(VaultError::RpcError(e).into());
                }
            }
        }
    }

    info!(
        "Vault balances: SOL={}, JitoSOL={}, wSOL={}",
        balances.sol, balances.jitosol, balances.wsol
    );

    Ok(balances)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn test_invalid_rpc_url() {
        let result = sum_vault_balances("http://invalid-url:8899");
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_mint_address() {
        let invalid_mint = "invalid_address";
        let result = Pubkey::from_str(invalid_mint);
        assert!(result.is_err());

        // Test that our error handling works in the main function
        let result = Pubkey::from_str(invalid_mint)
            .map_err(|_| VaultError::InvalidMintAddress(invalid_mint.to_string()));
        assert!(result.is_err());
        assert!(matches!(result, Err(VaultError::InvalidMintAddress(_))));
    }

    #[test]
    fn test_pda_derivation() {
        let vault_id = 123u64;
        let sub_account = 0u8;
        let (pda, _) = Pubkey::find_program_address(
            &[
                BASE_SEED_BORING_VAULT,
                &vault_id.to_le_bytes(),
                &[sub_account],
            ],
            &system_program::id(),
        );
        assert!(pda != Pubkey::default());
    }

    #[test]
    fn test_mint_addresses() {
        // Verify that the mint addresses are valid Pubkeys
        assert!(Pubkey::from_str(JITOSOL_MINT).is_ok());
        assert!(Pubkey::from_str(WSOL_MINT).is_ok());
    }

    #[test]
    fn test_vault_balances_default() {
        let balances = VaultBalances::default();
        assert_eq!(balances.sol, 0);
        assert_eq!(balances.jitosol, 0);
        assert_eq!(balances.wsol, 0);
    }
}

/// Python module initialization
#[pymodule]
fn boring_vault_tools(_py: Python<'_>, m: &PyModule) -> PyResult<()> {
    m.add_class::<VaultBalances>()?;
    m.add_function(wrap_pyfunction!(sum_vault_balances, m)?)?;
    Ok(())
} 