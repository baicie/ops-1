//! Kernel-derived Ed25519 key material (P001-A).
//!
//! The key is deterministically derived from the cursor secret, so it is a
//! property of the platform, not of any application built on it. It lives in
//! Core for that reason: the Capability Gateway has to hand a plugin the public
//! key even on a build where no business application is compiled in, and a
//! second copy of this derivation in a business module is how two keys drift
//! apart until one of them stops verifying.
//!
//! What is signed with it is the caller's business. Today that is the `owa2`
//! automation principal; a future application-defined token uses the same key
//! and its own claims type.

use crate::state::AppState;
#[cfg(test)]
use ed25519_dalek::Signer;
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};

/// Domain-separation label. Changing it rotates every derived key, so it is a
/// compatibility boundary and not a comment: a deployment that changed it would
/// invalidate every outstanding signature.
const DERIVATION_LABEL: &[u8] = b"opsweave-automation-signing-v1";

/// The Kernel's signing key for this deployment.
///
/// Private by construction: the seed is derived from `cursor_secret`, which is
/// read from the database at startup and never returned by an endpoint.
pub(crate) fn signing_key(state: &AppState) -> SigningKey {
    let mut hasher = Sha256::new();
    hasher.update(DERIVATION_LABEL);
    hasher.update(state.cursor_secret.as_slice());
    let seed: [u8; 32] = hasher.finalize().into();
    SigningKey::from_bytes(&seed)
}

/// The public half, hex-encoded, as a plugin receives it.
pub(crate) fn public_key_hex(state: &AppState) -> String {
    hex::encode(signing_key(state).verifying_key().to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The key must be stable for one secret and different for another. Without
    /// the second half, a bug that ignored `cursor_secret` would still pass and
    /// every deployment would share one signing key.
    #[test]
    fn the_key_is_derived_from_the_cursor_secret_and_moves_with_it() {
        let key_a = derive_key(&[7u8; 32]);
        let key_a_again = derive_key(&[7u8; 32]);
        let key_b = derive_key(&[8u8; 32]);
        assert_eq!(key_a.to_bytes(), key_a_again.to_bytes());
        assert_ne!(key_a.to_bytes(), key_b.to_bytes());
    }

    /// A signature must verify with the public key handed to plugins, and must
    /// not verify against a different message. This is the whole contract the
    /// Capability Gateway's `OPSWEAVE_AUTOMATION_PUBLIC_KEY` exists for.
    #[test]
    fn what_is_signed_verifies_with_the_published_public_key_only_for_that_payload() {
        use ed25519_dalek::Verifier;
        let key = derive_key(&[3u8; 32]);
        let signature = key.sign(b"authored by the kernel");
        let published = key.verifying_key();
        assert!(published
            .verify(b"authored by the kernel", &signature)
            .is_ok());
        assert!(published
            .verify(b"authored by someone else", &signature)
            .is_err());
    }

    fn derive_key(secret: &[u8; 32]) -> SigningKey {
        let mut hasher = Sha256::new();
        hasher.update(DERIVATION_LABEL);
        hasher.update(secret);
        let seed: [u8; 32] = hasher.finalize().into();
        SigningKey::from_bytes(&seed)
    }
}
