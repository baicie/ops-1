// Fixture remote entry for the contract bundle check.
//
// NOT the real plugin UI. The real bundle is built by scripts/build-plugins.sh and
// exercised by plugin-lifecycle.yml. This file exists so the `contracts` job can
// build a signed bundle with NO build step and NO Docker: `assemble_plugin.py`
// indexes whatever is in this directory, and `opsctl bundle` computes the digests
// over these bytes. The Python validator then recomputes them independently.
//
// That is the whole point: the check is "do the Rust signer and the Python
// validator agree on these bytes", which is true of any content. Using the real
// Vite output would add a pnpm install and a build to a 10-second job to test the
// same arithmetic.
export const fixture = 'contract-bundle';
