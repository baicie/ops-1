mod tests {
    use super::*;
    use opsweave_contracts::Role;
    use sqlx::postgres::PgConnectOptions;

    // Same convention as jobs.rs: skipping is reserved for "no database
    // configured and nobody asked for one". With OPSWEAVE_REQUIRE_TEST_DATABASE=1
    // a missing URL fails the run instead of reporting a green test that asserted
    // nothing.
    const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

    fn database_required() -> bool {
        match std::env::var(REQUIRE_DATABASE_ENV) {
            Err(std::env::VarError::NotPresent) => false,
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("{REQUIRE_DATABASE_ENV} is set but is not valid UTF-8")
            }
            Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
                "" | "0" | "false" | "no" => false,
                "1" | "true" | "yes" => true,
                other => panic!("{REQUIRE_DATABASE_ENV} is set to {other:?}: use 1 to require the DB-backed tests"),
            },
        }
    }

    async fn test_pool() -> Option<PgPool> {
        let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(std::env::VarError::NotPresent) => {
                if database_required() {
                    panic!(
                        "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset: \
                         skipping these tests would count as a failure"
                    );
                }
                eprintln!(
                    "skip: OPSWEAVE_TEST_DATABASE_URL is unset and {REQUIRE_DATABASE_ENV} is not 1"
                );
                return None;
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("OPSWEAVE_TEST_DATABASE_URL is set but is not valid UTF-8")
            }
        };
        let options: PgConnectOptions = url.parse().unwrap_or_else(|error| {
            panic!("OPSWEAVE_TEST_DATABASE_URL is not a PostgreSQL URL: {error}")
        });
        let pool = PgPool::connect_with(options)
            .await
            .unwrap_or_else(|error| panic!("cannot connect to the test database: {error}"));
        crate::db::migrate(&pool)
            .await
            .unwrap_or_else(|error| panic!("the test database rejected the migrations: {error:#}"));
        Some(pool)
    }

    async fn seed_user(pool: &PgPool, role: &str) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.users (id,email,display_name,password_hash,role)
             VALUES ($1,$2,$3,'not-a-real-hash',$4)",
        )
        .bind(id)
        .bind(format!("incident-test-{id}@example.invalid"))
        .bind(format!("incident test {role}"))
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
        // Since D5 an account reads a business row only through workspace membership, and
        // the handlers resolve that membership from this table. A fixture without the row
        // would exercise the "member of nothing" case in every test by accident.
        sqlx::query(
            "INSERT INTO kernel.business_workspace_members (workspace_id,user_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(scope::legacy_workspace())
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn cleanup(pool: &PgPool, users: &[Uuid]) {
        for user in users {
            // G12 C: incidents.closed_by, incident_evidence.submitted_by and
            // incident_verdicts.decided_by are all foreign keys onto kernel.users, and a
            // handover deliberately separates the account that acted from the account
            // that owns the row. So the set deleted here is every incident one of these
            // accounts touched - as owner, as the closer of record, as a submitter or as
            // the signer - before the accounts themselves go.
            let incidents = "
                SELECT i.incident_id FROM kernel.incidents i
                 WHERE i.owner=$1 OR i.closed_by=$1
                    OR EXISTS (SELECT 1 FROM kernel.incident_evidence e
                                WHERE e.incident_id=i.incident_id AND e.submitted_by=$1)
                    OR EXISTS (SELECT 1 FROM kernel.incident_verdicts v
                                WHERE v.incident_id=i.incident_id AND v.decided_by=$1)";
            // G12 B: content rows cannot be deleted on their own (the write-once
            // trigger refuses), and they are not left behind either: the foreign
            // key cascades from the evidence row, which is the one delete the
            // trigger allows. So this cleanup deletes evidence and the bytes follow
            // - no test has to switch a lock off to clean up after itself.
            //
            // 0025 makes verdicts write-once, deletion included, because a closure stands on
            // one. This is test cleanup, not a product path, so it states that in the one way
            // the schema accepts: a transaction-local flag that no route and no kernel code
            // sets. Without it the tests below would either leak their fixtures or delete
            // through the very guard they exist to prove.
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("SET LOCAL kernel.allow_verdict_removal = 'on'")
                .execute(&mut *tx)
                .await
                .unwrap();
            let sql =
                format!("DELETE FROM kernel.incident_verdicts WHERE incident_id IN ({incidents})");
            sqlx::query(&sql)
                .bind(user)
                .execute(&mut *tx)
                .await
                .unwrap();
            tx.commit().await.unwrap();
            let sql =
                format!("DELETE FROM kernel.incident_evidence WHERE incident_id IN ({incidents})");
            sqlx::query(&sql).bind(user).execute(pool).await.unwrap();
            sqlx::query("DELETE FROM kernel.incidents WHERE owner=$1")
                .bind(user)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM kernel.audit_events WHERE actor_id=$1")
                .bind(user.to_string())
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM kernel.users WHERE id=$1")
                .bind(user)
                .execute(pool)
                .await
                .unwrap();
        }
    }

    /// A test caller scoped to the legacy workspace the migration creates. Every
    /// incident a test files through insert_incident lands there (a caller with
    /// exactly one workspace does not have to name it), and every read these tests
    /// perform is bounded by it - which is the point of the helper: a test cannot
    /// accidentally read a row from a workspace it never granted itself.
    fn caller(user_id: Uuid) -> DataScope {
        DataScope::for_test(
            user_id,
            vec![scope::legacy_workspace()],
            crate::scope::RowRule::OwnedRows,
        )
    }

    fn admin_caller(user_id: Uuid) -> DataScope {
        DataScope::for_test(
            user_id,
            vec![scope::legacy_workspace()],
            crate::scope::RowRule::AllRows,
        )
    }

    fn incident_request(title: &str, native_id: Option<&str>) -> CreateIncidentRequest {
        CreateIncidentRequest {
            title: title.to_string(),
            severity: "MAJOR".to_string(),
            source: Some("API".to_string()),
            native_id: native_id.map(str::to_string),
            related_entity: Some("host:test-node".to_string()),
            workspace_id: None,
            started_at: Utc::now(),
        }
    }

    /// A plain operator submission: no attestation, so at most OPERATOR_ASSERTED.
    /// The pre-G12 version of this helper asked for SOURCE_ATTESTED in the body,
    /// which is exactly the defect - it is kept out of the fixtures on purpose.
    fn evidence_request(content_ref: &str) -> CreateEvidenceRequest {
        CreateEvidenceRequest {
            kind: "METRIC_SNAPSHOT".to_string(),
            source: "prometheus".to_string(),
            collected_at: Utc::now(),
            content_ref: Some(content_ref.to_string()),
            content: None,
            trust: None,
            claimed_trust: None,
            attestation: None,
        }
    }

    /// The adapter set a test hands to insert_evidence. Empty unless a test is
    /// exercising the attested path, so no test proves attestation by accident.
    fn no_adapters() -> HashMap<String, String> {
        HashMap::new()
    }

    const ADAPTER_ID: &str = "zabbix-main";
    const ADAPTER_SECRET: &str = "adapter-secret-for-tests";

    fn adapters() -> HashMap<String, String> {
        let mut map = HashMap::new();
        map.insert(ADAPTER_ID.to_string(), ADAPTER_SECRET.to_string());
        map
    }

    /// The tuple a test signs over, kept in one place so a test cannot sign one
    /// set of fields and submit another by accident.
    fn tuple<'a>(
        incident_id: Uuid,
        kind: &'a str,
        source: &'a str,
        content_ref: &'a str,
        collected_at: DateTime<Utc>,
    ) -> EvidenceTuple<'a> {
        EvidenceTuple {
            incident_id,
            workspace_id: scope::legacy_workspace(),
            kind,
            source,
            collected_at,
            content_ref,
        }
    }

    /// Builds the attestation an honest adapter would send for this tuple.
    fn attested_request(
        bound: &EvidenceTuple<'_>,
        adapter_id: &str,
        secret: &str,
        issued_at: DateTime<Utc>,
    ) -> CreateEvidenceRequest {
        let payload = attestation_payload(adapter_id, bound, issued_at).unwrap();
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        use base64::Engine;
        let signature =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        CreateEvidenceRequest {
            kind: bound.kind.to_string(),
            source: bound.source.to_string(),
            collected_at: bound.collected_at,
            content_ref: Some(bound.content_ref.to_string()),
            content: None,
            trust: None,
            claimed_trust: None,
            attestation: Some(AttestationRequest {
                adapter_id: adapter_id.to_string(),
                workspace_id: Some(bound.workspace_id),
                issued_at,
                signature,
            }),
        }
    }

    /// Golden vector for the signed payload.
    ///
    /// The in-process attestation tests cannot catch a key-format mistake: both
    /// sides call attestation_payload, so both would be wrong the same way. This
    /// asserts the literal bytes an adapter written from the contract produces.
    #[test]
    fn attestation_payload_matches_the_published_golden_vector() {
        let bound = tuple(
            Uuid::parse_str("b17265e7-3ac8-4877-bad4-40c4d2df4a87").unwrap(),
            "METRIC_SNAPSHOT",
            "zabbix:probe",
            "sha256:probe-1",
            DateTime::parse_from_rfc3339("2026-10-31T05:17:24Z")
                .unwrap()
                .with_timezone(&Utc),
        );
        let issued_at = DateTime::parse_from_rfc3339("2026-10-31T05:17:24Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            attestation_payload("zabbix-main", &bound, issued_at).unwrap(),
            concat!(
                r#"{"v":"opsweave-evidence-attestation-v2","adapterId":"zabbix-main","#,
                r#""workspaceId":"00000000-0000-4000-8000-000000000001","#,
                r#""incidentId":"b17265e7-3ac8-4877-bad4-40c4d2df4a87","#,
                r#""kind":"METRIC_SNAPSHOT","source":"zabbix:probe","#,
                r#""collectedAtUnix":1793423844,"contentRef":"sha256:probe-1","#,
                r#""issuedAtUnix":1793423844}"#
            )
        );
    }

    /// The historical v1 payload is still reproducible byte for byte. It is used
    /// only to recognise and refuse a v1 envelope with a named error.
    #[test]
    fn the_v1_payload_is_recognised_but_only_for_refusal() {
        let bound = tuple(
            Uuid::parse_str("b17265e7-3ac8-4877-bad4-40c4d2df4a87").unwrap(),
            "METRIC_SNAPSHOT",
            "zabbix:probe",
            "sha256:probe-1",
            DateTime::parse_from_rfc3339("2026-10-31T05:17:24Z")
                .unwrap()
                .with_timezone(&Utc),
        );
        let issued_at = DateTime::parse_from_rfc3339("2026-10-31T05:17:24Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            attestation_payload_v1("zabbix-main", &bound, issued_at).unwrap(),
            concat!(
                r#"{"v":"opsweave-evidence-attestation-v1","adapterId":"zabbix-main","#,
                r#""incidentId":"b17265e7-3ac8-4877-bad4-40c4d2df4a87","#,
                r#""kind":"METRIC_SNAPSHOT","source":"zabbix:probe","#,
                r#""collectedAtUnix":1793423844,"contentRef":"sha256:probe-1","#,
                r#""issuedAtUnix":1793423844}"#
            )
        );
    }

    fn verdict_request(verdict: &str) -> CreateVerdictRequest {
        CreateVerdictRequest {
            verdict: verdict.to_string(),
            rationale: "cpu saturation matches the reported window".to_string(),
        }
    }
    fn close_request(revision: i64, note: &str) -> CloseIncidentRequest {
        CloseIncidentRequest {
            expected_revision: revision,
            note: note.to_string(),
            idempotency_key: None,
        }
    }

    fn keyed_close_request(revision: i64, note: &str, key: &str) -> CloseIncidentRequest {
        CloseIncidentRequest {
            expected_revision: revision,
            note: note.to_string(),
            idempotency_key: Some(key.to_string()),
        }
    }

    fn transfer_request(revision: i64, to_owner: Uuid, reason: &str) -> TransferOwnerRequest {
        TransferOwnerRequest {
            expected_revision: revision,
            to_owner,
            reason: reason.to_string(),
        }
    }

    /// An incident walked to CONCLUDED through the same data paths the endpoints
    /// call: one evidence row, then a signed verdict. No test may reach CONCLUDED by
    /// writing the status, because then it would be proving a state the product
    /// cannot produce.
    async fn concluded_incident(pool: &PgPool, user: Uuid, title: &str) -> IncidentView {
        let (_, incident) = insert_incident(pool, caller(user), incident_request(title, None))
            .await
            .unwrap();
        insert_evidence(
            pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request(&format!("sha256:{}", Uuid::new_v4().simple())),
        )
        .await
        .unwrap();
        insert_verdict(
            pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap();
        query_incident(pool, caller(user), incident.id)
            .await
            .unwrap()
    }

    /// The same walk, one step further: the closure, through close_incident_record.
    async fn closed_incident(pool: &PgPool, user: Uuid, title: &str) -> IncidentView {
        let concluded = concluded_incident(pool, user, title).await;
        close_incident_record(
            pool,
            caller(user),
            concluded.id,
            close_request(concluded.revision, "resolved: the node came back"),
        )
        .await
        .unwrap()
    }

    // -- pure validation -----------------------------------------------------

    #[test]
    fn closed_sets_reject_unknown_values_and_normalize_case() {
        assert_eq!(
            closed_set("major", SEVERITIES, "severity").unwrap(),
            "MAJOR"
        );
        assert_eq!(
            closed_set("  INCONCLUSIVE  ", VERDICT_VALUES, "verdict").unwrap(),
            "INCONCLUSIVE"
        );
        let error = closed_set("CRITICAL2", SEVERITIES, "severity").unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(error.message.contains("CRITICAL, MAJOR, MINOR, WARNING"));
        // A value the table CHECK would reject must never reach the database.
        assert!(closed_set("ZABBIX", SOURCES, "source").is_err());
        assert!(closed_set("AI_INFERENCE", CLAIMABLE_TRUSTS, "claimedTrust").is_err());
        // G12 A1: the claimable set is strictly smaller than the stored set. A
        // caller can never name the one value that means "the Kernel checked".
        assert!(!CLAIMABLE_TRUSTS.contains(&"SOURCE_ATTESTED"));
    }

    #[test]
    fn bounded_counts_characters_not_bytes() {
        // Four CJK characters are twelve bytes: a byte-length check would reject
        // a title the database accepts.
        assert_eq!(
            bounded("  故障已确认  ", "title", 4, 200).unwrap(),
            "故障已确认"
        );
        assert!(bounded("abc", "title", 4, 200).is_err());
        assert!(bounded(&"a".repeat(201), "title", 4, 200).is_err());
        assert_eq!(
            optional_bounded(Some("   "), "nativeId", 200).unwrap(),
            None
        );
        assert!(optional_bounded(Some(&"a".repeat(201)), "nativeId", 200).is_err());
    }

    #[test]
    fn cursor_round_trips_and_rejects_garbage() {
        let row = IncidentRow {
            incident_id: Uuid::new_v4(),
            title: "t".to_string(),
            severity: "MAJOR".to_string(),
            status: "OPEN".to_string(),
            source: "API".to_string(),
            native_id: None,
            related_entity: None,
            started_at: Utc::now(),
            updated_at: Utc::now(),
            owner: Uuid::new_v4(),
            owner_assigned_at: Utc::now(),
            origin: Some("USER".into()),
            revision: 1,
            closed_at: None,
            closed_by: None,
            closure_note: None,
            evidence_refs: sqlx::types::Json(Vec::new()),
            verdict_value: None,
            verdict_rationale: None,
            verdict_decided_by: None,
            verdict_decided_at: None,
            verdict_considered_count: None,
            verdict_considered_digest: None,
            verdict_snapshot_kind: None,
        };
        let encoded = encode_cursor(&row);
        let (time, id) = decode_cursor(&encoded).unwrap();
        assert_eq!(id, row.incident_id);
        assert_eq!(time, row.started_at);
        assert_eq!(
            decode_cursor("not*base64").unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
        assert!(decode_cursor("bm8tc2VwYXJhdG9y").is_err());
    }

    // -- database-backed -----------------------------------------------------

    #[tokio::test]
    async fn create_is_idempotent_on_the_source_native_key() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let me = caller(user);

        let (created, first) = insert_incident(
            &pool,
            me.clone(),
            incident_request("disk full on web-01", Some("native-1")),
        )
        .await
        .unwrap();
        assert!(created);
        assert_eq!(first.status, "OPEN");
        assert_eq!(first.owner, user);

        let (created_again, second) = insert_incident(
            &pool,
            me.clone(),
            incident_request("disk full on web-01", Some("native-1")),
        )
        .await
        .unwrap();
        assert!(
            !created_again,
            "a replayed create must not create a second row"
        );
        assert_eq!(second.id, first.id);

        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM kernel.incidents WHERE owner=$1")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 1);

        let (manual, _) = insert_incident(&pool, me, incident_request("manual report", None))
            .await
            .unwrap();
        assert!(
            manual,
            "a manual incident has no natural key and is never deduplicated"
        );

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn operator_scope_hides_other_owners_and_admin_sees_everything() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let operator_a = seed_user(&pool, "operator").await;
        let operator_b = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;

        let (_, mine) =
            insert_incident(&pool, caller(operator_a), incident_request("a only", None))
                .await
                .unwrap();
        let (_, theirs) =
            insert_incident(&pool, caller(operator_b), incident_request("b only", None))
                .await
                .unwrap();

        let read = query_incidents(
            &pool,
            caller(operator_a),
            IncidentListQuery {
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let items = read.items;
        assert!(items.iter().all(|item| item.owner == operator_a));
        assert!(items.iter().any(|item| item.id == mine.id));

        // Out-of-scope single reads answer 404, exactly like require_job_access.
        let error = query_incident(&pool, caller(operator_a), theirs.id)
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.code, "INCIDENT_NOT_FOUND");

        let admin_read = query_incidents(
            &pool,
            admin_caller(admin),
            IncidentListQuery {
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let admin_items = admin_read.items;
        assert!(admin_items.iter().any(|item| item.id == mine.id));
        assert!(admin_items.iter().any(|item| item.id == theirs.id));
        assert!(query_incident(&pool, admin_caller(admin), theirs.id)
            .await
            .is_ok());

        cleanup(&pool, &[operator_a, operator_b, admin]).await;
    }

    /// The payload's scope has to be the predicate, not a second opinion about it.
    ///
    /// The stranger below reads no row while a row exists: that is the case the UI used to
    /// render as "no incident has been recorded yet", because items alone cannot say whether a
    /// list is empty or narrowed. Both callers here read what query_incidents already returned;
    /// what this test pins is the scope that travels beside those rows.
    #[tokio::test]
    async fn the_reported_scope_agrees_with_the_predicate() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let stranger = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;

        let (_, theirs) =
            insert_incident(&pool, caller(owner), incident_request("scope probe", None))
                .await
                .unwrap();

        let stranger_read = query_incidents(
            &pool,
            caller(stranger),
            IncidentListQuery {
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // The predicate hides the row...
        assert!(!stranger_read.items.iter().any(|item| item.id == theirs.id));
        // ...and the scope derived from THAT predicate says why, without naming the row.
        let narrowed = scope_view(&stranger_read.predicate, 1);
        assert_eq!(narrowed.narrowed_to, Some("owner"));
        // The reported narrowing and the boolean the query bound are the same value: both come
        // out of the RowPredicate this read executed, not out of a second reading of the
        // caller. `all_rows() == true` beside an `owner` narrowing is now unrepresentable.
        assert_eq!(
            narrowed.narrowed_to.is_none(),
            stranger_read.predicate.all_rows()
        );

        let owner_read = query_incidents(
            &pool,
            caller(owner),
            IncidentListQuery {
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(owner_read.items.iter().any(|item| item.id == theirs.id));
        // An owner who can read its own row is still narrowed: the scope describes the read,
        // not the result, so it does not flip to "unnarrowed" because a row happened to appear.
        assert_eq!(
            scope_view(&owner_read.predicate, 1).narrowed_to,
            Some("owner")
        );

        // The other end: an unnarrowed read says only that it applied no owner narrowing. It
        // is not a count of the platform - the wire test below is where that reading is kept
        // from coming back as a field.
        let admin_read = query_incidents(
            &pool,
            admin_caller(admin),
            IncidentListQuery {
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(scope_view(&admin_read.predicate, 1).narrowed_to, None);

        cleanup(&pool, &[owner, stranger, admin]).await;
    }

    /// Every narrowing the predicate applies is named in the response, for every role.
    ///
    /// The oracle is the wire value: take the read each role actually performs, read
    /// `narrowedTo` out of the scope derived from that read's predicate, and compute from
    /// that one name which seeded rows the caller is licensed to see. If the predicate
    /// grows a clause the response does not name - the counterfactual in the commit
    /// message adds a severity filter - the rows returned and the reported narrowing stop
    /// agreeing, and this test fails for the role whose read lost a row.
    ///
    /// The fixture rows are filtered down before comparing, because other tests share
    /// this database and may hold rows in the same workspace; what is asserted is that
    /// among these rows, exactly the licensed ones came back.
    #[tokio::test]
    async fn every_narrowing_the_read_applies_is_named_for_every_role() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let operator = seed_user(&pool, "operator").await;
        let peer = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;
        let viewer = seed_user(&pool, "viewer").await;

        let (_, owned) = insert_incident(
            &pool,
            caller(operator),
            incident_request("narrow owned", None),
        )
        .await
        .unwrap();
        let (_, peer_owned) =
            insert_incident(&pool, caller(peer), incident_request("narrow peer", None))
                .await
                .unwrap();
        // An ordinary row of another severity: the counterfactual hides it with an
        // extra clause that does not touch the reported narrowing.
        let mut minor = incident_request("narrow minor", None);
        minor.severity = "MINOR".to_string();
        let (_, owned_minor) = insert_incident(&pool, caller(operator), minor)
            .await
            .unwrap();

        for (role, user, rows, expected_narrowing) in [
            (Role::Admin, admin, crate::scope::RowRule::AllRows, None),
            (
                Role::Operator,
                operator,
                crate::scope::RowRule::OwnedRows,
                Some("owner"),
            ),
            (Role::Viewer, viewer, crate::scope::RowRule::AllRows, None),
        ] {
            let scope = DataScope::for_test(user, vec![scope::legacy_workspace()], rows);
            let workspace_count = scope.workspace_count();
            let read = query_incidents(
                &pool,
                scope,
                IncidentListQuery {
                    limit: Some(100),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            let view = scope_view(&read.predicate, workspace_count);
            assert_eq!(view.narrowed_to, expected_narrowing, "{role}");
            // The reported value is the predicate's own narrowing, not a second opinion.
            assert_eq!(
                read.predicate.narrowing().map(scope::Narrowing::wire_name),
                view.narrowed_to,
                "{role}"
            );

            // A client reads only the wire value. License rows from it, and from nothing
            // else; a future narrowing wire name has to teach this oracle what it means.
            let fixture = [
                (owned.id, operator),
                (peer_owned.id, peer),
                (owned_minor.id, operator),
            ];
            let mut licensed: Vec<Uuid> = Vec::new();
            for (id, owner) in fixture {
                let licensed_here = match view.narrowed_to {
                    None => true,
                    Some("owner") => owner == user,
                    Some(other) => panic!("the oracle does not know narrowedTo={other:?}"),
                };
                if licensed_here {
                    licensed.push(id);
                }
            }
            let mut visible: Vec<Uuid> = read
                .items
                .iter()
                .map(|item| item.id)
                .filter(|id| fixture.iter().any(|(fixture_id, _)| fixture_id == id))
                .collect();
            licensed.sort();
            visible.sort();
            assert_eq!(
                visible, licensed,
                "{role}: the rows the predicate returned are not the rows narrowedTo={:?} licenses",
                view.narrowed_to
            );
        }

        cleanup(&pool, &[operator, peer, admin, viewer]).await;
    }

    /// The wire shape of the scope, for every role and for a caller with no membership.
    ///
    /// Two things are kept true at once. The shape is the SAME for every role, so no
    /// role's list can be read as "the platform's whole incident list" out of a
    /// differently valued field; `seesAll` must stay absent, and adding it back is a
    /// failing assertion rather than a review comment. And `workspaceCount` is the
    /// field that can explain an empty page no role explains: zero workspaces means no
    /// read in the kernel can return a row for this caller, whatever its role is.
    ///
    /// The viewer row is a recorded observation, not an endorsement. Since D5 it can
    /// only ever be reached through a workspace the viewer is a member of.
    #[test]
    fn the_scope_view_names_its_fields_for_every_role_on_the_wire() {
        let workspaces = vec![scope::legacy_workspace()];
        for (role, expected) in [
            (
                Role::Admin,
                serde_json::json!({ "narrowedTo": null, "workspaceCount": 1 }),
            ),
            (
                Role::Operator,
                serde_json::json!({ "narrowedTo": "owner", "workspaceCount": 1 }),
            ),
            (
                Role::Viewer,
                serde_json::json!({ "narrowedTo": null, "workspaceCount": 1 }),
            ),
        ] {
            let scope = DataScope::for_test(
                Uuid::new_v4(),
                workspaces.clone(),
                crate::scope::RowRule::for_role(role),
            );
            let predicate = scope.row_predicate("i", 1, 2, 3);
            let view =
                serde_json::to_value(scope_view(&predicate, scope.workspace_count())).unwrap();
            assert_eq!(view, expected, "{role}");
            assert_eq!(
                view.as_object().unwrap().len(),
                2,
                "{role} names two things: {view}"
            );
            assert!(
                view.get("seesAll").is_none(),
                "{role} must not claim the world: {view}"
            );
        }
        // A caller with no membership: the value that explains an empty page.
        let starving_scope =
            DataScope::for_test(Uuid::new_v4(), Vec::new(), crate::scope::RowRule::AllRows);
        let starving_predicate = starving_scope.row_predicate("i", 1, 2, 3);
        let starving = serde_json::to_value(scope_view(
            &starving_predicate,
            starving_scope.workspace_count(),
        ))
        .unwrap();
        assert_eq!(
            starving,
            serde_json::json!({ "narrowedTo": null, "workspaceCount": 0 })
        );
    }

    /// D3 added an `owner` list filter for the UI. The rule it must not break is the one the
    /// role predicate already enforces: a filter narrows what the caller may read, it never
    /// reaches past that scope. An operator asking for another owner's id gets an empty page,
    /// not their rows; an admin asking for the same id gets them.
    #[tokio::test]
    async fn owner_filter_narrows_the_scope_and_never_widens_it() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let operator = seed_user(&pool, "operator").await;
        let other = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;

        let (_, mine) = insert_incident(
            &pool,
            caller(operator),
            incident_request("owner filter mine", None),
        )
        .await
        .unwrap();
        let (_, theirs) = insert_incident(
            &pool,
            caller(other),
            incident_request("owner filter theirs", None),
        )
        .await
        .unwrap();

        let own_rows = query_incidents(
            &pool,
            caller(operator),
            IncidentListQuery {
                owner: Some(operator.to_string()),
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .items;
        assert!(own_rows.iter().any(|item| item.id == mine.id));
        assert!(own_rows.iter().all(|item| item.owner == operator));

        let their_rows = query_incidents(
            &pool,
            caller(operator),
            IncidentListQuery {
                owner: Some(other.to_string()),
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .items;
        assert!(
            their_rows.is_empty(),
            "an operator must not read another owner's rows by filtering for them"
        );

        let admin_rows = query_incidents(
            &pool,
            admin_caller(admin),
            IncidentListQuery {
                owner: Some(other.to_string()),
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .items;
        assert!(admin_rows.iter().any(|item| item.id == theirs.id));

        let error = query_incidents(
            &pool,
            caller(operator),
            IncidentListQuery {
                owner: Some("not-a-uuid".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");

        cleanup(&pool, &[operator, other, admin]).await;
    }

    #[tokio::test]
    async fn evidence_replay_is_idempotent_and_moves_open_to_investigating() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("latency spike", None))
                .await
                .unwrap();

        let (created, first) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:metric-window-1"),
        )
        .await
        .unwrap();
        assert!(created);

        let (created_again, second) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:metric-window-1"),
        )
        .await
        .unwrap();
        assert!(
            !created_again,
            "identical evidence is one fact, not two rows"
        );
        assert_eq!(second.evidence_id, first.evidence_id);

        let after = query_incident(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(after.status, "INVESTIGATING");
        assert_eq!(after.evidence_refs, vec![first.evidence_id]);
        assert_eq!(
            query_evidence(&pool, caller(user), incident.id, (None, None))
                .await
                .unwrap()
                .len(),
            1
        );

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn verdict_requires_evidence_and_is_write_once() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("oom kills", None))
                .await
                .unwrap();

        let error = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_EVIDENCE_REQUIRED");

        let error = insert_verdict(&pool, caller(user), incident.id, verdict_request("MOSTLY"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");

        insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:oom-log"),
        )
        .await
        .unwrap();

        let verdict = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap();
        assert_eq!(verdict.verdict, "CONFIRMED");
        assert_eq!(verdict.decided_by, user);

        let after = query_incident(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(after.status, "CONCLUDED");
        assert_eq!(after.human_verdict.as_ref().unwrap().verdict, "CONFIRMED");

        let error = insert_verdict(&pool, caller(user), incident.id, verdict_request("REFUTED"))
            .await
            .unwrap_err();
        assert_eq!(error.code, "INCIDENT_ALREADY_CONCLUDED");
        assert_eq!(error.status, StatusCode::CONFLICT);

        // 0025: "write-once" is now a property of the TABLE, not of the absence of an endpoint.
        // The API refusal above always held; what did not hold - measured on a real database -
        // was that any SQL could rewrite or delete the row the closure stands on.
        let revise = sqlx::query(
            "UPDATE kernel.incident_verdicts SET verdict='INCONCLUSIVE' WHERE incident_id=$1",
        )
        .bind(incident.id)
        .execute(&pool)
        .await
        .expect_err("a signed verdict must not be revisable");
        assert!(
            revise.to_string().contains("cannot be revised"),
            "expected the 0025 refusal, got: {revise}"
        );
        let remove = sqlx::query("DELETE FROM kernel.incident_verdicts WHERE incident_id=$1")
            .bind(incident.id)
            .execute(&pool)
            .await
            .expect_err("a signed verdict must not be deletable");
        assert!(
            remove.to_string().contains("cannot be deleted"),
            "expected the 0025 refusal, got: {remove}"
        );
        let still: String =
            sqlx::query_scalar("SELECT verdict FROM kernel.incident_verdicts WHERE incident_id=$1")
                .bind(incident.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            still, "CONFIRMED",
            "the signature is exactly what was signed"
        );

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn inconclusive_verdict_needs_no_evidence() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("unknown cause", None))
                .await
                .unwrap();

        let verdict = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("INCONCLUSIVE"),
        )
        .await
        .unwrap();
        assert_eq!(verdict.verdict, "INCONCLUSIVE");
        let after = query_incident(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(after.status, "CONCLUDED");

        cleanup(&pool, &[user]).await;
    }

    // -----------------------------------------------------------------------
    // G12 C1 - the controlled CONCLUDED -> CLOSED.
    //
    // Every test here walks the incident through the real data paths (evidence,
    // verdict, close) rather than writing status='CLOSED' by hand: a test that
    // injects the state it is testing proves the guard around a state the product
    // cannot produce.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn closing_a_concluded_incident_records_the_closure_and_its_audit() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let concluded = concluded_incident(&pool, user, "disk full on node-7").await;
        assert_eq!(concluded.status, "CONCLUDED");
        assert!(concluded.closed_at.is_none());
        let revision_before = concluded.revision;

        let closed = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            close_request(revision_before, "root cause was log rotation; fixed"),
        )
        .await
        .unwrap();

        assert_eq!(closed.status, "CLOSED");
        assert_eq!(closed.closed_by, Some(user));
        assert_eq!(
            closed.closure_note.as_deref(),
            Some("root cause was log rotation; fixed")
        );
        assert!(closed.closed_at.is_some());
        assert_eq!(
            closed.revision,
            revision_before + 1,
            "a closure is a change to the record, so the version moves with it"
        );
        // The verdict is untouched by the closure: it is what the closure stands on,
        // not a step that gets rewritten.
        assert!(closed.human_verdict.is_some());
        assert_eq!(audit_rows(&pool, concluded.id, "INCIDENT_CLOSED").await, 1);

        cleanup(&pool, &[user]).await;
    }
    /// The direct jump the state machine must not have.
    #[tokio::test]
    async fn an_open_or_investigating_incident_cannot_jump_straight_to_closed() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, open) =
            insert_incident(&pool, caller(user), incident_request("never triaged", None))
                .await
                .unwrap();

        // OPEN -> CLOSED, refused with the reason and the current status.
        let error = close_incident_record(
            &pool,
            caller(user),
            open.id,
            close_request(open.revision, "closing without investigating"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "INCIDENT_CLOSE_REQUIRES_CONCLUDED");
        assert!(
            error.message.contains("OPEN"),
            "the refusal must say which status refused it: {}",
            error.message
        );

        // INVESTIGATING -> CLOSED, same refusal: evidence is not a conclusion.
        insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            open.id,
            evidence_request("sha256:first-look"),
        )
        .await
        .unwrap();
        let investigating = query_incident(&pool, caller(user), open.id).await.unwrap();
        assert_eq!(investigating.status, "INVESTIGATING");
        let error = close_incident_record(
            &pool,
            caller(user),
            open.id,
            close_request(investigating.revision, "still closing without a verdict"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_CLOSE_REQUIRES_CONCLUDED");

        // Neither refusal wrote anything.
        let after = query_incident(&pool, caller(user), open.id).await.unwrap();
        assert_eq!(after.status, "INVESTIGATING");
        assert!(after.closed_at.is_none());
        assert_eq!(after.revision, investigating.revision);
        assert_eq!(audit_rows(&pool, open.id, "INCIDENT_CLOSED").await, 0);

        cleanup(&pool, &[user]).await;
    }

    /// A closure stands on a signed verdict, in the handler AND in the schema.
    #[tokio::test]
    async fn closing_without_a_signed_verdict_is_refused_twice_over() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("concluded by hand", None),
        )
        .await
        .unwrap();
        // The only way to be CONCLUDED without a verdict is a hand-written UPDATE.
        sqlx::query("UPDATE kernel.incidents SET status='CONCLUDED' WHERE incident_id=$1")
            .bind(incident.id)
            .execute(&pool)
            .await
            .unwrap();

        let error = close_incident_record(
            &pool,
            caller(user),
            incident.id,
            close_request(1, "nothing was signed here"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "INCIDENT_CLOSE_REQUIRES_VERDICT");

        // And the schema refuses the same closure one layer down, so a bug in the
        // handler cannot close an unsigned incident either.
        let direct = sqlx::query(
            "UPDATE kernel.incidents
                SET status='CLOSED', closed_at=now(), closed_by=$2 WHERE incident_id=$1",
        )
        .bind(incident.id)
        .bind(user)
        .execute(&pool)
        .await;
        let message = direct
            .expect_err("the schema must refuse a closure with no signed verdict")
            .to_string();
        assert!(
            message.contains("no human verdict"),
            "unexpected database refusal: {message}"
        );

        cleanup(&pool, &[user]).await;
    }
    /// Two operators closing the same incident at the same instant.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_simultaneous_closes_produce_exactly_one_closure() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let concluded = concluded_incident(&pool, user, "flapping link").await;
        let revision = concluded.revision;

        let (first, second) = tokio::join!(
            close_incident_record(
                &pool,
                caller(user),
                concluded.id,
                close_request(revision, "closed by the first caller"),
            ),
            close_incident_record(
                &pool,
                caller(user),
                concluded.id,
                close_request(revision, "closed by the second caller"),
            ),
        );

        let succeeded = [&first, &second]
            .iter()
            .filter(|result| result.is_ok())
            .count();
        assert_eq!(
            succeeded, 1,
            "exactly one close may win: first={first:?} second={second:?}"
        );
        let loser = match (first, second) {
            (Err(error), _) => error,
            (_, Err(error)) => error,
            _ => unreachable!("the assertion above already proved one close failed"),
        };
        assert_eq!(loser.status, StatusCode::CONFLICT);
        assert!(
            matches!(
                loser.code,
                "INCIDENT_ALREADY_CLOSED" | "INCIDENT_VERSION_CONFLICT" | "INCIDENT_STATE_CONFLICT"
            ),
            "the losing close must be told why, not handed a 500: {}",
            loser.code
        );

        // One closure of record: one audit row, one closed_at.
        assert_eq!(audit_rows(&pool, concluded.id, "INCIDENT_CLOSED").await, 1);
        let row: (i64, i64) = sqlx::query_as(
            "SELECT count(*), count(DISTINCT closed_at::text)::bigint FROM kernel.incidents
              WHERE incident_id=$1 AND status='CLOSED'",
        )
        .bind(concluded.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, (1, 1));

        cleanup(&pool, &[user]).await;
    }

    /// Idempotency: a retried close is the closure that happened; a second close is
    /// a second decision and is refused.
    #[tokio::test]
    async fn a_retried_close_is_answered_with_the_closure_it_repeats() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let concluded = concluded_incident(&pool, user, "cache stampede").await;
        let revision = concluded.revision;
        let key = format!("close-{}", Uuid::new_v4().simple());

        let first = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            keyed_close_request(revision, "fixed by warming the cache", &key),
        )
        .await
        .unwrap();
        let replay = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            keyed_close_request(
                revision,
                "a second note that must not replace the first",
                &key,
            ),
        )
        .await
        .unwrap();

        assert_eq!(replay.status, "CLOSED");
        assert_eq!(
            replay.closed_at, first.closed_at,
            "a replay must answer with the closure of record, not with a new one"
        );
        assert_eq!(
            replay.closure_note, first.closure_note,
            "the replay must not rewrite the reason the first close recorded"
        );
        assert_eq!(
            replay.revision, first.revision,
            "a replay changes nothing, so the version does not move either"
        );
        assert_eq!(audit_rows(&pool, concluded.id, "INCIDENT_CLOSED").await, 1);

        // A different key is a second closure attempt, not a retry.
        let error = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            keyed_close_request(
                first.revision,
                "closing it again on purpose",
                "a-different-key",
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "INCIDENT_ALREADY_CLOSED");

        // And a caller with no key at all cannot claim a retry.
        let error = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            close_request(first.revision, "closing it again with no key"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_ALREADY_CLOSED");

        cleanup(&pool, &[user]).await;
    }

    /// The closure and the audit row that describes it are one transaction.
    #[tokio::test]
    async fn a_failed_audit_rolls_the_closure_back() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let concluded = concluded_incident(&pool, user, "io error burst").await;
        let revision = concluded.revision;

        let probe = refuse_audit(&pool, "INCIDENT_CLOSED", user).await;
        let refused = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            close_request(revision, "closing while the audit table refuses"),
        )
        .await;
        allow_audit(&pool, &probe).await;

        let error = refused.unwrap_err();
        assert_eq!(error.code, "AUDIT_WRITE_FAILED");
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            error.retryable,
            "nothing was persisted, so telling the client to retry is honest"
        );

        let after = query_incident(&pool, caller(user), concluded.id)
            .await
            .unwrap();
        assert_eq!(
            after.status, "CONCLUDED",
            "a closure without its audit row must not exist"
        );
        assert!(after.closed_at.is_none());
        assert_eq!(after.revision, revision);

        // The same request succeeds once the audit can be written, which is what
        // makes the previous 500 a rollback rather than a poisoned state.
        let closed = close_incident_record(
            &pool,
            caller(user),
            concluded.id,
            close_request(revision, "retried after the audit table recovered"),
        )
        .await
        .unwrap();
        assert_eq!(closed.status, "CLOSED");
        assert_eq!(audit_rows(&pool, concluded.id, "INCIDENT_CLOSED").await, 1);

        cleanup(&pool, &[user]).await;
    }

    /// After CLOSED: every write is refused, and there is no way back.
    #[tokio::test]
    async fn a_closed_incident_refuses_every_write_and_cannot_be_reopened() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let other = seed_user(&pool, "operator").await;
        let closed = closed_incident(&pool, user, "old noise").await;
        assert_eq!(closed.status, "CLOSED");

        for (code, error) in [
            (
                "INCIDENT_CLOSED",
                insert_evidence(
                    &pool,
                    &no_adapters(),
                    caller(user),
                    closed.id,
                    evidence_request("sha256:late"),
                )
                .await
                .unwrap_err(),
            ),
            (
                "INCIDENT_CLOSED",
                insert_verdict(
                    &pool,
                    caller(user),
                    closed.id,
                    verdict_request("INCONCLUSIVE"),
                )
                .await
                .unwrap_err(),
            ),
            (
                "INCIDENT_ALREADY_CLOSED",
                close_incident_record(
                    &pool,
                    caller(user),
                    closed.id,
                    close_request(closed.revision, "closing it a second time"),
                )
                .await
                .unwrap_err(),
            ),
        ] {
            assert_eq!(error.code, code, "unexpected refusal: {}", error.message);
        }

        // A handover of a closed record is refused too: ownership of history is not
        // live work, and reassigning it would rewrite who was accountable.
        let error = transfer_incident_owner(
            &pool,
            caller(user),
            closed.id,
            transfer_request(closed.revision, other, "handing over a closed record"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_CLOSED");

        // No reopening, not even by hand: the schema refuses the status move.
        let reopened =
            sqlx::query("UPDATE kernel.incidents SET status='INVESTIGATING' WHERE incident_id=$1")
                .bind(closed.id)
                .execute(&pool)
                .await;
        let message = reopened
            .expect_err("a closed incident must not return to another status")
            .to_string();
        assert!(
            message.contains("cannot return to"),
            "unexpected database refusal: {message}"
        );

        // The worst case the rule names: delete the verdict, then try to reopen. The
        // verdict is gone (no endpoint can do this; a table owner just did), and the
        // incident is STILL closed. 0025 refuses the delete too, so the test says
        // explicitly that it is acting as a table owner who switched the lock off -
        // which is the premise, not the thing under test.
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL kernel.allow_verdict_removal = 'on'")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DELETE FROM kernel.incident_verdicts WHERE incident_id=$1")
            .bind(closed.id)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let reopened =
            sqlx::query("UPDATE kernel.incidents SET status='CONCLUDED' WHERE incident_id=$1")
                .bind(closed.id)
                .execute(&pool)
                .await;
        let message = reopened
            .expect_err("deleting the verdict must not reopen a closed incident")
            .to_string();
        assert!(
            message.contains("cannot return to"),
            "unexpected database refusal: {message}"
        );
        let status: String =
            sqlx::query_scalar("SELECT status FROM kernel.incidents WHERE incident_id=$1")
                .bind(closed.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "CLOSED");

        cleanup(&pool, &[user, other]).await;
    }
    // -----------------------------------------------------------------------
    // G12 C2 - the ownership handover.
    //
    // The owner column IS the operator read predicate (jobs.rs:1883), so a handover
    // is not a bookkeeping change: it moves who can read and write the incident. Every
    // test below therefore asserts the READ scope as well as the write scope, before
    // and after, for both accounts.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_handover_moves_the_read_and_write_scope_between_the_two_operators() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let old_owner = seed_user(&pool, "operator").await;
        let new_owner = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(old_owner),
            incident_request("shift change", None),
        )
        .await
        .unwrap();
        insert_evidence(
            &pool,
            &no_adapters(),
            caller(old_owner),
            incident.id,
            evidence_request("sha256:old-owner-note"),
        )
        .await
        .unwrap();

        // --- before the handover -------------------------------------------
        // Old owner: reads the record and its trail, and can write.
        let before = query_incident(&pool, caller(old_owner), incident.id)
            .await
            .unwrap();
        assert_eq!(before.owner, old_owner);
        assert!(query_timeline(&pool, caller(old_owner), incident.id, 50)
            .await
            .is_ok());
        // New owner: nothing. Not a 403 - a 404, because the record is not theirs to
        // know about.
        for error in [
            query_incident(&pool, caller(new_owner), incident.id)
                .await
                .unwrap_err(),
            query_timeline(&pool, caller(new_owner), incident.id, 50)
                .await
                .unwrap_err(),
        ] {
            assert_eq!(error.status, StatusCode::NOT_FOUND);
            assert_eq!(error.code, "INCIDENT_NOT_FOUND");
        }
        // ... and their LIST does not contain it, which is the scope that matters when
        // nobody asks for a specific id.
        let listed = query_incidents(&pool, caller(new_owner), IncidentListQuery::default())
            .await
            .unwrap()
            .items;
        assert!(!listed.iter().any(|view| view.id == incident.id));

        // --- the handover ---------------------------------------------------
        let handover = transfer_incident_owner(
            &pool,
            caller(old_owner),
            incident.id,
            transfer_request(
                before.revision,
                new_owner,
                "night shift takes over; the pager is with them",
            ),
        )
        .await
        .unwrap();
        assert_eq!(handover.previous_owner, old_owner);
        assert_eq!(handover.owner, new_owner);
        assert_eq!(handover.transferred_by, old_owner);
        assert_eq!(handover.transferred_at, handover.owner_assigned_at);
        assert_eq!(
            handover.revision,
            before.revision + 1,
            "a handover is a change to the record"
        );
        assert_eq!(
            handover.reason,
            "night shift takes over; the pager is with them"
        );
        assert_eq!(
            audit_rows(&pool, incident.id, "INCIDENT_OWNER_TRANSFERRED").await,
            1
        );

        // --- after the handover --------------------------------------------
        // Old owner: loses both scopes, with the same 404 as any other stranger.
        let error = query_incident(&pool, caller(old_owner), incident.id)
            .await
            .unwrap_err();
        assert_eq!(error.code, "INCIDENT_NOT_FOUND");
        assert_eq!(
            insert_evidence(
                &pool,
                &no_adapters(),
                caller(old_owner),
                incident.id,
                evidence_request("sha256:old-owner-after"),
            )
            .await
            .unwrap_err()
            .code,
            "INCIDENT_NOT_FOUND"
        );
        // New owner: reads it, reads the trail, can write, and is the accountable
        // party from now on.
        let after = query_incident(&pool, caller(new_owner), incident.id)
            .await
            .unwrap();
        assert_eq!(after.owner, new_owner);
        assert_eq!(after.owner_assigned_at, handover.owner_assigned_at);
        assert!(
            insert_evidence(
                &pool,
                &no_adapters(),
                caller(new_owner),
                incident.id,
                evidence_request("sha256:new-owner-note"),
            )
            .await
            .unwrap()
            .0
        );
        let trail = query_timeline(&pool, caller(new_owner), incident.id, 50)
            .await
            .unwrap();
        assert!(trail
            .items
            .iter()
            .any(|event| event.event_type == "INCIDENT_OWNER_TRANSFERRED"));
        let listed = query_incidents(&pool, caller(new_owner), IncidentListQuery::default())
            .await
            .unwrap()
            .items;
        assert!(listed.iter().any(|view| view.id == incident.id));

        cleanup(&pool, &[old_owner, new_owner]).await;
    }
    #[tokio::test]
    async fn a_handover_requires_the_current_revision() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let target = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(owner),
            incident_request("stale handover", None),
        )
        .await
        .unwrap();
        // Something moved the record after the caller read it: the evidence append
        // bumps the revision, exactly as a concurrent reader would see.
        insert_evidence(
            &pool,
            &no_adapters(),
            caller(owner),
            incident.id,
            evidence_request("sha256:moved"),
        )
        .await
        .unwrap();

        let error = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(
                incident.revision,
                target,
                "handing over on a version I no longer hold",
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "INCIDENT_VERSION_CONFLICT");

        // The owner did not move, and no handover was recorded.
        let unchanged = query_incident(&pool, caller(owner), incident.id)
            .await
            .unwrap();
        assert_eq!(unchanged.owner, owner);
        assert_eq!(
            audit_rows(&pool, incident.id, "INCIDENT_OWNER_TRANSFERRED").await,
            0
        );

        // Re-reading fixes it: the retry with the current revision succeeds.
        let handover = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(
                unchanged.revision,
                target,
                "retried against the revision I just read",
            ),
        )
        .await
        .unwrap();
        assert_eq!(handover.owner, target);

        cleanup(&pool, &[owner, target]).await;
    }
    #[tokio::test]
    async fn a_handover_refuses_an_ineligible_target_and_a_no_op() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let viewer = seed_user(&pool, "viewer").await;
        let retired = seed_user(&pool, "operator").await;
        sqlx::query("UPDATE kernel.users SET disabled=true WHERE id=$1")
            .bind(retired)
            .execute(&pool)
            .await
            .unwrap();
        let (_, incident) = insert_incident(
            &pool,
            caller(owner),
            incident_request("target checks", None),
        )
        .await
        .unwrap();
        let revision = incident.revision;

        // A viewer reads every incident, so naming one as owner would give the handover
        // no accountable party: nobody could act on the work.
        let error = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(revision, viewer, "handing it to someone who cannot act"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_OWNER_ROLE_INELIGIBLE");

        // A disabled account cannot pick work up.
        let error = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(revision, retired, "handing it to a disabled account"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_OWNER_DISABLED");

        // An id that is not an account.
        let error = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(revision, Uuid::new_v4(), "handing it to nobody at all"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_OWNER_UNKNOWN");

        // A handover to the account that already owns it records nothing.
        let error = transfer_incident_owner(
            &pool,
            caller(owner),
            incident.id,
            transfer_request(revision, owner, "handing it to the account that has it"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_OWNER_UNCHANGED");

        // None of the four refusals changed the record.
        let unchanged = query_incident(&pool, caller(owner), incident.id)
            .await
            .unwrap();
        assert_eq!(unchanged.owner, owner);
        assert_eq!(unchanged.revision, revision);
        assert_eq!(
            audit_rows(&pool, incident.id, "INCIDENT_OWNER_TRANSFERRED").await,
            0
        );

        cleanup(&pool, &[owner, viewer, retired]).await;
    }
    /// Who may close or hand over: the current owner, or a role that sees every
    /// incident. The stranger's refusal is a 404 and not a 403, because the record is
    /// not theirs to know about.
    #[tokio::test]
    async fn only_the_owner_or_a_role_that_sees_everything_may_close_or_hand_over() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let stranger = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;
        let concluded = concluded_incident(&pool, owner, "scope of authority").await;

        let error = close_incident_record(
            &pool,
            caller(stranger),
            concluded.id,
            close_request(concluded.revision, "closing someone else's incident"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.code, "INCIDENT_NOT_FOUND");

        let error = transfer_incident_owner(
            &pool,
            caller(stranger),
            concluded.id,
            transfer_request(
                concluded.revision,
                stranger,
                "taking an incident I cannot see",
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_NOT_FOUND");

        // An admin may do both, because sees_all is the same predicate that lets it
        // read the record in the first place.
        let handover = transfer_incident_owner(
            &pool,
            admin_caller(admin),
            concluded.id,
            transfer_request(
                concluded.revision,
                stranger,
                "reassigning to the operator who is actually on call",
            ),
        )
        .await
        .unwrap();
        assert_eq!(handover.owner, stranger);
        let moved = query_incident(&pool, caller(stranger), concluded.id)
            .await
            .unwrap();
        let closed = close_incident_record(
            &pool,
            admin_caller(admin),
            concluded.id,
            close_request(moved.revision, "closed by the incident commander"),
        )
        .await
        .unwrap();
        assert_eq!(closed.status, "CLOSED");
        assert_eq!(
            closed.closed_by,
            Some(admin),
            "the closer of record is the account that closed it, not the owner"
        );
        assert_eq!(closed.owner, stranger, "closing does not move ownership");

        cleanup(&pool, &[owner, stranger, admin]).await;
    }
    /// The trail is the incident's, not the platform's.
    #[tokio::test]
    async fn the_timeline_is_scoped_like_the_incident_and_read_in_order() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let stranger = seed_user(&pool, "operator").await;
        let closed = closed_incident(&pool, owner, "trail order").await;

        let trail = query_timeline(&pool, caller(owner), closed.id, 50)
            .await
            .unwrap();
        assert!(!trail.truncated);
        let kinds: Vec<&str> = trail
            .items
            .iter()
            .map(|event| event.event_type.as_str())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "INCIDENT_CREATED",
                "INCIDENT_EVIDENCE_ADDED",
                "INCIDENT_VERDICT_RECORDED",
                "INCIDENT_CLOSED",
            ],
            "the trail must be the writes that happened, in the order they happened"
        );
        assert!(trail
            .items
            .windows(2)
            .all(|pair| pair[0].occurred_at <= pair[1].occurred_at));
        // The closure event carries the reason, so the trail answers why and not only
        // when.
        let closure = trail.items.last().unwrap();
        assert_eq!(
            closure
                .details
                .get("closureNote")
                .and_then(|value| value.as_str()),
            Some("resolved: the node came back")
        );
        assert_eq!(
            closure.actor_id,
            owner.to_string(),
            "the trail names the account that closed it"
        );

        // A bounded page is the NEWEST events, in order, and says it is truncated.
        let page = query_timeline(&pool, caller(owner), closed.id, 2)
            .await
            .unwrap();
        assert!(page.truncated);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[1].event_type, "INCIDENT_CLOSED");
        assert_eq!(page.items[0].event_type, "INCIDENT_VERDICT_RECORDED");

        // Not visible to a stranger, exactly like the record itself.
        let error = query_timeline(&pool, caller(stranger), closed.id, 50)
            .await
            .unwrap_err();
        assert_eq!(error.code, "INCIDENT_NOT_FOUND");

        cleanup(&pool, &[owner, stranger]).await;
    }

    #[tokio::test]
    async fn list_pages_with_a_keyset_cursor_and_rejects_unknown_filters() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        for offset in 0..3 {
            let mut request = incident_request(&format!("paged incident {offset}"), None);
            request.started_at = Utc::now() - chrono::Duration::seconds(offset);
            insert_incident(&pool, caller(user), request).await.unwrap();
        }

        let first_page = query_incidents(
            &pool,
            caller(user),
            IncidentListQuery {
                limit: Some(2),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let page1 = first_page.items;
        assert_eq!(page1.len(), 2);
        let cursor = first_page
            .next_cursor
            .expect("a full page must advertise the next one");

        let second_page = query_incidents(
            &pool,
            caller(user),
            IncidentListQuery {
                limit: Some(2),
                cursor: Some(cursor),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let page2 = second_page.items;
        assert_eq!(page2.len(), 1);
        assert!(second_page.next_cursor.is_none());
        assert!(page1
            .iter()
            .all(|first| page2.iter().all(|second| first.id != second.id)));

        let error = query_incidents(
            &pool,
            caller(user),
            IncidentListQuery {
                status: Some("DONE".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");
        let error = query_incidents(
            &pool,
            caller(user),
            IncidentListQuery {
                cursor: Some("not*base64".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");

        cleanup(&pool, &[user]).await;
    }

    // -- audit, transaction order and create replay ---------------------------

    /// Makes kernel.audit_events reject one actor's rows of one event type, so the
    /// rollback path is exercised by a real constraint failure rather than a mock.
    /// Scoped to a freshly seeded user so concurrent tests keep their audits.
    async fn refuse_audit(pool: &PgPool, event_type: &str, actor: Uuid) -> String {
        let name = format!("g11_audit_probe_{}", Uuid::new_v4().simple());
        sqlx::query(&format!(
            "ALTER TABLE kernel.audit_events ADD CONSTRAINT {name} CHECK (
               NOT (event_type='{event_type}' AND actor_id='{actor}'))"
        ))
        .execute(pool)
        .await
        .unwrap();
        name
    }

    async fn allow_audit(pool: &PgPool, name: &str) {
        sqlx::query(&format!(
            "ALTER TABLE kernel.audit_events DROP CONSTRAINT {name}"
        ))
        .execute(pool)
        .await
        .unwrap();
    }

    async fn audit_rows(pool: &PgPool, incident_id: Uuid, event_type: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM kernel.audit_events WHERE subject_id=$1 AND event_type=$2",
        )
        .bind(incident_id.to_string())
        .bind(event_type)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    /// The defect this replaced: audit written after the commit, so a failed audit
    /// answered 5xx over a verdict the database had already accepted.
    #[tokio::test]
    async fn a_failed_audit_rolls_the_verdict_back() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("oom kills", None))
                .await
                .unwrap();
        insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:oom-log"),
        )
        .await
        .unwrap();

        let probe = refuse_audit(&pool, "INCIDENT_VERDICT_RECORDED", user).await;
        let refused = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await;
        allow_audit(&pool, &probe).await;

        let error = refused.unwrap_err();
        assert_eq!(error.code, "AUDIT_WRITE_FAILED");
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            error.retryable,
            "nothing was persisted, so telling the client to retry is honest"
        );

        let verdicts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_verdicts WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            verdicts, 0,
            "the verdict must not survive the audit that failed to describe it"
        );
        let status: String =
            sqlx::query_scalar("SELECT status FROM kernel.incidents WHERE incident_id=$1")
                .bind(incident.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            status, "INVESTIGATING",
            "the CONCLUDED transition commits with the audit row or not at all"
        );

        let verdict = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap();
        assert_eq!(verdict.verdict, "CONFIRMED");
        assert_eq!(
            audit_rows(&pool, incident.id, "INCIDENT_VERDICT_RECORDED").await,
            1
        );

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn a_failed_audit_rolls_the_incident_back_and_frees_the_natural_key() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let native_id = format!("native-audit-{}", Uuid::new_v4().simple());

        let probe = refuse_audit(&pool, "INCIDENT_CREATED", user).await;
        let refused = insert_incident(
            &pool,
            caller(user),
            incident_request("header flipped", Some(&native_id)),
        )
        .await;
        allow_audit(&pool, &probe).await;

        let error = refused.unwrap_err();
        assert_eq!(error.code, "AUDIT_WRITE_FAILED");

        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM kernel.incidents WHERE owner=$1")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 0, "a rolled-back create leaves no incident behind");

        // Rolled back means the natural key is free: had the row committed without
        // its audit row, this retry would be answered as a replay of a write the
        // caller was told had failed.
        let (created, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("header flipped", Some(&native_id)),
        )
        .await
        .unwrap();
        assert!(created);
        assert_eq!(audit_rows(&pool, incident.id, "INCIDENT_CREATED").await, 1);

        cleanup(&pool, &[user]).await;
    }

    #[tokio::test]
    async fn a_failed_audit_rolls_the_evidence_and_the_state_change_back() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("first evidence", None),
        )
        .await
        .unwrap();

        let probe = refuse_audit(&pool, "INCIDENT_EVIDENCE_ADDED", user).await;
        let refused = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:first"),
        )
        .await;
        allow_audit(&pool, &probe).await;

        assert_eq!(refused.unwrap_err().code, "AUDIT_WRITE_FAILED");
        let evidence: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(evidence, 0, "evidence and its audit row commit together");
        let status: String =
            sqlx::query_scalar("SELECT status FROM kernel.incidents WHERE incident_id=$1")
                .bind(incident.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            status, "OPEN",
            "a rejected evidence write must not leave the incident INVESTIGATING"
        );

        cleanup(&pool, &[user]).await;
    }

    /// A POST create answered 404 for a natural key another operator owns: the
    /// status claimed the failure did not exist while refusing to create it.
    #[tokio::test]
    async fn a_native_key_owned_by_another_operator_answers_409_not_404() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let operator_a = seed_user(&pool, "operator").await;
        let operator_b = seed_user(&pool, "operator").await;
        let admin = seed_user(&pool, "admin").await;
        let native_id = format!("native-taken-{}", Uuid::new_v4().simple());

        let (_, first) = insert_incident(
            &pool,
            caller(operator_a),
            incident_request("disk full on web-01", Some(&native_id)),
        )
        .await
        .unwrap();

        let error = insert_incident(
            &pool,
            caller(operator_b),
            incident_request("disk full on web-01", Some(&native_id)),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_NATIVE_ID_TAKEN");
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert!(
            !error.message.contains(&first.id.to_string()),
            "the refusal must not hand another operator's incident id to the caller"
        );

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incidents WHERE source='API' AND native_id=$1",
        )
        .bind(&native_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 1, "the refused create must not add a second row");
        let owner: Uuid = sqlx::query_scalar(
            "SELECT owner FROM kernel.incidents WHERE source='API' AND native_id=$1",
        )
        .bind(&native_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(owner, operator_a, "ownership must not move on a replay");

        // An admin can read that row, so the same request stays a documented replay.
        let (created, seen) = insert_incident(
            &pool,
            admin_caller(admin),
            incident_request("disk full on web-01", Some(&native_id)),
        )
        .await
        .unwrap();
        assert!(!created);
        assert_eq!(seen.id, first.id);

        cleanup(&pool, &[operator_a, operator_b, admin]).await;
    }

    // -----------------------------------------------------------------------
    // G12 A1 - the negative tests. Every test below asserts both the refusal AND
    // that nothing was written: a rejection that still stores the row is the same
    // defect wearing a different status code.
    // -----------------------------------------------------------------------

    /// The pre-0017 request field. Refused as a field, not reinterpreted as a
    /// claim: a client that still sends it must learn the field moved, because
    /// until this release its value was what granted attestation.
    #[tokio::test]
    async fn a_body_trust_field_is_refused_and_writes_nothing() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("body trust", None))
                .await
                .unwrap();

        for requested in ["SOURCE_ATTESTED", "OPERATOR_ASSERTED", "UNVERIFIED"] {
            let mut payload = evidence_request("sha256:body-trust");
            payload.trust = Some(requested.to_string());
            let error = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, payload)
                .await
                .unwrap_err();
            assert_eq!(
                error.code, "EVIDENCE_TRUST_NOT_SELF_ASSERTABLE",
                "trust={requested} must be refused as a request field"
            );
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0, "a refused evidence write must not store a row");

        cleanup(&pool, &[user]).await;
    }

    /// The new field is a claim, and the claim set excludes the one value that
    /// means "the Kernel checked".
    #[tokio::test]
    async fn a_caller_cannot_claim_attested_trust() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("claim attested", None),
        )
        .await
        .unwrap();

        let mut payload = evidence_request("sha256:claim-attested");
        payload.claimed_trust = Some("source_attested".to_string());
        let error = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, payload)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_TRUST_NOT_SELF_ASSERTABLE");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);

        let mut payload = evidence_request("sha256:claim-bogus");
        payload.claimed_trust = Some("AI_INFERENCE".to_string());
        let error = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, payload)
            .await
            .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0);

        cleanup(&pool, &[user]).await;
    }

    /// What an operator's own submission actually earns: the Kernel verified the
    /// identity of the operator, and nothing more.
    #[tokio::test]
    async fn an_operator_submission_is_verified_as_operator_identity_only() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("operator only", None))
                .await
                .unwrap();

        let (created, row) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:operator-row"),
        )
        .await
        .unwrap();
        assert!(created);
        assert_eq!(row.claimed_trust, "OPERATOR_ASSERTED");
        assert_eq!(row.verified_trust, "OPERATOR_ASSERTED");
        assert_eq!(row.verification_method, "OPERATOR_IDENTITY");
        assert!(row.verified_at.is_some(), "an operator verdict is dated");
        assert_eq!(
            row.verifier_identity, None,
            "no adapter vouched, so no adapter identity is claimed"
        );
        assert_eq!(row.submitted_by, Some(user));
        assert_eq!(row.verification_note, None);
        assert!(!row.after_verdict);

        let mut payload = evidence_request("sha256:self-declared");
        payload.claimed_trust = Some("UNVERIFIED".to_string());
        let (_, row) = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, payload)
            .await
            .unwrap();
        assert_eq!(row.claimed_trust, "UNVERIFIED");
        assert_eq!(row.verified_trust, "UNVERIFIED");
        assert_eq!(row.verification_method, "NONE");
        assert_eq!(row.verified_at, None);

        cleanup(&pool, &[user]).await;
    }

    /// The positive path: a configured adapter's signature is the only thing that
    /// produces SOURCE_ATTESTED, and it records who vouched and how.
    #[tokio::test]
    async fn a_valid_adapter_attestation_is_the_only_path_to_attested_trust() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("attested row", None))
                .await
                .unwrap();

        let collected_at = Utc::now();
        let issued_at = Utc::now();
        let body = "{\"outcome\":\"OK\"}";
        let content_ref = format!("sha256:{}", digest_of(body.as_bytes()));
        let bound = tuple(
            incident.id,
            "METRIC_SNAPSHOT",
            "zabbix",
            &content_ref,
            collected_at,
        );
        let mut payload = attested_request(&bound, ADAPTER_ID, ADAPTER_SECRET, issued_at);
        // Since G13-A an attestation must point at bytes the Kernel will store
        // and re-digest; the reference alone is no longer enough.
        payload.content_ref = Some(content_ref.clone());
        payload.content = Some(EvidenceContentRequest {
            content_type: "application/json".to_string(),
            body: body.to_string(),
        });
        let (created, row) =
            insert_evidence(&pool, &adapters(), caller(user), incident.id, payload)
                .await
                .unwrap();
        assert!(created);
        assert_eq!(row.verified_trust, "SOURCE_ATTESTED");
        assert_eq!(row.verification_method, "SOURCE_ADAPTER");
        assert_eq!(row.verifier_identity.as_deref(), Some(ADAPTER_ID));
        assert!(row.verified_at.is_some());
        assert_eq!(row.submitted_by, Some(user));
        // The claim is not silently upgraded to match the verdict: they answer
        // different questions and are stored separately.
        assert_eq!(row.claimed_trust, "OPERATOR_ASSERTED");

        cleanup(&pool, &[user]).await;
    }

    /// G13-A: the plugin's exact bytes and its signature meet in one write.
    ///
    /// The signature covers a `contentRef`; the Kernel derives that ref from the
    /// bytes it is about to store and refuses a mismatch. This test proves the
    /// three facts line up in one transaction - the signature verifies, the
    /// stored bytes are byte-identical, and a ref that does not describe those
    /// bytes writes nothing.
    #[tokio::test]
    async fn a_plugin_signed_snapshot_is_stored_byte_for_byte_and_attested() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("signed snapshot", None),
        )
        .await
        .unwrap();

        // Multi-byte content and a non-trivial key order: the digest is over the
        // bytes, not over a re-serialized object.
        let body = r#"{"outcome":"OK","observedAt":"2026-11-01T03:00:00Z","requestedItems":1,"series":[{"itemId":"10401","samples":[{"occurredAt":"2026-11-01T02:30:00Z","value":17.5}],"unit":"%"}]}"#;
        let digest = digest_of(body.as_bytes());
        let content_ref = format!("sha256:{digest}");
        let collected_at = Utc::now();
        let issued_at = Utc::now();

        let mut payload = content_request("application/json", body);
        payload.content_ref = Some(content_ref.clone());
        payload.source = "zabbix:source-1".to_string();
        payload.collected_at = collected_at;
        let bound = tuple(
            incident.id,
            "METRIC_SNAPSHOT",
            "zabbix:source-1",
            &content_ref,
            collected_at,
        );
        payload.attestation =
            attested_request(&bound, ADAPTER_ID, ADAPTER_SECRET, issued_at).attestation;

        let (created, row) =
            insert_evidence(&pool, &adapters(), caller(user), incident.id, payload)
                .await
                .unwrap();
        assert!(created);
        assert_eq!(row.verified_trust, "SOURCE_ATTESTED");
        assert_eq!(row.verification_method, "SOURCE_ADAPTER");
        assert_eq!(row.content_ref, content_ref);
        assert_eq!(row.content_status, "STORED");

        let (stored, stored_digest, stored_bytes): (Vec<u8>, String, i32) = sqlx::query_as(
            "SELECT body, sha256, content_bytes FROM kernel.incident_evidence_content WHERE evidence_id=$1",
        )
        .bind(row.evidence_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            stored,
            body.as_bytes(),
            "the Kernel stored exactly the submitted bytes"
        );
        assert_eq!(stored_digest, digest);
        assert_eq!(stored_bytes, body.len() as i32);

        // The same bytes with a ref that does not describe them: the signature
        // can verify (it signs that wrong ref) and the write still must fail,
        // because the digest check is independent of the signature.
        let mut mismatched = content_request("application/json", body);
        let wrong_ref = format!("sha256:{}", "0".repeat(64));
        mismatched.content_ref = Some(wrong_ref.clone());
        mismatched.source = "zabbix:source-1".to_string();
        mismatched.collected_at = collected_at;
        let wrong_bound = tuple(
            incident.id,
            "METRIC_SNAPSHOT",
            "zabbix:source-1",
            &wrong_ref,
            collected_at,
        );
        mismatched.attestation =
            attested_request(&wrong_bound, ADAPTER_ID, ADAPTER_SECRET, issued_at).attestation;
        let error = insert_evidence(&pool, &adapters(), caller(user), incident.id, mismatched)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_REF_CONFLICT");
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1, "a refused write leaves no second row");

        cleanup(&pool, &[user]).await;
    }

    /// An attestation with no bytes has nothing for the Kernel to digest, so it
    /// is refused even though the signature itself is valid.
    #[tokio::test]
    async fn an_attestation_without_content_is_refused() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("attested without bytes", None),
        )
        .await
        .unwrap();
        let collected_at = Utc::now();
        let issued_at = Utc::now();
        let payload = attested_request(
            &tuple(
                incident.id,
                "METRIC_SNAPSHOT",
                "zabbix",
                "sha256:no-bytes",
                collected_at,
            ),
            ADAPTER_ID,
            ADAPTER_SECRET,
            issued_at,
        );
        let error = insert_evidence(&pool, &adapters(), caller(user), incident.id, payload)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ATTESTATION_REQUIRES_CONTENT");
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "a refused attestation writes nothing");
        cleanup(&pool, &[user]).await;
    }

    /// G13-A.1: a v2 envelope signed for workspace B cannot be filed on an
    /// incident in workspace A, even by a caller who belongs to both.
    #[tokio::test]
    async fn an_attestation_signed_for_another_workspace_is_refused() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("workspace mismatch", None),
        )
        .await
        .unwrap();
        let body = "{}";
        let content_ref = format!("sha256:{}", digest_of(body.as_bytes()));
        let collected_at = Utc::now();
        let issued_at = Utc::now();
        let other_workspace = Uuid::new_v4();
        let signed = EvidenceTuple {
            workspace_id: other_workspace,
            ..tuple(
                incident.id,
                "METRIC_SNAPSHOT",
                "zabbix:source-b",
                &content_ref,
                collected_at,
            )
        };
        let payload = attestation_payload(ADAPTER_ID, &signed, issued_at).unwrap();
        let mut mac = HmacSha256::new_from_slice(ADAPTER_SECRET.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        use base64::Engine;
        let signature =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

        let mut request = content_request("application/json", body);
        request.content_ref = Some(content_ref.clone());
        request.source = "zabbix:source-b".to_string();
        request.collected_at = collected_at;
        request.attestation = Some(AttestationRequest {
            adapter_id: ADAPTER_ID.to_string(),
            workspace_id: Some(other_workspace),
            issued_at,
            signature,
        });
        let error = insert_evidence(&pool, &adapters(), caller(user), incident.id, request)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_WORKSPACE_MISMATCH");
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "a cross-workspace write leaves no row");
        cleanup(&pool, &[user]).await;
    }

    /// The workspace field is inside the signature: changing it after signing
    /// must fail verification, not be compared as a claim.
    #[tokio::test]
    async fn a_tampered_workspace_field_is_refused() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("tampered workspace", None),
        )
        .await
        .unwrap();
        let body = "{}";
        let content_ref = format!("sha256:{}", digest_of(body.as_bytes()));
        let collected_at = Utc::now();
        let issued_at = Utc::now();
        let bound = tuple(
            incident.id,
            "METRIC_SNAPSHOT",
            "zabbix:source-a",
            &content_ref,
            collected_at,
        );
        let payload = attestation_payload(ADAPTER_ID, &bound, issued_at).unwrap();
        let mut mac = HmacSha256::new_from_slice(ADAPTER_SECRET.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        use base64::Engine;
        let signature =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

        // Positive control: the same tuple with the signed workspace is
        // accepted, so the refusal below is about the tamper, not a verifier
        // that rejects everything.
        let mut valid = content_request("application/json", body);
        valid.content_ref = Some(content_ref.clone());
        valid.source = "zabbix:source-a".to_string();
        valid.collected_at = collected_at;
        valid.attestation = Some(AttestationRequest {
            adapter_id: ADAPTER_ID.to_string(),
            workspace_id: Some(scope::legacy_workspace()),
            issued_at,
            signature: signature.clone(),
        });
        let (created, row) = insert_evidence(&pool, &adapters(), caller(user), incident.id, valid)
            .await
            .unwrap();
        assert!(created);
        assert_eq!(row.verified_trust, "SOURCE_ATTESTED");

        let mut request = content_request("application/json", body);
        request.content_ref = Some(content_ref.clone());
        request.source = "zabbix:source-a".to_string();
        request.collected_at = collected_at;
        request.attestation = Some(AttestationRequest {
            adapter_id: ADAPTER_ID.to_string(),
            // Signed for the incident's workspace, then moved to another.
            workspace_id: Some(Uuid::new_v4()),
            issued_at,
            signature,
        });
        let error = insert_evidence(&pool, &adapters(), caller(user), incident.id, request)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ATTESTATION_INVALID");
        cleanup(&pool, &[user]).await;
    }

    /// Signing one incident's tuple cannot be replayed onto another incident.
    #[tokio::test]
    async fn an_attestation_for_another_incident_is_refused() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, first) = insert_incident(
            &pool,
            caller(user),
            incident_request("signed incident", None),
        )
        .await
        .unwrap();
        let (_, second) = insert_incident(
            &pool,
            caller(user),
            incident_request("target incident", None),
        )
        .await
        .unwrap();
        let body = "{}";
        let content_ref = format!("sha256:{}", digest_of(body.as_bytes()));
        let collected_at = Utc::now();
        let issued_at = Utc::now();
        let bound = tuple(
            first.id,
            "METRIC_SNAPSHOT",
            "zabbix:source-a",
            &content_ref,
            collected_at,
        );
        let payload = attestation_payload(ADAPTER_ID, &bound, issued_at).unwrap();
        let mut mac = HmacSha256::new_from_slice(ADAPTER_SECRET.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        use base64::Engine;
        let signature =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

        // Positive control: the envelope is accepted on the incident it was
        // signed for.
        let mut valid = content_request("application/json", body);
        valid.content_ref = Some(content_ref.clone());
        valid.source = "zabbix:source-a".to_string();
        valid.collected_at = collected_at;
        valid.attestation = Some(AttestationRequest {
            adapter_id: ADAPTER_ID.to_string(),
            workspace_id: Some(scope::legacy_workspace()),
            issued_at,
            signature: signature.clone(),
        });
        let (created, row) = insert_evidence(&pool, &adapters(), caller(user), first.id, valid)
            .await
            .unwrap();
        assert!(created);
        assert_eq!(row.verified_trust, "SOURCE_ATTESTED");

        let mut request = content_request("application/json", body);
        request.content_ref = Some(content_ref.clone());
        request.source = "zabbix:source-a".to_string();
        request.collected_at = collected_at;
        request.attestation = Some(AttestationRequest {
            adapter_id: ADAPTER_ID.to_string(),
            workspace_id: Some(scope::legacy_workspace()),
            issued_at,
            signature,
        });
        let error = insert_evidence(&pool, &adapters(), caller(user), second.id, request)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ATTESTATION_INVALID");
        cleanup(&pool, &[user]).await;
    }

    /// A valid v1 signature is recognised but cannot authorize a new write.
    #[tokio::test]
    async fn a_v1_attestation_is_refused_for_new_evidence() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("v1 envelope", None))
                .await
                .unwrap();
        let body = "{}";
        let content_ref = format!("sha256:{}", digest_of(body.as_bytes()));
        let collected_at = Utc::now();
        let issued_at = Utc::now();
        let bound = tuple(
            incident.id,
            "METRIC_SNAPSHOT",
            "zabbix:source-a",
            &content_ref,
            collected_at,
        );
        let payload = attestation_payload_v1(ADAPTER_ID, &bound, issued_at).unwrap();
        let mut mac = HmacSha256::new_from_slice(ADAPTER_SECRET.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        use base64::Engine;
        let signature =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

        let mut request = content_request("application/json", body);
        request.content_ref = Some(content_ref.clone());
        request.source = "zabbix:source-a".to_string();
        request.collected_at = collected_at;
        request.attestation = Some(AttestationRequest {
            adapter_id: ADAPTER_ID.to_string(),
            workspace_id: None,
            issued_at,
            signature,
        });
        let error = insert_evidence(&pool, &adapters(), caller(user), incident.id, request)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ATTESTATION_VERSION_UNSUPPORTED");
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "a v1 envelope writes nothing");
        cleanup(&pool, &[user]).await;
    }

    /// Four ways an attestation can be wrong. All four are refused, none of them
    /// degrades to UNVERIFIED: an unverifiable attestation is an attempt to claim
    /// provenance, and storing it as an ordinary row would bury it.
    #[tokio::test]
    async fn forged_and_stale_attestations_are_refused_and_write_nothing() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("forged attempt", None),
        )
        .await
        .unwrap();

        let collected_at = Utc::now();
        let issued_at = Utc::now();
        let build =
            |content_ref: &str, adapter_id: &str, secret: &str, issued_at: DateTime<Utc>| {
                attested_request(
                    &tuple(
                        incident.id,
                        "METRIC_SNAPSHOT",
                        "prometheus",
                        content_ref,
                        collected_at,
                    ),
                    adapter_id,
                    secret,
                    issued_at,
                )
            };

        // (a) right adapter, wrong secret.
        let error = insert_evidence(
            &pool,
            &adapters(),
            caller(user),
            incident.id,
            build(
                "sha256:forged-signature",
                ADAPTER_ID,
                "not-the-secret",
                issued_at,
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ATTESTATION_INVALID");
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);

        // (b) an adapter the Kernel does not know.
        let error = insert_evidence(
            &pool,
            &adapters(),
            caller(user),
            incident.id,
            build(
                "sha256:unknown-adapter",
                "zabbix-impostor",
                ADAPTER_SECRET,
                issued_at,
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ADAPTER_UNKNOWN");
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);

        // (c) a genuine signature over a different tuple, replayed onto this one:
        // the signature binds contentRef, so moving it invalidates the proof.
        let mut moved = build("sha256:original-ref", ADAPTER_ID, ADAPTER_SECRET, issued_at);
        moved.content_ref = Some("sha256:moved-ref".to_string());
        let error = insert_evidence(&pool, &adapters(), caller(user), incident.id, moved)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ATTESTATION_INVALID");

        // (d) a genuine signature captured and replayed later.
        let stale_at = Utc::now() - chrono::Duration::seconds(ATTESTATION_MAX_SKEW_SECONDS + 60);
        let error = insert_evidence(
            &pool,
            &adapters(),
            caller(user),
            incident.id,
            build("sha256:stale", ADAPTER_ID, ADAPTER_SECRET, stale_at),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ATTESTATION_STALE");

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0, "not one of the four attempts may leave a row");

        // And with no adapter configured at all, even a correct-looking
        // attestation proves nothing.
        let error = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            build("sha256:no-adapters", ADAPTER_ID, ADAPTER_SECRET, issued_at),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_ADAPTER_UNKNOWN");

        cleanup(&pool, &[user]).await;
    }

    /// A replay answers with the stored row, so it cannot be used to upgrade a
    /// settled UNVERIFIED/OPERATOR_ASSERTED row into an attested one.
    #[tokio::test]
    async fn a_replay_cannot_upgrade_a_settled_trust() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("replay upgrade", None),
        )
        .await
        .unwrap();

        let (created, first) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("application/json", "{}"),
        )
        .await
        .unwrap();
        assert!(created);
        assert_eq!(first.verified_trust, "OPERATOR_ASSERTED");

        let issued_at = Utc::now();
        let mut upgrade = attested_request(
            &tuple(
                incident.id,
                "METRIC_SNAPSHOT",
                "prometheus",
                &first.content_ref,
                first.collected_at,
            ),
            ADAPTER_ID,
            ADAPTER_SECRET,
            issued_at,
        );
        // The replay carries the same bytes, so the tuple is identical and the
        // attestation has content for the Kernel to verify.
        upgrade.content_ref = Some(first.content_ref.clone());
        upgrade.content = Some(EvidenceContentRequest {
            content_type: "application/json".to_string(),
            body: "{}".to_string(),
        });
        let (created_again, second) =
            insert_evidence(&pool, &adapters(), caller(user), incident.id, upgrade)
                .await
                .unwrap();
        assert!(!created_again, "the identical tuple is one row, not two");
        assert_eq!(second.evidence_id, first.evidence_id);
        assert_eq!(
            second.verified_trust, "OPERATOR_ASSERTED",
            "a replay must not raise the trust of the row it answers with"
        );
        assert_eq!(second.verification_method, "OPERATOR_IDENTITY");

        cleanup(&pool, &[user]).await;
    }

    /// HTTP-level role matrix. The handler gate is the authority, so this drives
    /// the real axum handler with a real AuthUser per role instead of trusting
    /// that require_operator() is called.
    #[tokio::test]
    async fn viewer_is_refused_at_the_handler_and_operator_and_admin_are_not() {
        use axum::body::Body;
        use axum::http::Request;
        use axum::routing::post;
        use tower::ServiceExt;

        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let viewer = seed_user(&pool, "viewer").await;
        let admin = seed_user(&pool, "admin").await;
        let (_, incident) =
            insert_incident(&pool, caller(owner), incident_request("role matrix", None))
                .await
                .unwrap();

        let state = AppState::new(
            crate::config::Config::from_env(),
            pool.clone(),
            vec![7_u8; 32],
        )
        .expect("test AppState");

        async fn post_as(
            state: AppState,
            user: AuthUser,
            incident_id: Uuid,
            ref_name: &str,
        ) -> (StatusCode, String) {
            use axum::middleware;
            let router = axum::Router::new()
                .route(
                    "/api/v1/incidents/{incident_id}/evidence",
                    post(append_evidence),
                )
                .layer(middleware::from_fn(
                    move |mut request: axum::extract::Request, next: middleware::Next| {
                        let user = user.clone();
                        async move {
                            request.extensions_mut().insert(user);
                            next.run(request).await
                        }
                    },
                ))
                .with_state(state);
            let body = serde_json::json!({
                "kind": "OPERATOR_NOTE",
                "source": "operator:role-matrix",
                "collectedAt": Utc::now().to_rfc3339(),
                "contentRef": ref_name,
            })
            .to_string();
            let response = router
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/api/v1/incidents/{incident_id}/evidence"))
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
                .await
                .unwrap();
            (status, String::from_utf8_lossy(&bytes).to_string())
        }

        let as_role = |role: Role, id: Uuid| AuthUser {
            user_id: id,
            email: format!("{id}@example.invalid"),
            display_name: "role matrix".to_string(),
            role,
            session_id: Uuid::new_v4(),
            csrf_token: "csrf".to_string(),
            via_cookie: true,
        };

        let (status, body) = post_as(
            state.clone(),
            as_role(Role::Viewer, viewer),
            incident.id,
            "note:viewer",
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body was {body}");
        assert!(body.contains("FORBIDDEN"));

        let (status, body) = post_as(
            state.clone(),
            as_role(Role::Operator, owner),
            incident.id,
            "note:operator",
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "body was {body}");
        assert!(
            body.contains("\"verifiedTrust\":\"OPERATOR_ASSERTED\""),
            "body was {body}"
        );

        let (status, body) = post_as(
            state.clone(),
            as_role(Role::Admin, admin),
            incident.id,
            "note:admin",
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "body was {body}");

        // Not one of the three writes produced attestation, whatever the role.
        let attested: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence
              WHERE incident_id=$1 AND (verified_trust='SOURCE_ATTESTED'
                 OR claimed_trust='SOURCE_ATTESTED')",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(attested, 0);

        cleanup(&pool, &[owner, viewer, admin]).await;
    }
    /// The server-side 403 the read-only UI note is NOT allowed to replace.
    ///
    /// The browser explains, before submission, that a viewer cannot close or hand
    /// over; that explanation is presentation. This test drives the real axum
    /// handlers with a real viewer AuthUser and proves the kernel refuses the write
    /// whatever the form did or did not show.
    #[tokio::test]
    async fn viewer_is_refused_at_the_handler_for_close_and_handover() {
        use axum::body::Body;
        use axum::http::Request;
        use axum::routing::post;
        use tower::ServiceExt;

        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let viewer = seed_user(&pool, "viewer").await;
        let concluded = concluded_incident(&pool, owner, "read only viewer").await;

        let state = AppState::new(
            crate::config::Config::from_env(),
            pool.clone(),
            vec![9_u8; 32],
        )
        .expect("test AppState");

        let as_role = |role: Role, id: Uuid| AuthUser {
            user_id: id,
            email: format!("{id}@example.invalid"),
            display_name: "role matrix c".to_string(),
            role,
            session_id: Uuid::new_v4(),
            csrf_token: "csrf".to_string(),
            via_cookie: true,
        };

        let send = |user: AuthUser, path: String, body: String| {
            let state = state.clone();
            async move {
                use axum::middleware;
                let router = axum::Router::new()
                    .route(
                        "/api/v1/incidents/{incident_id}/close",
                        post(close_incident),
                    )
                    .route(
                        "/api/v1/incidents/{incident_id}/owner",
                        post(transfer_owner),
                    )
                    .layer(middleware::from_fn(
                        move |mut request: axum::extract::Request, next: middleware::Next| {
                            let user = user.clone();
                            async move {
                                request.extensions_mut().insert(user);
                                next.run(request).await
                            }
                        },
                    ))
                    .with_state(state);
                let response = router
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(path)
                            .header("content-type", "application/json")
                            .body(Body::from(body))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                let status = response.status();
                let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
                    .await
                    .unwrap();
                (status, String::from_utf8_lossy(&bytes).to_string())
            }
        };

        let close_body = serde_json::json!({
            "expectedRevision": concluded.revision,
            "note": "a viewer trying to close an incident",
            "idempotencyKey": "viewer-close-1",
        })
        .to_string();
        let (status, body) = send(
            as_role(Role::Viewer, viewer),
            format!("/api/v1/incidents/{}/close", concluded.id),
            close_body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body was {body}");
        assert!(body.contains("FORBIDDEN"), "body was {body}");

        let transfer_body = serde_json::json!({
            "expectedRevision": concluded.revision,
            "toOwner": viewer,
            "reason": "a viewer trying to take an incident",
        })
        .to_string();
        let (status, body) = send(
            as_role(Role::Viewer, viewer),
            format!("/api/v1/incidents/{}/owner", concluded.id),
            transfer_body,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body was {body}");

        // Neither refusal wrote anything: the incident is still CONCLUDED, still
        // owned by the operator, and the viewer closed nothing.
        let untouched = query_incident(&pool, caller(owner), concluded.id)
            .await
            .unwrap();
        assert_eq!(untouched.status, "CONCLUDED");
        assert_eq!(untouched.owner, owner);
        assert_eq!(audit_rows(&pool, concluded.id, "INCIDENT_CLOSED").await, 0);

        cleanup(&pool, &[owner, viewer]).await;
    }

    /// One half of the schema's guarantee, stated as what it actually is.
    ///
    /// G12 F: this test used to be called "the database refuses a hand-written
    /// attested row", which claimed far more than it measured. It omits
    /// verification_method and verifier_identity, so what it proves is that a row
    /// cannot CLAIM SOURCE_ATTESTED while saying nothing about how it got there - a
    /// completeness check on the shape of the row. It proves nothing about a writer
    /// who states both, which is the next test.
    #[tokio::test]
    async fn an_attested_row_must_also_state_how_it_was_verified() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(&pool, caller(user), incident_request("db gate", None))
            .await
            .unwrap();

        let direct = sqlx::query(
            "INSERT INTO kernel.incident_evidence
               (evidence_id,incident_id,kind,source,collected_at,content_ref,
                claimed_trust,verified_trust)
             VALUES ($1,$2,'LOG_EXCERPT','syslog',now(),'sha256:hand-written',
                     'SOURCE_ATTESTED','SOURCE_ATTESTED')",
        )
        .bind(Uuid::new_v4())
        .bind(incident.id)
        .execute(&pool)
        .await;
        let error = direct.expect_err("the schema must refuse SOURCE_ATTESTED without an adapter");
        let message = error.to_string();
        assert!(
            message.contains("incident_evidence_attestation_requires_adapter")
                || message.contains("incident_evidence_verification_check"),
            "unexpected database refusal: {message}"
        );

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0);

        cleanup(&pool, &[user]).await;
    }

    /// The other half, and the one migration 0017 got wrong.
    ///
    /// A hand-written INSERT that states the method AND an adapter identity succeeds.
    /// The schema checks the shape of the claim; it cannot check that the writer ever
    /// held that adapter's secret, because a CHECK cannot see a signature. Migration
    /// 0021 corrects the comment on the constraint and this test is the regression lock
    /// for that correction: if a later change makes the schema refuse this, the comment
    /// must be corrected in the same change instead of the guarantee being reassumed.
    #[tokio::test]
    async fn the_schema_cannot_prove_possession_so_a_named_adapter_is_enough() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("db shape", None))
                .await
                .unwrap();

        let evidence = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incident_evidence
               (evidence_id,incident_id,kind,source,collected_at,content_ref,
                claimed_trust,verified_trust,verification_method,verified_at,verifier_identity)
             VALUES ($1,$2,'LOG_EXCERPT','syslog',now(),'sha256:forged',
                     'SOURCE_ATTESTED','SOURCE_ATTESTED','SOURCE_ADAPTER',now(),'made-up-adapter')",
        )
        .bind(evidence)
        .bind(incident.id)
        .execute(&pool)
        .await
        .expect("the schema checks the shape of an attestation, not the possession of a secret");

        let (method, identity): (String, String) = sqlx::query_as(
            "SELECT verification_method, verifier_identity FROM kernel.incident_evidence
              WHERE evidence_id=$1",
        )
        .bind(evidence)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(method, "SOURCE_ADAPTER");
        assert_eq!(identity, "made-up-adapter");
        // What the schema DOES guarantee about this row: it now says exactly what it is.
        let note: String = sqlx::query_scalar(
            "SELECT coalesce(obj_description(
                (SELECT oid FROM pg_constraint
                  WHERE conname='incident_evidence_attestation_requires_adapter'),'pg_constraint'),'')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            note.contains("SHAPE ONLY"),
            "the constraint must carry the corrected statement of what it guarantees, got: {note}"
        );

        cleanup(&pool, &[user]).await;
    }

    // -----------------------------------------------------------------------
    // G12 A3 - the evidence set a verdict stands on.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_verdict_freezes_the_evidence_set_it_considered() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("freeze the set", None),
        )
        .await
        .unwrap();

        for reference in ["sha256:considered-1", "sha256:considered-2"] {
            insert_evidence(
                &pool,
                &no_adapters(),
                caller(user),
                incident.id,
                evidence_request(reference),
            )
            .await
            .unwrap();
        }
        let before = query_evidence(&pool, caller(user), incident.id, (None, None))
            .await
            .unwrap();
        assert!(before.iter().all(|row| !row.after_verdict));

        let verdict = insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap();
        assert_eq!(verdict.considered_evidence_count, 2);
        assert_eq!(verdict.snapshot_kind, "RECORDED");
        let digest = verdict
            .considered_evidence_digest
            .clone()
            .expect("a recorded snapshot has a digest");
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));

        // The capability is preserved: CONCLUDED still accepts evidence.
        let (created, late) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:after-signing"),
        )
        .await
        .unwrap();
        assert!(created, "CONCLUDED must still accept evidence");
        assert!(
            late.after_verdict,
            "evidence added after signing was never before the signer"
        );

        let rows = query_evidence(&pool, caller(user), incident.id, (None, None))
            .await
            .unwrap();
        let late_rows: Vec<_> = rows.iter().filter(|row| row.after_verdict).collect();
        assert_eq!(late_rows.len(), 1);
        assert_eq!(late_rows[0].evidence_id, late.evidence_id);
        let considered: Vec<_> = rows.iter().filter(|row| !row.after_verdict).collect();
        assert_eq!(considered.len(), 2);

        // The signed facts did not move when the evidence set did.
        let re_read = query_verdict(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(re_read.considered_evidence_count, 2);
        assert_eq!(
            re_read.considered_evidence_digest.as_deref(),
            Some(digest.as_str())
        );
        assert_eq!(re_read.snapshot_kind, "RECORDED");
        let incident_view = query_incident(&pool, caller(user), incident.id)
            .await
            .unwrap();
        let human = incident_view.human_verdict.unwrap();
        assert_eq!(human.considered_evidence_count, 2);
        assert_eq!(
            human.considered_evidence_digest.as_deref(),
            Some(digest.as_str())
        );

        // Same set, same digest; the value is a function of the set only.
        let snapshot: Vec<(Uuid, String)> = considered
            .iter()
            .map(|row| {
                (
                    row.evidence_id,
                    evidence_row_digest(
                        row.evidence_id,
                        &row.kind,
                        &row.source,
                        &row.content_ref,
                        &row.verified_trust,
                    ),
                )
            })
            .collect();
        assert_eq!(considered_set_digest(&snapshot), digest);

        cleanup(&pool, &[user]).await;
    }

    /// A verdict signed before 0017 has no recorded set. It says so, and the
    /// after-verdict flag falls back to the only thing left - the timestamps -
    /// instead of pretending a reconstruction is a record.
    #[tokio::test]
    async fn a_pre_migration_verdict_reports_an_unknown_considered_set() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("legacy verdict", None),
        )
        .await
        .unwrap();
        insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:legacy-considered"),
        )
        .await
        .unwrap();
        insert_verdict(
            &pool,
            caller(user),
            incident.id,
            verdict_request("CONFIRMED"),
        )
        .await
        .unwrap();

        // Rewrite the row into the shape 0017 produces for a pre-existing
        // verdict: no snapshot, no digest, no count. 0025 refuses a verdict
        // update, so the test states that it is a MIGRATION doing this - the one
        // context the schema allows to reshape a verdict row - rather than
        // pretending the write is legal for a running system.
        sqlx::query("DELETE FROM kernel.incident_verdict_evidence WHERE incident_id=$1")
            .bind(incident.id)
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL kernel.allow_verdict_backfill = 'on'")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE kernel.incident_verdicts
                SET snapshot_kind='PRE_MIGRATION_UNRECORDED',
                    considered_evidence_count=0,
                    considered_evidence_digest=NULL
              WHERE incident_id=$1",
        )
        .bind(incident.id)
        .execute(&mut *tx)
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let verdict = query_verdict(&pool, caller(user), incident.id)
            .await
            .unwrap();
        assert_eq!(verdict.snapshot_kind, "PRE_MIGRATION_UNRECORDED");
        assert_eq!(verdict.considered_evidence_count, 0);
        assert_eq!(
            verdict.considered_evidence_digest, None,
            "an unrecorded set must not be given a digest it never had"
        );

        // Evidence collected before the verdict stays on the signer's side of it.
        sqlx::query(
            "INSERT INTO kernel.incident_evidence
               (evidence_id,incident_id,kind,source,collected_at,content_ref,claimed_trust,
                verified_trust,verification_method,verified_at,submitted_by)
             VALUES ($1,$2,'LOG_EXCERPT','syslog',now(),'sha256:legacy-late','UNVERIFIED',
                     'UNVERIFIED','NONE',NULL,$3)",
        )
        .bind(Uuid::new_v4())
        .bind(incident.id)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

        let rows = query_evidence(&pool, caller(user), incident.id, (None, None))
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter().any(|row| row.after_verdict),
            "a row recorded after a legacy verdict is flagged by its timestamp"
        );
        assert!(
            rows.iter().any(|row| !row.after_verdict),
            "the row the signer could see is not flagged"
        );

        cleanup(&pool, &[user]).await;
    }

    // -- G12 B: evidence content ---------------------------------------------
    //
    // What these tests can and cannot prove is worth stating. They run against a
    // real PostgreSQL and a real schema, so the triggers, CHECK constraints and
    // digest arithmetic are real. They call the data layer, not the HTTP surface,
    // so the wire-level proof (headers, status codes, a browser) lives in
    // tests/acceptance/g12_evidence_content.sh and
    // tests/ui/g12-evidence-content.spec.ts. Neither replaces the other: a unit
    // test cannot see a response header, and an HTTP test cannot corrupt a row
    // through the trigger.

    /// A submission that carries its bytes instead of a reference.
    fn content_request(content_type: &str, body: &str) -> CreateEvidenceRequest {
        let mut payload = evidence_request("sha256:placeholder");
        payload.content_ref = None;
        payload.content = Some(EvidenceContentRequest {
            content_type: content_type.to_string(),
            body: body.to_string(),
        });
        payload
    }

    /// The positive path: the digest beside the bytes is the Kernel's own, computed
    /// over exactly what it stored, and the locator is derived from it.
    #[tokio::test]
    async fn content_is_digested_by_the_server_over_the_bytes_it_stored() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("content digest", None),
        )
        .await
        .unwrap();

        // Multi-byte on purpose: the digest is over bytes, and a character-count
        // implementation would still produce a "correct looking" row.
        let body = "2026-10-31T05:00:00Z ERROR upstream=db-1 msg=\"连接被重置\"";
        let (created, row) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain", body),
        )
        .await
        .unwrap();
        assert!(created);
        assert_eq!(row.content_status, "STORED");
        assert_eq!(row.content_type.as_deref(), Some("text/plain"));
        assert_eq!(row.content_bytes, Some(body.len() as i32));
        assert_eq!(
            row.content_sha256.as_deref(),
            Some(digest_of(body.as_bytes()).as_str())
        );
        // The caller chose nothing here: the locator is the server's digest.
        assert_eq!(
            row.content_ref,
            format!("sha256:{}", digest_of(body.as_bytes()))
        );

        let captured = row.content_captured_at.expect("content rows are dated");
        let expires = row
            .content_retention_expires_at
            .expect("the retention horizon is stored, not recomputed per reader");
        assert_eq!((expires - captured).num_days(), 365);

        cleanup(&pool, &[user]).await;
    }

    /// A digest the caller computed is not a check the Kernel performed. It is
    /// refused, and nothing is stored.
    #[tokio::test]
    async fn a_client_computed_digest_is_refused_rather_than_believed() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("digest claim", None))
                .await
                .unwrap();

        let mut payload = content_request("text/plain", "the real bytes");
        payload.content_ref = Some(format!("sha256:{}", "0".repeat(64)));
        let error = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, payload)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_REF_CONFLICT");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);

        let evidence_rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let content_rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence_content c
               JOIN kernel.incident_evidence e ON e.evidence_id = c.evidence_id
              WHERE e.incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(evidence_rows, 0, "a refused write stores no evidence row");
        assert_eq!(content_rows, 0, "a refused write stores no content row");

        // The same request with the digest the server would derive is accepted: the
        // rule is "must agree with the stored bytes", not "must not be sent".
        let mut agreed = content_request("text/plain", "the real bytes");
        agreed.content_ref = Some(format!("sha256:{}", digest_of(b"the real bytes")));
        let (_, row) = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, agreed)
            .await
            .unwrap();
        assert_eq!(row.content_status, "STORED");

        cleanup(&pool, &[user]).await;
    }

    /// Size, encoding and content type are refused before any SQL runs, and the
    /// bound is in bytes so 30k CJK characters are over it.
    #[tokio::test]
    async fn content_limits_are_refused_before_anything_is_stored() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(
            &pool,
            caller(user),
            incident_request("content limits", None),
        )
        .await
        .unwrap();

        let empty = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain", ""),
        )
        .await
        .unwrap_err();
        assert_eq!(empty.code, "EVIDENCE_CONTENT_EMPTY");

        // HTML is refused by type, which is the first of the two defences; the
        // second is that nothing is ever rendered as markup.
        let html = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/html", "<script>alert(1)</script>"),
        )
        .await
        .unwrap_err();
        assert_eq!(html.code, "EVIDENCE_CONTENT_TYPE_UNSUPPORTED");
        assert_eq!(html.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);

        // A charset parameter is not the same value: the Kernel stores what it can
        // serve, and it serves a fixed charset.
        let charset = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain; charset=utf-16", "hello"),
        )
        .await
        .unwrap_err();
        assert_eq!(charset.code, "EVIDENCE_CONTENT_TYPE_UNSUPPORTED");

        let too_big = "x".repeat(EVIDENCE_CONTENT_MAX_BYTES + 1);
        let error = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain", &too_big),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_TOO_LARGE");
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);

        // 30k characters, 90k bytes: a character-based bound would accept this.
        let wide = "景".repeat(30_000);
        let error = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain", &wide),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_TOO_LARGE");

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0, "every refusal left the incident empty");

        // Exactly at the bound is accepted, because the bound is the bound.
        let exact = "y".repeat(EVIDENCE_CONTENT_MAX_BYTES);
        let (_, row) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("application/json", &exact),
        )
        .await
        .unwrap();
        assert_eq!(row.content_bytes, Some(EVIDENCE_CONTENT_MAX_BYTES as i32));
        assert_eq!(row.content_type.as_deref(), Some("application/json"));

        cleanup(&pool, &[user]).await;
    }

    /// A row without bytes keeps working, and says what it is.
    #[tokio::test]
    async fn a_reference_without_bytes_reads_as_a_legacy_reference() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("legacy ref", None))
                .await
                .unwrap();

        let (_, row) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("s3://bucket/2026/10/31/excerpt.log"),
        )
        .await
        .unwrap();
        assert_eq!(row.content_status, "LEGACY_REFERENCE");
        assert_eq!(row.content_ref, "s3://bucket/2026/10/31/excerpt.log");
        assert_eq!(row.content_type, None);
        assert_eq!(row.content_bytes, None);
        assert_eq!(row.content_sha256, None);
        assert_eq!(row.content_captured_at, None);
        assert_eq!(row.content_retention_expires_at, None);

        // Neither bytes nor a reference: there is nothing to record, and the
        // refusal says so instead of inventing an empty string.
        let mut neither = evidence_request("sha256:unused");
        neither.content_ref = None;
        let error = insert_evidence(&pool, &no_adapters(), caller(user), incident.id, neither)
            .await
            .unwrap_err();
        assert_eq!(error.code, "INVALID_REQUEST");
        assert!(error.message.contains("contentRef is required"));

        cleanup(&pool, &[user]).await;
    }

    /// Fixity is a comparison against bytes in hand, and the recorded length is a
    /// second witness so rewriting the digest does not launder a shorter body.
    #[test]
    fn stored_content_is_verified_against_the_bytes_in_hand() {
        let id = Uuid::new_v4();
        let body = b"2026-10-31T05:00:00Z INFO heartbeat ok";
        let digest = digest_of(body);
        assert_eq!(
            verify_stored_content(id, body.len() as i32, body, &digest).unwrap(),
            digest
        );

        let mut tampered = body.to_vec();
        tampered[0] = b'9';
        let error = verify_stored_content(id, body.len() as i32, &tampered, &digest).unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_INTEGRITY_FAILED");
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(error.message.contains(&digest));
        assert!(error.message.contains(&digest_of(&tampered)));

        // Truncated, digest untouched.
        let error = verify_stored_content(id, body.len() as i32, &body[..4], &digest).unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_INTEGRITY_FAILED");

        // Digest rewritten to match the tampered bytes: the recorded length is the
        // witness that catches it.
        let error = verify_stored_content(
            id,
            body.len() as i32,
            &tampered[..body.len() - 1],
            &digest_of(&tampered[..body.len() - 1]),
        )
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_CONTENT_INTEGRITY_FAILED");

        // Length rewritten too: nothing left to compare, and that is fine - the
        // stored row cannot be rewritten at all (see the trigger test below).
        assert!(verify_stored_content(id, body.len() as i32, body, &digest).is_ok());
    }

    /// The capture window's claim half is bounded by the Kernel clock.
    #[test]
    fn collected_at_outside_the_clock_window_is_refused() {
        assert!(check_collected_at(Utc::now()).is_ok());
        assert!(check_collected_at(
            Utc::now() + chrono::Duration::seconds(COLLECTED_AT_FUTURE_SKEW_SECONDS)
        )
        .is_ok());

        let error = check_collected_at(
            Utc::now() + chrono::Duration::seconds(COLLECTED_AT_FUTURE_SKEW_SECONDS + 60),
        )
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_COLLECTED_AT_IN_FUTURE");

        let error = check_collected_at(
            Utc::now() - chrono::Duration::seconds(COLLECTED_AT_MAX_AGE_SECONDS + 60),
        )
        .unwrap_err();
        assert_eq!(error.code, "EVIDENCE_COLLECTED_AT_TOO_OLD");
    }

    /// The list's query window: both ends, in order, and no wider than the bound.
    #[test]
    fn the_evidence_query_window_is_whole_and_bounded() {
        let open = evidence_window(&EvidenceListQuery::default()).unwrap();
        assert_eq!(open, (None, None), "no window means every row, as before");

        let window = evidence_window(&EvidenceListQuery {
            since: Some("2026-10-01T00:00:00Z".to_string()),
            until: Some("2026-10-15T00:00:00Z".to_string()),
        })
        .unwrap();
        assert!(window.0.is_some() && window.1.is_some());

        for (since, until, why) in [
            (Some("2026-10-01T00:00:00Z"), None, "half bounded"),
            (None, Some("2026-10-01T00:00:00Z"), "half bounded"),
            (
                Some("2026-10-15T00:00:00Z"),
                Some("2026-10-01T00:00:00Z"),
                "inverted",
            ),
            (
                Some("2026-01-01T00:00:00Z"),
                Some("2026-10-01T00:00:00Z"),
                "too wide",
            ),
            (Some("yesterday"), Some("today"), "unparseable"),
        ] {
            let error = evidence_window(&EvidenceListQuery {
                since: since.map(str::to_string),
                until: until.map(str::to_string),
            })
            .unwrap_err();
            assert_eq!(error.code, "INCIDENT_EVIDENCE_WINDOW_INVALID", "{why}");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }
    }

    /// The per-incident cap, which is what bounds the total stored content.
    #[tokio::test]
    async fn an_incident_refuses_more_evidence_than_its_cap() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) = insert_incident(&pool, caller(user), incident_request("row cap", None))
            .await
            .unwrap();
        // The cap counts rows, not writes: filling it in one statement is the same
        // situation as 200 separate submissions.
        sqlx::query(
            "INSERT INTO kernel.incident_evidence
               (evidence_id,incident_id,kind,source,collected_at,content_ref,claimed_trust)
             SELECT gen_random_uuid(), $1, 'OPERATOR_NOTE', 'MANUAL', now(),
                    'bulk-'||g, 'UNVERIFIED'
               FROM generate_series(1,$2) g",
        )
        .bind(incident.id)
        .bind(EVIDENCE_MAX_ROWS)
        .execute(&pool)
        .await
        .unwrap();

        let error = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            evidence_request("sha256:one-too-many"),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "INCIDENT_EVIDENCE_LIMIT");
        assert_eq!(error.status, StatusCode::CONFLICT);

        let rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_evidence WHERE incident_id=$1",
        )
        .bind(incident.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, EVIDENCE_MAX_ROWS, "the refused row was not stored");

        cleanup(&pool, &[user]).await;
    }

    /// Write-once is a property of the data, not of the handlers: a direct UPDATE
    /// or DELETE is refused by the database, and the row survives both attempts.
    #[tokio::test]
    async fn stored_content_cannot_be_rewritten_even_with_sql() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let user = seed_user(&pool, "operator").await;
        let (_, incident) =
            insert_incident(&pool, caller(user), incident_request("write once", None))
                .await
                .unwrap();
        let body = "original bytes";
        let (_, row) = insert_evidence(
            &pool,
            &no_adapters(),
            caller(user),
            incident.id,
            content_request("text/plain", body),
        )
        .await
        .unwrap();

        let update = sqlx::query(
            "UPDATE kernel.incident_evidence_content SET body='rewritten'::bytea
              WHERE evidence_id=$1",
        )
        .bind(row.evidence_id)
        .execute(&pool)
        .await;
        let error = update.expect_err("the write-once trigger must refuse an UPDATE");
        assert!(
            error.to_string().contains("write-once"),
            "the refusal names the rule: {error}"
        );

        let delete =
            sqlx::query("DELETE FROM kernel.incident_evidence_content WHERE evidence_id=$1")
                .bind(row.evidence_id)
                .execute(&pool)
                .await;
        let error = delete.expect_err("the write-once trigger must refuse a DELETE");
        assert!(error.to_string().contains("write-once"));

        // And the bytes are exactly what they were.
        let stored: (Vec<u8>, String, i32) = sqlx::query_as(
            "SELECT body, sha256, content_bytes FROM kernel.incident_evidence_content
              WHERE evidence_id=$1",
        )
        .bind(row.evidence_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored.0, body.as_bytes());
        assert_eq!(stored.1, digest_of(body.as_bytes()));
        assert_eq!(
            verify_stored_content(row.evidence_id, stored.2, &stored.0, &stored.1).unwrap(),
            stored.1
        );

        cleanup(&pool, &[user]).await;
    }

    // -------------------------------------------------------------------------
    // G12 D5 - the business workspace boundary, asserted one layer below the routes.
    //
    // tests/acceptance/d5_workspace_scope.sh drives the same nine claims through real
    // HTTP; these are the same claims directly against the data operations, where a
    // regression is a red assertion instead of a 404 somebody explains away. Every test
    // here resolves its scope with the production `DataScope::resolve_for`, so what
    // is asserted is the query the handlers run.
    // -------------------------------------------------------------------------

    async fn seed_workspace(pool: &PgPool, key: &str) -> Uuid {
        let workspace = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.business_workspaces (workspace_id,key,name)
             VALUES ($1,$2,$3)",
        )
        .bind(workspace)
        .bind(format!("{key}-{workspace}"))
        .bind(format!("d5 test workspace {key}"))
        .execute(pool)
        .await
        .unwrap();
        workspace
    }

    async fn grant(pool: &PgPool, workspace: Uuid, user: Uuid) {
        sqlx::query(
            "INSERT INTO kernel.business_workspace_members (workspace_id,user_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(workspace)
        .bind(user)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn revoke(pool: &PgPool, workspace: Uuid, user: Uuid) {
        sqlx::query(
            "DELETE FROM kernel.business_workspace_members
              WHERE workspace_id=$1 AND user_id=$2",
        )
        .bind(workspace)
        .bind(user)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn drop_workspaces(pool: &PgPool, workspaces: &[Uuid]) {
        for workspace in workspaces {
            sqlx::query("DELETE FROM kernel.business_workspaces WHERE workspace_id=$1")
                .bind(workspace)
                .execute(pool)
                .await
                .unwrap();
        }
    }

    fn request_in(mut request: CreateIncidentRequest, workspace: Uuid) -> CreateIncidentRequest {
        request.workspace_id = Some(workspace);
        request
    }

    fn list_query() -> IncidentListQuery {
        IncidentListQuery {
            limit: Some(100),
            ..Default::default()
        }
    }

    /// The first two rows of the acceptance matrix, at the layer that decides them: a
    /// viewer reads the incidents of the workspaces it is a member of, and nothing of any
    /// other - single row, list, evidence and timeline all at once.
    #[tokio::test]
    async fn a_viewer_reads_one_workspace_and_never_the_other() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let viewer = seed_user(&pool, "viewer").await;
        let operator_a = seed_user(&pool, "operator").await;
        let operator_b = seed_user(&pool, "operator").await;
        let ws_a = seed_workspace(&pool, "d5-view-a").await;
        let ws_b = seed_workspace(&pool, "d5-view-b").await;
        grant(&pool, ws_a, operator_a).await;
        grant(&pool, ws_b, operator_b).await;
        grant(&pool, ws_a, viewer).await;

        let (_, in_a) = insert_incident(
            &pool,
            DataScope::resolve_for(&pool, operator_a, Role::Operator)
                .await
                .unwrap(),
            request_in(incident_request("incident inside workspace a", None), ws_a),
        )
        .await
        .unwrap();
        let (_, in_b) = insert_incident(
            &pool,
            DataScope::resolve_for(&pool, operator_b, Role::Operator)
                .await
                .unwrap(),
            request_in(incident_request("incident inside workspace b", None), ws_b),
        )
        .await
        .unwrap();
        insert_evidence(
            &pool,
            &no_adapters(),
            DataScope::resolve_for(&pool, operator_a, Role::Operator)
                .await
                .unwrap(),
            in_a.id,
            evidence_request("d5/view-a/evidence"),
        )
        .await
        .unwrap();

        // The viewer is a member of A only. Its scope names one workspace, and the report
        // says so - which is what explains an empty page without blaming the platform.
        let viewer_scope = DataScope::resolve_for(&pool, viewer, Role::Viewer)
            .await
            .unwrap();
        assert!(viewer_scope.may_enter(ws_a));
        assert!(!viewer_scope.may_enter(ws_b));

        let items = query_incidents(&pool, viewer_scope.clone(), list_query())
            .await
            .unwrap()
            .items;
        assert!(items.iter().any(|item| item.id == in_a.id));
        assert!(!items.iter().any(|item| item.id == in_b.id));

        let read = query_incident(&pool, viewer_scope.clone(), in_a.id)
            .await
            .expect("a viewer reads the record of its own workspace");
        assert_eq!(read.id, in_a.id);
        let refused = query_incident(&pool, viewer_scope.clone(), in_b.id)
            .await
            .expect_err("a viewer must not read the other workspace");
        assert_eq!(refused.status, StatusCode::NOT_FOUND);
        assert_eq!(refused.code, "INCIDENT_NOT_FOUND");

        // The same boundary on the two faces that used to disagree about it.
        let evidence = query_evidence(&pool, viewer_scope.clone(), in_a.id, (None, None))
            .await
            .expect("evidence of a readable record is readable");
        assert_eq!(evidence.len(), 1);
        assert_eq!(
            query_evidence(&pool, viewer_scope.clone(), in_b.id, (None, None))
                .await
                .expect_err("evidence of an unreadable record is not")
                .code,
            "INCIDENT_NOT_FOUND"
        );
        assert!(query_timeline(&pool, viewer_scope.clone(), in_a.id, 50)
            .await
            .is_ok());
        assert_eq!(
            query_timeline(&pool, viewer_scope.clone(), in_b.id, 50)
                .await
                .expect_err("the trail of an unreadable record is not readable")
                .code,
            "INCIDENT_NOT_FOUND"
        );

        cleanup(&pool, &[operator_a, operator_b, viewer]).await;
        drop_workspaces(&pool, &[ws_a, ws_b]).await;
    }

    /// The ruling itself: platform administration is not a business data grant. An admin
    /// that was never made a member reads none of it - the same 404 a stranger gets.
    #[tokio::test]
    async fn an_admin_without_membership_reads_no_incident() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let admin = seed_user(&pool, "admin").await;
        let operator = seed_user(&pool, "operator").await;
        let workspace = seed_workspace(&pool, "d5-admin").await;
        grant(&pool, workspace, operator).await;
        let (_, incident) = insert_incident(
            &pool,
            DataScope::resolve_for(&pool, operator, Role::Operator)
                .await
                .unwrap(),
            request_in(
                incident_request("incident in a workspace the admin is not in", None),
                workspace,
            ),
        )
        .await
        .unwrap();

        // The admin is a member of the legacy workspace only, so it can read that one and
        // not this one.
        let admin_scope = DataScope::resolve_for(&pool, admin, Role::Admin)
            .await
            .unwrap();
        assert!(!admin_scope.may_enter(workspace));
        assert_eq!(
            query_incident(&pool, admin_scope.clone(), incident.id)
                .await
                .expect_err("an admin without the membership reads nothing")
                .code,
            "INCIDENT_NOT_FOUND"
        );
        let items = query_incidents(&pool, admin_scope.clone(), list_query())
            .await
            .unwrap()
            .items;
        assert!(!items.iter().any(|item| item.id == incident.id));

        // And the grant is what changes it - one row, not a role.
        grant(&pool, workspace, admin).await;
        let admin_scope = DataScope::resolve_for(&pool, admin, Role::Admin)
            .await
            .unwrap();
        assert!(query_incident(&pool, admin_scope, incident.id)
            .await
            .is_ok());

        cleanup(&pool, &[admin, operator]).await;
        drop_workspaces(&pool, &[workspace]).await;
    }

    /// A caller cannot state its own scope: naming a workspace it is not a member of is
    /// 404, and the row is not created anywhere.
    #[tokio::test]
    async fn a_create_naming_a_workspace_you_cannot_enter_is_not_found() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let operator = seed_user(&pool, "operator").await;
        let stranger = seed_user(&pool, "operator").await;
        let workspace = seed_workspace(&pool, "d5-create-foreign").await;
        grant(&pool, workspace, stranger).await;

        let caller = DataScope::resolve_for(&pool, operator, Role::Operator)
            .await
            .unwrap();
        let refused = insert_incident(
            &pool,
            caller,
            request_in(
                incident_request("incident filed into another workspace", None),
                workspace,
            ),
        )
        .await
        .expect_err("naming a workspace you cannot enter must be refused");
        assert_eq!(refused.status, StatusCode::NOT_FOUND);
        assert_eq!(refused.code, "BUSINESS_WORKSPACE_NOT_FOUND");

        let created: i64 =
            sqlx::query_scalar("SELECT count(*) FROM kernel.incidents WHERE workspace_id=$1")
                .bind(workspace)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(created, 0, "a refused create must not leave a row");

        cleanup(&pool, &[operator, stranger]).await;
        drop_workspaces(&pool, &[workspace]).await;
    }

    /// Two refusals that look alike and are not: an account with no membership at all has
    /// nowhere to put a record (403), and an account in more than one workspace must say
    /// which (400). Neither is a scope the caller declared for itself.
    #[tokio::test]
    async fn a_create_without_one_obvious_workspace_is_refused_by_code_not_by_guessing() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let homeless = seed_user(&pool, "operator").await;
        revoke(&pool, scope::legacy_workspace(), homeless).await;
        let homeless_scope = DataScope::resolve_for(&pool, homeless, Role::Operator)
            .await
            .unwrap();
        assert!(homeless_scope.workspaces.is_empty());
        let refused = insert_incident(
            &pool,
            homeless_scope,
            incident_request("incident with no workspace to file it in", None),
        )
        .await
        .expect_err("an account in no workspace cannot create business data");
        assert_eq!(refused.status, StatusCode::FORBIDDEN);
        assert_eq!(refused.code, "INCIDENT_WORKSPACE_FORBIDDEN");

        let two = seed_user(&pool, "operator").await;
        let second = seed_workspace(&pool, "d5-create-two").await;
        grant(&pool, second, two).await;
        let two_scope = DataScope::resolve_for(&pool, two, Role::Operator)
            .await
            .unwrap();
        assert_eq!(two_scope.workspace_count(), 2);
        let refused = insert_incident(
            &pool,
            two_scope,
            incident_request("incident with two possible workspaces", None),
        )
        .await
        .expect_err("the kernel will not choose a workspace for the caller");
        assert_eq!(refused.status, StatusCode::BAD_REQUEST);
        assert_eq!(refused.code, "INCIDENT_WORKSPACE_REQUIRED");

        cleanup(&pool, &[homeless, two]).await;
        drop_workspaces(&pool, &[second]).await;
    }

    /// The owner filter narrows and never opens: naming another account that lives in
    /// another workspace returns nothing, whatever the filter says.
    #[tokio::test]
    async fn an_owner_filter_cannot_reach_across_a_workspace_boundary() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let operator_a = seed_user(&pool, "operator").await;
        let operator_b = seed_user(&pool, "operator").await;
        let ws_b = seed_workspace(&pool, "d5-owner-filter").await;
        grant(&pool, ws_b, operator_b).await;
        let (_, in_b) = insert_incident(
            &pool,
            DataScope::resolve_for(&pool, operator_b, Role::Operator)
                .await
                .unwrap(),
            request_in(
                incident_request("record in the other workspace", None),
                ws_b,
            ),
        )
        .await
        .unwrap();

        let scope_a = DataScope::resolve_for(&pool, operator_a, Role::Operator)
            .await
            .unwrap();
        let items = query_incidents(
            &pool,
            scope_a.clone(),
            IncidentListQuery {
                owner: Some(operator_b.to_string()),
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .items;
        assert!(
            items.is_empty(),
            "an owner filter naming an account in another workspace returned a row"
        );
        // An admin is not exempt either: platform administration is not a data grant.
        let admin = seed_user(&pool, "admin").await;
        let admin_scope = DataScope::resolve_for(&pool, admin, Role::Admin)
            .await
            .unwrap();
        let items = query_incidents(
            &pool,
            admin_scope,
            IncidentListQuery {
                owner: Some(operator_b.to_string()),
                limit: Some(100),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .items;
        assert!(items.is_empty());
        assert_eq!(
            query_incident(
                &pool,
                DataScope::resolve_for(&pool, operator_a, Role::Operator)
                    .await
                    .unwrap(),
                in_b.id
            )
            .await
            .expect_err("the row itself is out of scope too")
            .code,
            "INCIDENT_NOT_FOUND"
        );

        cleanup(&pool, &[operator_a, operator_b, admin]).await;
        drop_workspaces(&pool, &[ws_b]).await;
    }

    /// A revocation is answered with on the next call, with no session, token or run
    /// needing to be refreshed: nothing about the caller is cached across the write.
    #[tokio::test]
    async fn a_revocation_takes_effect_on_the_next_read() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let operator = seed_user(&pool, "operator").await;
        let workspace = seed_workspace(&pool, "d5-revoke").await;
        grant(&pool, workspace, operator).await;
        let (_, incident) = insert_incident(
            &pool,
            DataScope::resolve_for(&pool, operator, Role::Operator)
                .await
                .unwrap(),
            request_in(
                incident_request("record whose scope will be revoked", None),
                workspace,
            ),
        )
        .await
        .unwrap();
        assert!(query_incident(
            &pool,
            DataScope::resolve_for(&pool, operator, Role::Operator)
                .await
                .unwrap(),
            incident.id
        )
        .await
        .is_ok());

        revoke(&pool, workspace, operator).await;
        let after = DataScope::resolve_for(&pool, operator, Role::Operator)
            .await
            .unwrap();
        assert!(!after.may_enter(workspace));
        assert_eq!(
            query_incident(&pool, after, incident.id)
                .await
                .expect_err("the revoked member reads nothing")
                .code,
            "INCIDENT_NOT_FOUND"
        );

        grant(&pool, workspace, operator).await;
        assert!(query_incident(
            &pool,
            DataScope::resolve_for(&pool, operator, Role::Operator)
                .await
                .unwrap(),
            incident.id
        )
        .await
        .is_ok());

        cleanup(&pool, &[operator]).await;
        drop_workspaces(&pool, &[workspace]).await;
    }
}

/// G13-B1.6: the job-scoped Evidence effect (ADR-G13-B1.6).
///
/// These tests drive the real evidence writer against real PostgreSQL. The
/// crash matrix itself is simulated by the states a crash leaves behind - an
/// Evidence row bound to a job whose terminal write never happened - because a
/// process kill adds no database state beyond that.
#[cfg(test)]
mod effect_tests {
    use super::*;
    use crate::scope::{self, DataScope, RowRule};
    use sqlx::postgres::PgConnectOptions;
    use sqlx::PgPool;

    const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";
    const ADAPTER: &str = "effect-adapter";
    const SECRET: &str = "effect-secret";

    async fn test_pool() -> Option<PgPool> {
        let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(std::env::VarError::NotPresent) => {
                if std::env::var(REQUIRE_DATABASE_ENV).ok().as_deref() == Some("1") {
                    panic!("{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset");
                }
                return None;
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("OPSWEAVE_TEST_DATABASE_URL is not valid UTF-8")
            }
        };
        let options: PgConnectOptions = url.parse().unwrap();
        let pool = PgPool::connect_with(options).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        Some(pool)
    }

    async fn state(pool: PgPool) -> AppState {
        let mut config = crate::config::Config::from_env();
        config
            .evidence_adapters
            .insert(ADAPTER.to_string(), SECRET.to_string());
        AppState::new(config, pool, b"effect-test-cursor".to_vec()).unwrap()
    }

    struct Fixture {
        workspace: Uuid,
        source: Uuid,
        incident: Uuid,
        principal: Uuid,
        events: Vec<Uuid>,
        jobs: Vec<Uuid>,
    }

    async fn seed(pool: &PgPool, concluded: bool) -> Fixture {
        let workspace = scope::legacy_workspace();
        let source = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.telemetry_sources
                 (source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state)
             VALUES ($1,$2,'zabbix-source','secretref:zabbix/effect','https://zabbix.example/api_jsonrpc.php','VERIFY','READY')",
        )
        .bind(source)
        .bind(workspace)
        .execute(pool)
        .await
        .unwrap();
        let incident = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incidents
               (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,origin)
             VALUES ($1,$2,'MAJOR','OPEN','ZABBIX',$3,now(),$4,$5,'AUTOMATION')",
        )
        .bind(incident)
        .bind(format!("effect incident {incident}"))
        .bind(format!("effect-native-{incident}"))
        .bind(Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).unwrap())
        .bind(workspace)
        .execute(pool)
        .await
        .unwrap();
        if concluded {
            // The shape a human verdict leaves while an automation attempt is in
            // flight. A fixture sets it directly because this test is about the
            // automation's recovery, not about how a verdict is recorded.
            sqlx::query(
                "INSERT INTO kernel.incident_verdicts
                   (incident_id,verdict,rationale,decided_by)
                 VALUES ($1,'CONFIRMED','a person concluded this while the worker was running',$2)",
            )
            .bind(incident)
            .bind(Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).unwrap())
            .execute(pool)
            .await
            .unwrap();
            sqlx::query("UPDATE kernel.incidents SET status='CONCLUDED' WHERE incident_id=$1")
                .bind(incident)
                .execute(pool)
                .await
                .unwrap();
        }
        let principal = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.automation_principals
                 (principal_id,plugin_id,instance_id,node_id,node_generation,workspace_id,source_id,
                  allowed_ops,event_id,incident_id,budget,issued_at,expires_at,jti)
             VALUES ($1,'zabbix-source',$2,$3,1,$4,$5,$6,NULL,NULL,'{}'::jsonb,now(),now()+interval '300 seconds',$7)",
        )
        .bind(principal)
        .bind(Uuid::new_v4())
        .bind(Uuid::new_v4())
        .bind(workspace)
        .bind(source)
        .bind(vec!["SOURCE_COLLECT".to_string()])
        .bind(Uuid::new_v4())
        .execute(pool)
        .await
        .unwrap();
        Fixture {
            workspace,
            source,
            incident,
            principal,
            events: Vec::new(),
            jobs: Vec::new(),
        }
    }

    /// A job in the state a worker holds while it is executing: RUNNING with a
    /// live lease. The evidence writer now proves this grant inside its
    /// transaction (B1.8 Phase 2), so a PENDING fixture would be refused before
    /// the behaviour under test.
    async fn add_job(pool: &PgPool, fixture: &mut Fixture) -> (Uuid, AutomationLeaseHandle) {
        let event = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.telemetry_events
                 (event_id,workspace_id,source_id,native_id,idempotency_key,trigger_state,severity,
                  occurred_at,observed_at,payload_digest,payload,late,incident_id)
             VALUES ($1,$2,$3,$4,$5,'PROBLEM','MAJOR',now(),now(),$6,'{}'::jsonb,false,$7)",
        )
        .bind(event)
        .bind(fixture.workspace)
        .bind(fixture.source)
        .bind(format!("effect-native-{event}"))
        .bind(format!("effect-key-{event}"))
        .bind(format!("sha256:{}", "a".repeat(64)))
        .bind(fixture.incident)
        .execute(pool)
        .await
        .unwrap();
        let job = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.automation_jobs
                 (job_id,event_id,incident_id,principal_id,source_id,status,max_attempts,
                  attempts,lease_owner,lease_until,lease_id,fencing_token)
             VALUES ($1,$2,$3,$4,$5,'RUNNING',3,1,'effect-test',now()+interval '5 minutes',$6,1)",
        )
        .bind(job)
        .bind(event)
        .bind(fixture.incident)
        .bind(fixture.principal)
        .bind(fixture.source)
        .bind(lease_id)
        .execute(pool)
        .await
        .unwrap();
        fixture.events.push(event);
        fixture.jobs.push(job);
        (
            job,
            AutomationLeaseHandle {
                job_id: job,
                lease_id,
                fencing_token: 1,
            },
        )
    }

    async fn cleanup(pool: &PgPool, fixture: &Fixture) {
        let _ = sqlx::query("DELETE FROM kernel.incident_evidence WHERE incident_id=$1")
            .bind(fixture.incident)
            .execute(pool)
            .await;
        // 0025 guards verdict deletion even for cleanup; state the exception the
        // schema accepts so the incident can be removed and no fixture survives.
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL kernel.allow_verdict_removal = 'on'")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DELETE FROM kernel.incident_verdicts WHERE incident_id=$1")
            .bind(fixture.incident)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let _ = sqlx::query(
            "DELETE FROM kernel.audit_events WHERE subject_type='INCIDENT' AND subject_id=$1",
        )
        .bind(fixture.incident.to_string())
        .execute(pool)
        .await;
        for job in &fixture.jobs {
            let _ = sqlx::query("DELETE FROM kernel.automation_jobs WHERE job_id=$1")
                .bind(job)
                .execute(pool)
                .await;
        }
        for event in &fixture.events {
            let _ = sqlx::query("DELETE FROM kernel.telemetry_events WHERE event_id=$1")
                .bind(event)
                .execute(pool)
                .await;
        }
        let _ = sqlx::query("DELETE FROM kernel.automation_principals WHERE principal_id=$1")
            .bind(fixture.principal)
            .execute(pool)
            .await;
        sqlx::query("DELETE FROM kernel.incidents WHERE incident_id=$1")
            .bind(fixture.incident)
            .execute(pool)
            .await
            .expect("test cleanup must remove the incident");
        let _ = sqlx::query("DELETE FROM kernel.telemetry_sources WHERE source_id=$1")
            .bind(fixture.source)
            .execute(pool)
            .await;
    }

    /// A complete v2-attested evidence body, signed the way a plugin does.
    fn automation_evidence(
        fixture: &Fixture,
        body: &str,
        collected_at: DateTime<Utc>,
    ) -> serde_json::Value {
        // The Kernel derives contentRef from the bytes it stores; a supplied
        // value that disagrees is refused, so the fixture signs the same one.
        let content_ref = format!("sha256:{}", hex::encode(Sha256::digest(body.as_bytes())));
        let bound = EvidenceTuple {
            incident_id: fixture.incident,
            workspace_id: fixture.workspace,
            kind: "METRIC_SNAPSHOT",
            source: "zabbix:effect",
            collected_at,
            content_ref: &content_ref,
        };
        let issued_at = Utc::now();
        let payload = attestation_payload(ADAPTER, &bound, issued_at).unwrap();
        let mut mac = HmacSha256::new_from_slice(SECRET.as_bytes()).unwrap();
        mac.update(payload.as_bytes());
        use base64::Engine;
        let signature =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        serde_json::json!({
            "kind": "METRIC_SNAPSHOT",
            "source": "zabbix:effect",
            "collectedAt": collected_at,
            "contentRef": content_ref,
            "content": {"contentType": "application/json", "body": body},
            "attestation": {
                "adapterId": ADAPTER,
                "workspaceId": fixture.workspace,
                "issuedAt": issued_at,
                "signature": signature
            }
        })
    }

    fn principal(fixture: &Fixture) -> crate::automation::AutomationPrincipal {
        let now = Utc::now();
        crate::automation::AutomationPrincipal {
            row: crate::automation::PrincipalRow {
                principal_id: fixture.principal,
                plugin_id: "zabbix-source".into(),
                instance_id: Uuid::new_v4(),
                node_id: Uuid::new_v4(),
                node_generation: 1,
                workspace_id: fixture.workspace,
                source_id: fixture.source,
                allowed_ops: vec!["SOURCE_COLLECT".into()],
                event_id: None,
                incident_id: None,
                budget: serde_json::json!({"windowSeconds": 300, "evidenceBytes": 1048576}),
                issued_at: now,
                expires_at: now + chrono::Duration::seconds(300),
                jti: Uuid::new_v4(),
                revoked_at: None,
            },
            claims: crate::automation::AutomationClaims {
                v: 1,
                kind: "automation".into(),
                principal_id: fixture.principal,
                plugin_id: "zabbix-source".into(),
                instance_id: Uuid::new_v4(),
                node_id: Uuid::new_v4(),
                node_generation: 1,
                workspace_id: fixture.workspace,
                source_id: fixture.source,
                allowed_ops: vec!["SOURCE_COLLECT".into()],
                event_id: None,
                incident_id: None,
                budget: serde_json::json!({"windowSeconds": 300}),
                issued_at: now.timestamp(),
                expires_at: (now + chrono::Duration::seconds(300)).timestamp(),
                jti: Uuid::new_v4(),
                audience: crate::automation::AUDIENCE.into(),
            },
        }
    }

    fn human_evidence_request(content_ref: &str) -> CreateEvidenceRequest {
        CreateEvidenceRequest {
            kind: "METRIC_SNAPSHOT".to_string(),
            source: "prometheus".to_string(),
            collected_at: Utc::now(),
            content_ref: Some(content_ref.to_string()),
            content: None,
            trust: None,
            claimed_trust: None,
            attestation: None,
        }
    }

    async fn evidence_rows(pool: &PgPool, incident: Uuid) -> Vec<(Uuid, Option<Uuid>, String)> {
        sqlx::query_as(
            "SELECT evidence_id, automation_job_id, content_ref
               FROM kernel.incident_evidence WHERE incident_id=$1 ORDER BY created_at",
        )
        .bind(incident)
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// B1.8 Phase 1 reproduction: the automation path checks the incident
    /// status, then writes. If a Human Verdict commits between that check and
    /// the write, the inner writer must refuse. Here the verdict has already
    /// committed when the inner writer is called - the state the race leaves.
    #[tokio::test]
    async fn automation_evidence_cannot_commit_after_a_human_verdict() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let mut fixture = seed(&pool, false).await;
        let (job, lease) = add_job(&pool, &mut fixture).await;
        let service = Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).unwrap();
        let caller = DataScope::for_automation(service, fixture.workspace);
        insert_verdict(
            &pool,
            caller.clone(),
            fixture.incident,
            CreateVerdictRequest {
                verdict: "INCONCLUSIVE".into(),
                rationale: "a person concluded while the attempt was in flight".into(),
            },
        )
        .await
        .unwrap();

        let request: CreateEvidenceRequest = serde_json::from_value(automation_evidence(
            &fixture,
            r#"{"samples":[1]}"#,
            Utc::now(),
        ))
        .unwrap();
        let error = insert_evidence_as(
            &pool,
            &adapters_map(),
            caller,
            EvidenceActor {
                actor_type: "AUTOMATION",
                actor_id: fixture.principal,
                automation_job_id: Some(job),
                lease: Some(lease),
            },
            fixture.incident,
            request,
        )
        .await
        .expect_err("automation evidence after a verdict must be refused");
        assert_eq!(error.code, "INCIDENT_ALREADY_CONCLUDED", "{error:?}");
        assert!(
            evidence_rows(&pool, fixture.incident).await.is_empty(),
            "no evidence row may be written after the verdict"
        );

        cleanup(&pool, &fixture).await;
    }

    /// B1.8 Phase 1, reverse order: a verdict and an automation evidence write
    /// race. The database lock decides the serial order. If the verdict wins
    /// first it must see no evidence and refuse CONFIRMED (never succeed with a
    /// snapshot that omits a row that committed after it); if the evidence wins
    /// first the verdict must include it. No sleeps are used - the incident row
    /// lock is the synchronisation point.
    #[tokio::test]
    async fn a_verdict_and_automation_evidence_serialize_without_a_missing_snapshot() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let mut successes = 0;
        for _ in 0..20 {
            let mut fixture = seed(&pool, false).await;
            let (job, lease) = add_job(&pool, &mut fixture).await;
            let service = Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).unwrap();
            let caller = DataScope::for_automation(service, fixture.workspace);
            let request: CreateEvidenceRequest = serde_json::from_value(automation_evidence(
                &fixture,
                r#"{"samples":[3]}"#,
                Utc::now(),
            ))
            .unwrap();
            let adapters = adapters_map();
            let evidence = insert_evidence_as(
                &pool,
                &adapters,
                caller.clone(),
                EvidenceActor {
                    actor_type: "AUTOMATION",
                    actor_id: fixture.principal,
                    automation_job_id: Some(job),
                    lease: Some(lease),
                },
                fixture.incident,
                request,
            );
            let verdict = insert_verdict(
                &pool,
                caller,
                fixture.incident,
                CreateVerdictRequest {
                    verdict: "CONFIRMED".into(),
                    rationale: "the committed measurement supports the conclusion".into(),
                },
            );
            let (evidence, verdict) = tokio::join!(evidence, verdict);
            evidence.expect("the automation evidence write is serializable");
            let rows = evidence_rows(&pool, fixture.incident).await;
            assert_eq!(rows.len(), 1, "one evidence row in every serial order");
            match verdict {
                Ok(verdict) => {
                    successes += 1;
                    assert_eq!(
                        verdict.considered_evidence_count, 1,
                        "a successful verdict must weigh the evidence that committed first"
                    );
                }
                Err(error) => {
                    assert_eq!(
                        error.code, "INCIDENT_EVIDENCE_REQUIRED",
                        "a verdict that locked first has no evidence to confirm: {error:?}"
                    );
                    let has_verdict: Option<Uuid> = sqlx::query_scalar(
                        "SELECT incident_id FROM kernel.incident_verdicts WHERE incident_id=$1",
                    )
                    .bind(fixture.incident)
                    .fetch_optional(&pool)
                    .await
                    .unwrap();
                    assert!(has_verdict.is_none());
                }
            }
            cleanup(&pool, &fixture).await;
        }
        // Both orders are legal; the invariant above holds in each. At least one
        // interleaving must have produced a verdict, or the test proved nothing.
        assert!(
            successes > 0,
            "the race never exercised the verdict-success path"
        );
    }

    /// A worker whose lease expired - even if nobody took over - must not
    /// create a new effect. The evidence transaction checks the grant itself.
    #[tokio::test]
    async fn an_expired_lease_cannot_create_an_evidence_effect() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let mut fixture = seed(&pool, false).await;
        let (_job, lease) = add_job(&pool, &mut fixture).await;
        sqlx::query(
            "UPDATE kernel.automation_jobs
                SET lease_until=now()-interval '1 second' WHERE job_id=$1",
        )
        .bind(lease.job_id)
        .execute(&pool)
        .await
        .unwrap();
        let state = state(pool.clone()).await;
        let error = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[21]}"#, Utc::now()),
            lease,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "AUTOMATION_STALE_LEASE", "{error:?}");
        assert!(evidence_rows(&pool, fixture.incident).await.is_empty());

        cleanup(&pool, &fixture).await;
    }

    /// A worker whose generation was superseded cannot write the effect, while
    /// the current generation can - and exactly one row exists afterwards.
    #[tokio::test]
    async fn a_superseded_worker_cannot_create_the_effect_but_the_new_one_can() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let mut fixture = seed(&pool, false).await;
        let (_job, old_lease) = add_job(&pool, &mut fixture).await;
        let new_lease = AutomationLeaseHandle {
            job_id: old_lease.job_id,
            lease_id: Uuid::new_v4(),
            fencing_token: old_lease.fencing_token + 1,
        };
        sqlx::query(
            "UPDATE kernel.automation_jobs
                SET lease_id=$2, fencing_token=$3, lease_owner='new-worker',
                    lease_until=now()+interval '5 minutes', attempts=attempts+1
              WHERE job_id=$1",
        )
        .bind(new_lease.job_id)
        .bind(new_lease.lease_id)
        .bind(new_lease.fencing_token)
        .execute(&pool)
        .await
        .unwrap();
        let state = state(pool.clone()).await;

        let stale = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[22]}"#, Utc::now()),
            old_lease,
        )
        .await
        .unwrap_err();
        assert_eq!(stale.code, "AUTOMATION_STALE_LEASE", "{stale:?}");
        assert!(evidence_rows(&pool, fixture.incident).await.is_empty());

        let committed = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[23]}"#, Utc::now()),
            new_lease,
        )
        .await
        .unwrap();
        assert_eq!(evidence_rows(&pool, fixture.incident).await.len(), 1);
        assert_eq!(
            committed_automation_evidence(&pool, new_lease.job_id)
                .await
                .unwrap(),
            Some(committed)
        );

        cleanup(&pool, &fixture).await;
    }

    /// Old and new generation racing to write the same job: the database admits
    /// only the live grant, and the effect stays one row.
    #[tokio::test]
    async fn old_and_new_generations_racing_write_one_effect() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let mut fixture = seed(&pool, false).await;
        let (_job, old_lease) = add_job(&pool, &mut fixture).await;
        let new_lease = AutomationLeaseHandle {
            job_id: old_lease.job_id,
            lease_id: Uuid::new_v4(),
            fencing_token: old_lease.fencing_token + 1,
        };
        sqlx::query(
            "UPDATE kernel.automation_jobs
                SET lease_id=$2, fencing_token=$3, lease_owner='new-worker',
                    lease_until=now()+interval '5 minutes', attempts=attempts+1
              WHERE job_id=$1",
        )
        .bind(new_lease.job_id)
        .bind(new_lease.lease_id)
        .bind(new_lease.fencing_token)
        .execute(&pool)
        .await
        .unwrap();
        let state = state(pool.clone()).await;
        let stale = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[24]}"#, Utc::now()),
            old_lease,
        );
        let live = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[25]}"#, Utc::now()),
            new_lease,
        );
        let (stale, live) = tokio::join!(stale, live);
        assert_eq!(
            stale.unwrap_err().code,
            "AUTOMATION_STALE_LEASE",
            "the old generation is refused"
        );
        let live = live.expect("the live generation writes the effect");
        assert_eq!(
            committed_automation_evidence(&pool, new_lease.job_id)
                .await
                .unwrap(),
            Some(live)
        );
        assert_eq!(evidence_rows(&pool, fixture.incident).await.len(), 1);

        cleanup(&pool, &fixture).await;
    }

    fn adapters_map() -> HashMap<String, String> {
        let mut map = HashMap::new();
        map.insert(ADAPTER.to_string(), SECRET.to_string());
        map
    }

    #[tokio::test]
    async fn a_job_binds_one_evidence_and_a_retry_returns_it_unchanged() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let mut fixture = seed(&pool, false).await;
        let (job, lease) = add_job(&pool, &mut fixture).await;
        let state = state(pool.clone()).await;
        let first_at = Utc::now() - chrono::Duration::seconds(10);
        let retry_at = Utc::now();

        let first = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[1]}"#, first_at),
            lease,
        )
        .await
        .unwrap();
        // The retry collects DIFFERENT bytes (a new sampling window); the job's
        // effect identity must still return the first committed row.
        let second = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[2]}"#, retry_at),
            lease,
        )
        .await
        .unwrap();
        assert_eq!(first, second, "one job, one evidence id");
        let rows = evidence_rows(&pool, fixture.incident).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, first);
        assert_eq!(rows[0].1, Some(job));
        let first_ref = format!(
            "sha256:{}",
            hex::encode(Sha256::digest(br#"{"samples":[1]}"#))
        );
        assert_eq!(
            rows[0].2, first_ref,
            "the committed original must not be replaced by the retry's bytes"
        );
        assert_eq!(
            committed_automation_evidence(&pool, job).await.unwrap(),
            Some(first)
        );

        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn different_jobs_with_identical_content_are_two_rows() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let mut fixture = seed(&pool, false).await;
        let (first_job, first_lease) = add_job(&pool, &mut fixture).await;
        let (second_job, second_lease) = add_job(&pool, &mut fixture).await;
        let state = state(pool.clone()).await;
        let at = Utc::now();
        let body = r#"{"samples":[42]}"#;

        let first = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, body, at),
            first_lease,
        )
        .await
        .unwrap();
        let second = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, body, at),
            second_lease,
        )
        .await
        .unwrap();
        assert_ne!(first, second, "two effects, two rows");
        let rows = evidence_rows(&pool, fixture.incident).await;
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|(id, job, _)| *id == first && *job == Some(first_job)));
        assert!(rows
            .iter()
            .any(|(id, job, _)| *id == second && *job == Some(second_job)));

        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn concurrent_attempts_of_one_job_commit_one_row() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let mut fixture = seed(&pool, false).await;
        let (_job, lease) = add_job(&pool, &mut fixture).await;
        let state = state(pool.clone()).await;
        let at = Utc::now();
        let left = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[1]}"#, at),
            lease,
        );
        let right = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[2]}"#, at),
            lease,
        );
        let (left, right) = tokio::join!(left, right);
        let left = left.unwrap();
        let right = right.unwrap();
        assert_eq!(left, right, "the loser reads the winner's committed effect");
        assert_eq!(evidence_rows(&pool, fixture.incident).await.len(), 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM kernel.audit_events
                  WHERE event_type='INCIDENT_EVIDENCE_ADDED' AND subject_id=$1"
            )
            .bind(fixture.incident.to_string())
            .fetch_one(&pool)
            .await
            .unwrap(),
            1,
            "one committed effect, one audit row"
        );

        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn recovery_returns_the_receipt_without_any_plugin_route() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let mut fixture = seed(&pool, false).await;
        let (_job, lease) = add_job(&pool, &mut fixture).await;
        let state = state(pool.clone()).await;
        let committed = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[7]}"#, Utc::now()),
            lease,
        )
        .await
        .unwrap();

        // There is no node, instance or route in this fixture. If the recovery
        // path called the plugin it would fail with AUTOMATION_INSTANCE_UNAVAILABLE;
        // returning the committed id proves the receipt was checked first.
        let run = crate::automation_flow::collect_and_append(
            &state,
            &principal(&fixture),
            fixture.incident,
            fixture.source,
            Utc::now(),
            lease,
        )
        .await
        .expect("recovery must not need an upstream");
        assert!(run.recovered);
        assert_eq!(run.evidence_id, Some(committed));
        assert_eq!(evidence_rows(&pool, fixture.incident).await.len(), 1);

        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn a_concluded_incident_still_returns_an_effect_that_already_committed() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let mut fixture = seed(&pool, false).await;
        let (_job, lease) = add_job(&pool, &mut fixture).await;
        let state = state(pool.clone()).await;
        let committed = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[9]}"#, Utc::now()),
            lease,
        )
        .await
        .unwrap();
        // The verdict lands while the job's success is still unconfirmed.
        sqlx::query(
            "INSERT INTO kernel.incident_verdicts (incident_id,verdict,rationale,decided_by)
             VALUES ($1,'CONFIRMED','concluded after the evidence committed',$2)",
        )
        .bind(fixture.incident)
        .bind(Uuid::parse_str(crate::automation::AUTOMATION_USER_ID).unwrap())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE kernel.incidents SET status='CONCLUDED' WHERE incident_id=$1")
            .bind(fixture.incident)
            .execute(&pool)
            .await
            .unwrap();

        let recovered = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[10]}"#, Utc::now()),
            lease,
        )
        .await
        .unwrap();
        assert_eq!(recovered, committed, "the committed effect is returned");
        assert_eq!(
            evidence_rows(&pool, fixture.incident).await.len(),
            1,
            "a concluded incident takes no new evidence"
        );

        // A DIFFERENT job cannot add evidence after the verdict.
        let (_late_job, late_lease) = add_job(&pool, &mut fixture).await;
        let rejected = append_automation_evidence(
            &state,
            fixture.principal,
            fixture.workspace,
            fixture.incident,
            automation_evidence(&fixture, r#"{"samples":[11]}"#, Utc::now()),
            late_lease,
        )
        .await
        .unwrap_err();
        assert_eq!(rejected.code, "INCIDENT_ALREADY_CONCLUDED", "{rejected:?}");
        assert_eq!(evidence_rows(&pool, fixture.incident).await.len(), 1);

        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn human_evidence_keeps_its_old_tuple_dedup_and_no_job_binding() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let fixture = seed(&pool, false).await;
        let user = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.users (id,email,display_name,password_hash,role)
             VALUES ($1,$2,'effect human','not-a-real-hash','operator')",
        )
        .bind(user)
        .bind(format!("effect-{user}@example.invalid"))
        .execute(&pool)
        .await
        .unwrap();
        let caller = DataScope::for_test(user, vec![fixture.workspace], RowRule::AllRows);
        let actor = EvidenceActor {
            actor_type: "USER",
            actor_id: user,
            automation_job_id: None,
            lease: None,
        };
        let (created, first) = insert_evidence_as(
            &pool,
            &HashMap::new(),
            caller.clone(),
            actor,
            fixture.incident,
            human_evidence_request("sha256:human-once"),
        )
        .await
        .unwrap();
        assert!(created);
        let (created_again, second) = insert_evidence_as(
            &pool,
            &HashMap::new(),
            caller,
            actor,
            fixture.incident,
            human_evidence_request("sha256:human-once"),
        )
        .await
        .unwrap();
        assert!(!created_again, "the historical tuple dedup still applies");
        assert_eq!(second.evidence_id, first.evidence_id);
        let rows = evidence_rows(&pool, fixture.incident).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, None, "a human row carries no job binding");

        // The incident still references this account (`owner`), and evidence
        // references it as `submitted_by`; remove the business rows first, then
        // the account, so cleanup cannot silently leave the user behind.
        cleanup(&pool, &fixture).await;
        sqlx::query("DELETE FROM kernel.users WHERE id=$1")
            .bind(user)
            .execute(&pool)
            .await
            .expect("test cleanup must remove the fixture account");
    }
}
