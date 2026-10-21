use crate::auth::seed_admin;
use crate::state::AppState;
use anyhow::Context;
use opsweave_bundle::parse_public_key;
use rand::RngCore;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub async fn connect(database_url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(16)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(database_url)
        .await
        .context("connect to PostgreSQL")?;
    Ok(pool)
}

pub async fn migrate(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .context("run kernel migrations")?;
    Ok(())
}

pub async fn load_or_create_cursor_secret(pool: &PgPool) -> anyhow::Result<Vec<u8>> {
    let existing: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT value FROM kernel.platform_settings WHERE key = 'cursor_secret'",
    )
    .fetch_optional(pool)
    .await?;
    if let Some(value) = existing {
        if let Some(encoded) = value.as_str() {
            return hex::decode(encoded).context("cursor secret is not hex");
        }
    }
    let mut secret = vec![0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    sqlx::query(
        "INSERT INTO kernel.platform_settings (key, value) VALUES ('cursor_secret', $1)
         ON CONFLICT (key) DO NOTHING",
    )
    .bind(serde_json::json!(hex::encode(&secret)))
    .execute(pool)
    .await?;
    // Re-read in case another process won the race.
    let stored: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT value FROM kernel.platform_settings WHERE key = 'cursor_secret'",
    )
    .fetch_optional(pool)
    .await?;
    if let Some(value) = stored {
        if let Some(encoded) = value.as_str() {
            return hex::decode(encoded).context("cursor secret is not hex");
        }
    }
    Ok(secret)
}

pub async fn seed_trusted_publisher(state: &AppState) -> anyhow::Result<()> {
    let Some(public_key_hex) = state.config.dev_publisher_public_key.clone() else {
        return Ok(());
    };
    let key = parse_public_key(&public_key_hex)
        .map_err(|error| anyhow::anyhow!("invalid OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY: {error}"))?;
    let fingerprint = opsweave_bundle::key_fingerprint(&key);
    sqlx::query(
        r#"
        INSERT INTO kernel.trusted_publishers (publisher_id, public_key_hex, fingerprint, trust_state, note)
        VALUES ($1,$2,$3,'TRUSTED','Seeded from environment for local development')
        ON CONFLICT (publisher_id) DO UPDATE
          SET public_key_hex = EXCLUDED.public_key_hex,
              fingerprint = EXCLUDED.fingerprint,
              trust_state = 'TRUSTED',
              revoked_at = NULL
          WHERE kernel.trusted_publishers.trust_state = 'TRUSTED'
        "#,
    )
    .bind(&state.config.dev_publisher_id)
    .bind(public_key_hex.trim().to_lowercase())
    .bind(&fingerprint)
    .execute(&state.db)
    .await?;
    tracing::info!(
        publisher = %state.config.dev_publisher_id,
        fingerprint = %fingerprint,
        "trusted publisher seeded"
    );
    Ok(())
}

pub async fn init(state: &AppState) -> anyhow::Result<()> {
    migrate(&state.db).await?;
    seed_admin(state).await?;
    seed_trusted_publisher(state).await?;
    Ok(())
}
