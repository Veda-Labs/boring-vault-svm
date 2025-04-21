use pyo3::prelude::*;
use pyo3::types::PyDict;
use std::str::FromStr;

use crate::sum_vault_balances;

#[pymodule]
fn boring_vault_tools(_py: Python<'_>, m: &PyModule) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(get_vault_balances, m)?)?;
    Ok(())
}

#[pyfunction]
fn get_vault_balances(
    vault_id: u64,
    num_sub_accounts: u32,
    rpc_url: &str,
) -> PyResult<PyObject> {
    Python::with_gil(|py| {
        match sum_vault_balances(vault_id, num_sub_accounts, rpc_url) {
            Ok(balances) => {
                let dict = PyDict::new(py);
                dict.set_item("sol", balances.sol)?;
                dict.set_item("jitosol", balances.jitosol)?;
                dict.set_item("wsol", balances.wsol)?;
                Ok(dict.into())
            }
            Err(e) => Err(PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(e.to_string())),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_python_bindings() {
        Python::with_gil(|py| {
            let result = get_vault_balances(1, 5, "http://localhost:8899");
            assert!(result.is_err()); // Should fail with invalid RPC URL
        });
    }
} 