mod tests {
    use super::*;
    use sqlx::postgres::PgConnectOptions;

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
                other => panic!(
                    "{REQUIRE_DATABASE_ENV} is set to {other:?}: use 1 to require the DB-backed tests"
                ),
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
        .bind(format!("investigation-test-{id}@example.invalid"))
        .bind(format!("investigation test {role}"))
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
        // Since D5 an account reads a business row only through workspace membership, and
        // a tool call re-reads that membership per call. A fixture without this row would
        // be proving the tool refuses everything, which is not what these tests are about.
        join_workspace(pool, crate::scope::legacy_workspace(), id).await;
        id
    }

    async fn join_workspace(pool: &PgPool, workspace: Uuid, user: Uuid) {
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

    async fn seed_incident(
        pool: &PgPool,
        owner: Uuid,
        related_entity: Option<&str>,
        started_at: DateTime<Utc>,
    ) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incidents
                 (incident_id,title,severity,status,source,related_entity,started_at,owner,
                  workspace_id)
             VALUES ($1,$2,'MAJOR','OPEN','MANUAL',$3,$4,$5,$6)",
        )
        .bind(id)
        .bind(format!("investigation test incident {id}"))
        .bind(related_entity)
        .bind(started_at)
        .bind(owner)
        .bind(crate::scope::legacy_workspace())
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed_evidence(
        pool: &PgPool,
        incident_id: Uuid,
        collected_at: DateTime<Utc>,
        kind: &str,
        source: &str,
        verified_trust: &str,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let (method, verified_at, verifier) = match verified_trust {
            "SOURCE_ATTESTED" => (
                "SOURCE_ADAPTER",
                Some(collected_at),
                Some("test-adapter".to_string()),
            ),
            "OPERATOR_ASSERTED" => ("OPERATOR_IDENTITY", Some(collected_at), None),
            _ => ("NONE", None, None),
        };
        sqlx::query(
            "INSERT INTO kernel.incident_evidence
                 (evidence_id, incident_id, kind, source, collected_at, content_ref,
                  claimed_trust, verified_trust, verification_method, verified_at, verifier_identity)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        )
        .bind(id)
        .bind(incident_id)
        .bind(kind)
        .bind(source)
        .bind(collected_at)
        .bind(format!("test-ref-{id}"))
        .bind(verified_trust)
        .bind(verified_trust)
        .bind(method)
        .bind(verified_at)
        .bind(verifier)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed_run(pool: &PgPool, incident_id: Uuid, scope_user: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.investigation_runs
                 (run_id, incident_id, idempotency_key, status, provider_id, adapter_kind,
                  scope_user_id, requested_by, max_steps, max_tool_calls, tool_timeout_ms,
                  max_retries, token_budget, deadline_at)
             VALUES ($1,$2,$3,'RUNNING','test-fixture-v1','TEST_FIXTURE',$4,$4,8,12,2000,1,20000,now() + interval '30 seconds')",
        )
        .bind(id)
        .bind(incident_id)
        .bind(format!("test-key-{id}"))
        .bind(scope_user)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn seed_hypothesis(pool: &PgPool, run_id: Uuid) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.investigation_hypotheses
                 (hypothesis_id, run_id, ordinal, statement, stance, confidence, reasoning,
                  adapter_kind)
             VALUES ($1,$2,1,'a test hypothesis about the record','SUPPORTED','LOW',
                     'a test reasoning sentence','TEST_FIXTURE')",
        )
        .bind(id)
        .bind(run_id)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    /// Order matters, and the order is a fact about the schema rather than a test
    /// detail: a citation of an evidence row is ON DELETE RESTRICT (as the 0017 verdict
    /// snapshot is), so an incident cannot be deleted while a hypothesis still cites its
    /// evidence. Deleting the runs first cascades hypotheses and citations away, which is
    /// what lets the incident go.
    async fn cleanup(pool: &PgPool, users: &[Uuid]) {
        for user in users {
            let _ = sqlx::query(
                "DELETE FROM kernel.investigation_runs
                  WHERE scope_user_id=$1 OR requested_by=$1
                     OR incident_id IN (SELECT incident_id FROM kernel.incidents WHERE owner=$1)",
            )
            .bind(user)
            .execute(pool)
            .await;
            let _ = sqlx::query("DELETE FROM kernel.incidents WHERE owner=$1")
                .bind(user)
                .execute(pool)
                .await;
            let _ = sqlx::query("DELETE FROM kernel.users WHERE id=$1")
                .bind(user)
                .execute(pool)
                .await;
        }
    }

    // -----------------------------------------------------------------------
    // E4: the three protocol cases, from three states of real data.
    // -----------------------------------------------------------------------

    fn transcript_with(
        incident_started: DateTime<Utc>,
        rows: &[(Uuid, DateTime<Utc>, &str)],
    ) -> Transcript {
        Transcript {
            incident: Some(json!({
                "incidentId": Uuid::new_v4(),
                "title": "a test incident",
                "startedAt": incident_started,
            })),
            evidence: rows
                .iter()
                .map(|(id, collected, trust)| {
                    json!({
                        "evidenceId": id,
                        "kind": "LOG_EXCERPT",
                        "collectedAt": collected,
                        "verifiedTrust": trust,
                    })
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn the_fixture_is_deterministic() {
        let started = DateTime::parse_from_rfc3339("2026-10-01T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let rows = [(
            Uuid::new_v4(),
            started + ChronoDuration::minutes(5),
            "OPERATOR_ASSERTED",
        )];
        let a = transcript_with(started, &rows);
        let b = transcript_with(started, &rows);
        let first = fixture_hypothesis(&a);
        let second = fixture_hypothesis(&b);
        assert_eq!(first.stance, second.stance);
        assert_eq!(first.statement, second.statement);
        assert_eq!(first.supporting, second.supporting);
        assert_eq!(first.confidence, second.confidence);
    }

    /// D3: the model protocol, against the closed vocabularies it claims to enforce.
    ///
    /// `parse_model_decision` decides what a model is allowed to have said before any of it
    /// touches a row. It had no test of its own - the acceptance script drives the FIXTURE, so
    /// every assertion about a real model's shape was an assertion about code no run had taken.
    /// These are pure: no database, no network, no credential.
    mod model_protocol {
        use super::super::*;

        fn final_with(hypotheses: Value) -> Value {
            json!({ "action": "FINAL", "hypotheses": hypotheses })
        }

        fn hypothesis(stance: &str, confidence: &str) -> Value {
            json!({
                "statement": "a statement long enough to be stored",
                "stance": stance,
                "confidence": confidence,
                "reasoning": "because the rows say so",
            })
        }

        #[test]
        fn valid_final_is_accepted_and_keeps_what_the_model_said() {
            let decision =
                parse_model_decision(&final_with(json!([hypothesis("SUPPORTED", "HIGH")])))
                    .expect("a well-formed FINAL is accepted");
            let ModelDecision::Final { hypotheses } = decision else {
                panic!("a FINAL action must parse to Final");
            };
            assert_eq!(hypotheses.len(), 1);
            assert_eq!(hypotheses[0].stance, "SUPPORTED");
            assert_eq!(hypotheses[0].confidence, "HIGH");
            assert_eq!(hypotheses[0].reasoning, "because the rows say so");
        }

        #[test]
        fn invalid_json_shape_is_refused_with_a_stable_code() {
            for body in [
                json!({}),
                json!({ "action": "THINK" }),
                json!({ "action": "FINAL" }),
                json!({ "action": "FINAL", "hypotheses": "not an array" }),
                json!({ "action": "TOOL_CALL" }),
                json!("a bare string"),
            ] {
                let failure =
                    parse_model_decision(&body).expect_err(&format!("{body} must be refused"));
                assert_eq!(failure.code, "MODEL_RESPONSE_INVALID", "for {body}");
            }
        }

        #[test]
        fn a_stance_or_confidence_outside_the_closed_set_is_refused_not_coerced() {
            // The property that matters: the answer is refused, never mapped to the nearest
            // legal value. A coerced stance would put words in the model's mouth.
            for (stance, confidence) in [
                ("CONFIRMED", "HIGH"), // the human verdict's vocabulary
                ("SUPPORTED", "CERTAIN"),
                ("PROBABLY", "HIGH"),
                ("", ""),
            ] {
                let failure =
                    parse_model_decision(&final_with(json!([hypothesis(stance, confidence)])))
                        .expect_err(&format!("{stance}/{confidence} must be refused"));
                assert_eq!(failure.code, "MODEL_RESPONSE_INVALID");
                assert!(
                    failure.message.contains("STANCES")
                        || failure.message.contains("stance must be"),
                    "the message names the closed set, got: {}",
                    failure.message
                );
            }
        }

        #[test]
        fn an_empty_hypothesis_array_parses_and_is_the_callers_problem() {
            // The parser is not where silence is refused - it reports faithfully that the model
            // said FINAL with nothing. `final_answer_outcome` is what turns that into FAILED,
            // and keeping the two apart is what lets the run record the model's actual answer.
            let decision =
                parse_model_decision(&final_with(json!([]))).expect("an empty FINAL parses");
            let ModelDecision::Final { hypotheses } = decision else {
                panic!("expected Final");
            };
            assert!(hypotheses.is_empty());
        }

        #[test]
        fn more_hypotheses_than_the_cap_are_truncated_not_refused() {
            let many: Vec<Value> = (0..TOOL_HYPOTHESIS_MAX + 3)
                .map(|_| hypothesis("UNCERTAIN", "LOW"))
                .collect();
            let decision =
                parse_model_decision(&final_with(json!(many))).expect("over-cap truncates");
            let ModelDecision::Final { hypotheses } = decision else {
                panic!("expected Final");
            };
            assert_eq!(hypotheses.len(), TOOL_HYPOTHESIS_MAX);
        }

        #[test]
        fn citations_are_parsed_as_uuids_and_junk_is_dropped_not_guessed() {
            let mut item = hypothesis("SUPPORTED", "MEDIUM");
            let real = Uuid::new_v4();
            item["supportingEvidence"] = json!([real.to_string(), "not-a-uuid", 42]);
            item["contradictingEvidence"] = json!(["also-not-a-uuid"]);
            let ModelDecision::Final { hypotheses } =
                parse_model_decision(&final_with(json!([item]))).expect("parses")
            else {
                panic!("expected Final");
            };
            assert_eq!(
                hypotheses[0].supporting,
                vec![real],
                "only the parseable id survives"
            );
            assert!(hypotheses[0].contradicting.is_empty());
        }

        #[test]
        fn a_tool_call_may_be_anything_and_the_executor_is_what_refuses_it() {
            // Deliberate split: the parser does not own the tool allowlist. A name outside
            // TOOL_NAMES parses, and `execute_tool` refuses it with PRE_PREDICATE_TOOL_ALLOWLIST
            // before any query - measured in the acceptance script (S4/S8) and in
            // `a_tool_the_investigator_invented_is_not_in_the_catalogue`. Naming that here keeps
            // a future reader from adding a second allowlist to this function.
            let decision = parse_model_decision(&json!({
                "action": "TOOL_CALL",
                "tool": "run_shell",
                "arguments": { "cmd": "rm -rf /" },
            }))
            .expect("the parser accepts the shape");
            let ModelDecision::ToolCall { tool, .. } = decision else {
                panic!("expected ToolCall");
            };
            assert_eq!(tool, "run_shell");
            assert!(
                !TOOL_NAMES.contains(&tool.as_str()),
                "and it is not in the catalogue"
            );
        }

        #[test]
        fn arguments_default_to_an_empty_object() {
            let ModelDecision::ToolCall { arguments, .. } =
                parse_model_decision(&json!({ "action": "TOOL_CALL", "tool": "get_incident" }))
                    .expect("parses")
            else {
                panic!("expected ToolCall");
            };
            assert_eq!(arguments, json!({}));
        }
    }

    /// D1: a FINAL answer that states nothing is not a successful diagnosis.
    ///
    /// The four cases the brief names, as four rows of one table, because they are one
    /// decision seen from four sides and a separate test per row would let three pass while
    /// the fourth regressed.
    #[test]
    fn a_final_answer_is_judged_by_what_it_stated_and_what_it_read() {
        // (hypotheses stored, a read failed, expected status, whether a reason is required)
        let cases: [(i64, bool, &str, bool); 4] = [
            // A normal conclusion on clean reads.
            (1, false, "SUCCEEDED", false),
            // A conclusion that had to stand on a read that was refused or failed.
            (1, true, "PARTIAL", true),
            // The defect this closes: silent FINAL with clean reads used to be SUCCEEDED.
            (0, false, "FAILED", true),
            // Silent FINAL over failed reads is still FAILED: there is nothing to be partial
            // about. PARTIAL means "here is a conclusion, it is incomplete", and a run with no
            // conclusion has none to qualify.
            (0, true, "FAILED", true),
        ];
        for (written, any_failed, status, needs_detail) in cases {
            let (actual, detail) = final_answer_outcome(written, any_failed);
            assert_eq!(
                actual, status,
                "{written} hypothesis(es), any_failed={any_failed}: got {actual}, expected {status}"
            );
            assert_eq!(
                detail.is_some(),
                needs_detail,
                "{status}: the detail sentence must be present exactly when the run did not simply answer"
            );
            if let Some(detail) = detail {
                assert!(
                    detail.chars().count() >= 4,
                    "the schema requires a detail of at least 4 characters"
                );
            }
        }
    }

    /// A run with no evidence is NOT the silent case: it states an UNCERTAIN hypothesis, which
    /// is a real conclusion about the record. This keeps a future reader from "fixing" the test
    /// above by requiring evidence for every run.
    #[test]
    fn no_evidence_still_counts_as_a_stated_hypothesis() {
        let started = Utc::now();
        let stated = fixture_hypothesis(&transcript_with(started, &[]));
        assert_eq!(stated.stance, "UNCERTAIN");
        // `written_hypotheses` counts rows, and a row was written: the run is not silent.
        let (status, _) = final_answer_outcome(1, false);
        assert_eq!(status, "SUCCEEDED");
    }

    #[test]
    fn no_evidence_is_uncertainty_with_a_gap_and_no_citation() {
        let started = Utc::now();
        let transcript = transcript_with(started, &[]);
        let hypothesis = fixture_hypothesis(&transcript);
        assert_eq!(hypothesis.stance, "UNCERTAIN");
        assert_eq!(hypothesis.confidence, "LOW");
        assert!(hypothesis.supporting.is_empty());
        assert!(hypothesis.contradicting.is_empty());
        assert_eq!(hypothesis.gap_codes, vec!["NO_EVIDENCE_ROWS".to_string()]);
        assert!(hypothesis
            .uncertainty
            .as_deref()
            .unwrap()
            .contains("neither the timing nor the cause"));
    }

    #[test]
    fn a_refused_read_is_uncertainty_that_names_the_refusal() {
        let started = Utc::now();
        let mut transcript = transcript_with(started, &[]);
        transcript.refused = true;
        let hypothesis = fixture_hypothesis(&transcript);
        assert_eq!(hypothesis.stance, "UNCERTAIN");
        assert_eq!(hypothesis.gap_codes, vec!["TOOL_REFUSED".to_string()]);
    }

    #[test]
    fn a_row_collected_before_the_start_is_cited_as_a_contradiction() {
        let started = DateTime::parse_from_rfc3339("2026-10-01T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let early = Uuid::new_v4();
        let late = Uuid::new_v4();
        let rows = [
            (
                early,
                started - ChronoDuration::hours(2),
                "OPERATOR_ASSERTED",
            ),
            (
                late,
                started + ChronoDuration::minutes(3),
                "OPERATOR_ASSERTED",
            ),
        ];
        let hypothesis = fixture_hypothesis(&transcript_with(started, &rows));
        assert_eq!(hypothesis.stance, "CONFLICTED");
        assert_eq!(hypothesis.contradicting, vec![early]);
        assert_eq!(hypothesis.supporting, vec![late]);
        assert_eq!(
            hypothesis.gap_codes,
            vec!["EVIDENCE_PREDATES_INCIDENT".to_string()]
        );
    }

    #[test]
    fn rows_at_or_after_the_start_support_without_claiming_a_verdict() {
        let started = Utc::now();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let rows = [
            (first, started, "OPERATOR_ASSERTED"),
            (
                second,
                started + ChronoDuration::minutes(1),
                "SOURCE_ATTESTED",
            ),
        ];
        let hypothesis = fixture_hypothesis(&transcript_with(started, &rows));
        assert_eq!(hypothesis.stance, "SUPPORTED");
        assert_eq!(hypothesis.confidence, "HIGH");
        assert_eq!(hypothesis.supporting, vec![first, second]);
        assert!(hypothesis.contradicting.is_empty());
        assert!(hypothesis.gap_codes.is_empty());
        // The words a human verdict uses are not reachable from a hypothesis.
        for verdict_word in ["CONFIRMED", "REFUTED", "INCONCLUSIVE"] {
            assert_ne!(hypothesis.stance, verdict_word);
        }
    }

    #[test]
    fn unverified_rows_lower_confidence_and_are_named() {
        let started = Utc::now();
        let row = Uuid::new_v4();
        let hypothesis =
            fixture_hypothesis(&transcript_with(started, &[(row, started, "UNVERIFIED")]));
        assert_eq!(hypothesis.stance, "SUPPORTED");
        assert_eq!(hypothesis.confidence, "MEDIUM");
        assert_eq!(
            hypothesis.gap_codes,
            vec!["EVIDENCE_UNVERIFIED".to_string()]
        );
    }

    // -----------------------------------------------------------------------
    // G12 H (P1): the scope of an investigation is the run's incident, not the caller's
    // reach.
    //
    // The defect these close: the five tools authorized a foreign incidentId against the
    // CALLER's read predicate, so an account that could read incident C could make a run
    // about incident A read C. Nothing refused that until the citation guard did, and the
    // guard's refusal arrived as 500 INTERNAL. One account that owns both incidents is the
    // only shape that can tell the two rules apart: for that account the predicate below
    // would allow every read, so only the run's own scope stands in the way.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn every_tool_refuses_an_incident_the_run_is_not_about() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "admin").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let mine = seed_incident(&pool, owner, Some("entity-mine"), started).await;
        let other = seed_incident(&pool, owner, Some("entity-other"), started).await;
        let other_evidence =
            seed_evidence(&pool, other, started, "LOG_EXCERPT", "agent", "UNVERIFIED").await;
        let scope = ToolScope {
            incident_id: mine,
            scope_user_id: owner,
        };
        let sources = vec!["incident_index".to_string()];

        // Positive controls first: the run's own incident reads whether the id is omitted
        // or restated, so the refusals below are about scope and not about a broken
        // fixture or a blanket refusal of the argument.
        for arguments in [json!({}), json!({ "incidentId": mine })] {
            let own = execute_tool(&pool, &sources, scope, TOOL_GET_INCIDENT, &arguments)
                .await
                .expect("the run's own incident must read");
            assert_eq!(own.predicate, PREDICATE_INCIDENT_READ);
        }

        let attempts: Vec<(&str, Value)> = vec![
            (TOOL_GET_INCIDENT, json!({ "incidentId": other })),
            (TOOL_LIST_EVIDENCE, json!({ "incidentId": other })),
            (
                TOOL_READ_EVIDENCE,
                json!({ "incidentId": other, "evidenceId": other_evidence }),
            ),
            (TOOL_GET_TIMELINE, json!({ "incidentId": other })),
            (
                TOOL_GET_RELATED,
                json!({ "incidentId": other, "sourceId": "incident_index" }),
            ),
        ];
        assert_eq!(attempts.len(), 5, "all five tools must be covered");
        for (tool, arguments) in attempts {
            let failure = execute_tool(&pool, &sources, scope, tool, &arguments)
                .await
                .err()
                .unwrap_or_else(|| {
                    panic!("{tool} read an incident this investigation is not about")
                });
            assert_eq!(
                failure.outcome, "REFUSED",
                "{tool} must be refused, not broken"
            );
            // The stable code the HTTP path reports instead of a 500, and the layer that
            // refused it. Both are asserted here so neither can drift alone.
            assert_eq!(
                failure.code, "INCIDENT_OUT_OF_SCOPE",
                "{tool} must carry the stable scope code"
            );
            assert_eq!(
                failure.gate, PREDICATE_RUN_INCIDENT_SCOPE,
                "{tool} must name the layer that refused it"
            );
        }

        cleanup(&pool, &[owner]).await;
    }

    // -----------------------------------------------------------------------
    // G12 H (P2): a refused invocation records the layer that refused it.
    //
    // The column was NULL for every non-OK row, so the panel could show the error code and
    // never the layer. Each gate below is a place in this file that actually decided; none
    // of them is invented, and the one layer that is genuinely a predicate answering is
    // asserted through a read the caller is no longer allowed to do.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn every_refusal_names_the_layer_that_refused_it() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let successor = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let mine = seed_incident(&pool, owner, None, started).await;
        let other = seed_incident(&pool, owner, None, started).await;
        let scope = ToolScope {
            incident_id: mine,
            scope_user_id: owner,
        };

        let cases: Vec<(&str, Value, &str, &str)> = vec![
            (
                "run_shell",
                json!({}),
                GATE_PRE_TOOL_ALLOWLIST,
                "TOOL_NOT_AVAILABLE",
            ),
            (
                TOOL_GET_INCIDENT,
                json!({ "incidentId": "not-a-uuid" }),
                GATE_PRE_ARGUMENT,
                "TOOL_ARGUMENT_INVALID",
            ),
            (
                TOOL_GET_INCIDENT,
                json!({ "incidentId": other }),
                PREDICATE_RUN_INCIDENT_SCOPE,
                "INCIDENT_OUT_OF_SCOPE",
            ),
            (
                TOOL_GET_RELATED,
                json!({ "sourceId": "incident_index" }),
                GATE_SOURCE_CONFIGURATION,
                "SOURCE_UNAVAILABLE",
            ),
        ];
        for (tool, arguments, gate, code) in cases {
            let failure = execute_tool(&pool, &[], scope, tool, &arguments)
                .await
                .err()
                .unwrap_or_else(|| panic!("{tool} must refuse {code}"));
            assert_eq!(failure.code, code, "{tool} must keep its own stable code");
            assert_eq!(failure.gate, gate, "{code} must name its own layer");
        }

        // The scope account itself cannot be resolved: refused before any predicate runs.
        let unresolvable = ToolScope {
            incident_id: mine,
            scope_user_id: Uuid::new_v4(),
        };
        let failure = execute_tool(&pool, &[], unresolvable, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect_err("an account that does not exist must not read");
        assert_eq!(failure.gate, GATE_PRE_SCOPE_IDENTITY);

        // And the case that IS a predicate answering: the run's own incident handed to
        // somebody else. The code is the HTTP read's own (not yours and not there are one
        // answer) and the gate is the predicate that said so.
        sqlx::query("UPDATE kernel.incidents SET owner=$2 WHERE incident_id=$1")
            .bind(mine)
            .bind(successor)
            .execute(&pool)
            .await
            .unwrap();
        let failure = execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect_err("a handed-over incident must not read");
        assert_eq!(failure.code, "INCIDENT_NOT_FOUND");
        assert_eq!(failure.gate, PREDICATE_INCIDENT_READ);

        cleanup(&pool, &[owner, successor]).await;
    }

    // -----------------------------------------------------------------------
    // G12 H (P1), the residual half: the guard's refusal is a definite code, not a 500.
    //
    // The tool layer now makes this unreachable through a read, but a real model can name
    // an evidence id it never read. That used to arrive as one '?', which the HTTP layer
    // reported as 500 INTERNAL and which left the run RUNNING with nobody to finish it.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_citation_the_database_refuses_is_a_named_refusal_and_writes_nothing() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let foreign_incident = seed_incident(&pool, owner, None, started).await;
        let foreign = seed_evidence(
            &pool,
            foreign_incident,
            started,
            "LOG_EXCERPT",
            "agent",
            "UNVERIFIED",
        )
        .await;
        let run = seed_run(&pool, incident, owner).await;
        let proposed = ProposedHypothesis {
            statement: "a conclusion that cites a row from another incident".to_string(),
            stance: "SUPPORTED".to_string(),
            confidence: "LOW".to_string(),
            reasoning: "the reasoning is not what is under test here".to_string(),
            uncertainty: None,
            gap_codes: Vec::new(),
            supporting: vec![foreign],
            contradicting: Vec::new(),
        };
        let refusal = record_hypothesis(&pool, run, 1, "TEST_FIXTURE", &proposed, &HashMap::new())
            .await
            .expect_err("the guard must refuse this citation");
        match refusal {
            HypothesisRefusal::CitationOutOfScope { evidence_id } => {
                assert_eq!(
                    evidence_id, foreign,
                    "the refusal names the citation it refused"
                )
            }
            HypothesisRefusal::Internal(error) => {
                panic!("a guard refusal must not arrive as an internal error: {error:?}")
            }
        }
        // The whole hypothesis rolled back with the citation: no half-written conclusion.
        let written: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.investigation_hypotheses WHERE run_id=$1",
        )
        .bind(run)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(written, 0, "a refused hypothesis must leave no row behind");

        cleanup(&pool, &[owner]).await;
    }

    // -----------------------------------------------------------------------
    // The closed vocabulary is in the database, not only in this file, so a future caller
    // cannot write a predicate string it made up (G12 H, P2: no invented predicates).
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn the_recorded_gate_vocabulary_matches_the_schema() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let definition: String = sqlx::query_scalar(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conname='investigation_invocation_predicate_vocabulary_check'",
        )
        .fetch_one(&pool)
        .await
        .expect("migration 0023 must have created the vocabulary constraint");
        for gate in GATE_VOCABULARY {
            assert!(
                definition.contains(gate),
                "the schema must accept {gate}: {definition}"
            );
        }
        // And a value outside the list is refused by the database itself.
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        let error = sqlx::query(
            "INSERT INTO kernel.investigation_tool_invocations
                 (invocation_id, run_id, sequence, attempt, tool_name, arguments, outcome,
                  error_code, authorization_predicate, started_at, finished_at, duration_ms)
             VALUES ($1,$2,1,1,'get_incident','{}'::jsonb,'OK',NULL,'A_PREDICATE_I_INVENTED',
                     now(), now(), 1)",
        )
        .bind(Uuid::new_v4())
        .bind(run)
        .execute(&pool)
        .await
        .expect_err("an invented predicate name must be refused by the schema");
        assert!(
            error
                .to_string()
                .contains("investigation_invocation_predicate_vocabulary_check")
                || error.to_string().contains("check constraint"),
            "expected the vocabulary check, got: {error}"
        );

        cleanup(&pool, &[owner]).await;
    }
    // -----------------------------------------------------------------------
    // E3: the per-tool timeout fires instead of hanging.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_tool_that_exceeds_its_timeout_is_reported_as_a_timeout() {
        let outcome = run_bounded(Duration::from_millis(20), async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok::<u8, ToolFailure>(1)
        })
        .await;
        let failure = outcome.expect_err("a slow read must not succeed");
        assert_eq!(failure.outcome, "TIMEOUT");
        assert_eq!(failure.code, "TOOL_TIMEOUT");
    }

    #[tokio::test]
    async fn a_fast_tool_passes_through_its_bound() {
        let outcome = run_bounded(Duration::from_secs(5), async { Ok::<u8, ToolFailure>(7) }).await;
        assert_eq!(outcome.ok(), Some(7));
    }

    #[test]
    fn truncation_cuts_characters_and_never_splits_one() {
        let body = "ab\u{1f600}cd";
        let (kept, truncated) = truncate_chars(body, 4);
        assert_eq!(kept, "ab\u{1f600}c");
        assert!(truncated);
        let (whole, nothing_dropped) = truncate_chars(body, 10);
        assert_eq!(whole, body);
        assert!(!nothing_dropped);
    }

    #[test]
    fn a_tool_the_investigator_invented_is_not_in_the_catalogue() {
        assert!(!TOOL_NAMES.contains(&"run_shell"));
        assert!(!TOOL_NAMES.contains(&"sql"));
        assert!(!TOOL_NAMES.contains(&"http_get"));
        assert_eq!(TOOL_NAMES.len(), 5);
        let catalog = tool_catalog();
        let names: Vec<&str> = catalog
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool.get("name").and_then(Value::as_str).unwrap())
            .collect();
        assert_eq!(names.len(), TOOL_NAMES.len());
        for name in TOOL_NAMES {
            assert!(names.contains(name), "the catalogue must publish {name}");
        }
    }

    // -----------------------------------------------------------------------
    // E2: the tool layer refuses every read of an incident another operator owns.
    //
    // One test over all five tools, because a per-tool test would let a new tool be
    // added without this refusal ever being asked of it.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn every_tool_refuses_an_incident_another_operator_owns() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let stranger = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let mine = seed_incident(&pool, owner, Some("entity-mine"), started).await;
        let theirs = seed_incident(&pool, stranger, Some("entity-theirs"), started).await;
        let their_evidence =
            seed_evidence(&pool, theirs, started, "LOG_EXCERPT", "agent", "UNVERIFIED").await;
        let scope = ToolScope {
            incident_id: mine,
            scope_user_id: owner,
        };
        let sources = vec!["incident_index".to_string()];

        // Positive control first: the tools must work on the incident the run owns, or
        // the refusals below would only prove that everything fails.
        let own = execute_tool(&pool, &sources, scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect("reading its own incident must work");
        assert_eq!(own.predicate, PREDICATE_INCIDENT_READ);

        let attempts: Vec<(&str, Value)> = vec![
            (TOOL_GET_INCIDENT, json!({ "incidentId": theirs })),
            (TOOL_LIST_EVIDENCE, json!({ "incidentId": theirs })),
            (
                TOOL_READ_EVIDENCE,
                json!({ "incidentId": theirs, "evidenceId": their_evidence }),
            ),
            (TOOL_GET_TIMELINE, json!({ "incidentId": theirs })),
            (
                TOOL_GET_RELATED,
                json!({ "incidentId": theirs, "sourceId": "incident_index" }),
            ),
        ];
        assert_eq!(attempts.len(), 5, "all five tools must be covered");
        for (tool, arguments) in attempts {
            let result = execute_tool(&pool, &sources, scope, tool, &arguments).await;
            let failure = result.err().unwrap_or_else(|| {
                panic!("{tool} read an incident another operator owns and did not refuse")
            });
            assert_eq!(
                failure.outcome, "REFUSED",
                "{tool} must be refused, not broken"
            );
            // G12 H (P1) moved this refusal EARLIER, not away: another operator's incident
            // is, first of all, an incident this run is not about, so the run's own scope
            // refuses it before the read predicate is asked. The specific refusal below is
            // asserted in every_refusal_names_the_layer_that_refused_it; here the point is
            // that no tool reaches the row.
            assert_eq!(
                failure.code, "INCIDENT_OUT_OF_SCOPE",
                "{tool} must refuse with the stable scope code, before any row is read"
            );
        }

        cleanup(&pool, &[owner, stranger]).await;
    }

    #[tokio::test]
    async fn an_evidence_id_from_another_incident_is_refused_even_with_the_right_incident() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let mine = seed_incident(&pool, owner, None, started).await;
        let other = seed_incident(&pool, owner, None, started).await;
        let other_evidence =
            seed_evidence(&pool, other, started, "LOG_EXCERPT", "agent", "UNVERIFIED").await;
        let scope = ToolScope {
            incident_id: mine,
            scope_user_id: owner,
        };
        let failure = execute_tool(
            &pool,
            &[],
            scope,
            TOOL_READ_EVIDENCE,
            &json!({ "incidentId": mine, "evidenceId": other_evidence }),
        )
        .await
        .expect_err("an evidence id from another incident must not read");
        assert_eq!(failure.code, "EVIDENCE_NOT_FOUND");
        assert_eq!(failure.outcome, "REFUSED");

        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn a_handover_mid_run_takes_the_next_read_away() {
        let Some(pool) = test_pool().await else {
            return;
        };
        // The scope account is re-read on every call, and the incident predicate is
        // applied again on every call. A handover between two calls is the cheapest way
        // to prove both at once: nothing about the run changes, and the second read is
        // refused.
        let owner = seed_user(&pool, "operator").await;
        let successor = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let scope = ToolScope {
            incident_id: incident,
            scope_user_id: owner,
        };
        execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect("the first read must work");
        sqlx::query("UPDATE kernel.incidents SET owner=$2 WHERE incident_id=$1")
            .bind(incident)
            .bind(successor)
            .execute(&pool)
            .await
            .unwrap();
        let failure = execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect_err("after the handover the former owner must not read it");
        assert_eq!(failure.code, "INCIDENT_NOT_FOUND");

        cleanup(&pool, &[owner, successor]).await;
    }

    /// The D5 counterpart of the handover test above: membership, not ownership, is what
    /// the next tool call answers with.
    ///
    /// A run's `scope_user_id` is fixed for its lifetime, but what that account may
    /// READ is not: `scope_caller` re-resolves the workspace set from the database at
    /// the instant of each call. So a membership revoked while a run is in flight takes the
    /// next read away, and nothing about the run has to be reloaded or cancelled for that
    /// to happen.
    #[tokio::test]
    async fn a_membership_revocation_mid_run_takes_the_next_read_away() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let scope = ToolScope {
            incident_id: incident,
            scope_user_id: owner,
        };
        execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect("the first read must work");
        // Exactly what DELETE /api/v1/business-workspaces/{id}/members/{user} writes.
        sqlx::query("DELETE FROM kernel.business_workspace_members WHERE user_id=$1")
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        let failure = execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect_err("after the revocation the next read must be refused");
        // The same 404 the HTTP route gives: "not yours" and "not there" are one answer.
        assert_eq!(failure.code, "INCIDENT_NOT_FOUND");

        cleanup(&pool, &[owner]).await;
    }

    /// An account that is a member of no workspace reads no business row through a tool,
    /// whatever its role - the case a viewer without a grant is in, and the reason the
    /// empty list is explained by a count rather than by silence.
    #[tokio::test]
    async fn a_tool_call_from_an_account_in_no_workspace_reads_nothing() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        sqlx::query("DELETE FROM kernel.business_workspace_members WHERE user_id=$1")
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        let scope = ToolScope {
            incident_id: incident,
            scope_user_id: owner,
        };
        let failure = execute_tool(&pool, &[], scope, TOOL_GET_INCIDENT, &json!({}))
            .await
            .expect_err("no membership means no readable business row");
        assert_eq!(failure.code, "INCIDENT_NOT_FOUND");

        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn the_related_context_source_must_be_authorised_before_anything_is_read() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, Some("shared-entity"), started).await;
        let scope = ToolScope {
            incident_id: incident,
            scope_user_id: owner,
        };
        // Nothing configured: the shipped posture.
        let failure = execute_tool(
            &pool,
            &[],
            scope,
            TOOL_GET_RELATED,
            &json!({ "sourceId": "incident_index" }),
        )
        .await
        .expect_err("an unauthorised source must refuse rather than answer an empty page");
        assert_eq!(failure.code, "SOURCE_UNAVAILABLE");
        assert_eq!(failure.outcome, "REFUSED");

        // Configured: it reads, and it reads only through the incident predicate.
        let sources = vec!["incident_index".to_string()];
        let outcome = execute_tool(
            &pool,
            &sources,
            scope,
            TOOL_GET_RELATED,
            &json!({ "sourceId": "incident_index" }),
        )
        .await
        .expect("an authorised source must read");
        assert_eq!(outcome.predicate, PREDICATE_INCIDENT_READ);
        assert_eq!(outcome.payload["relatedEntity"], json!("shared-entity"));

        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn the_incident_index_narrows_the_scope_and_never_widens_it() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let stranger = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        // Same relatedEntity, three incidents, two owners. The tool must return the two
        // the caller may read and neither of the stranger's.
        let mine = seed_incident(&pool, owner, Some("shared-component"), started).await;
        let peer = seed_incident(&pool, owner, Some("shared-component"), started).await;
        let theirs = seed_incident(&pool, stranger, Some("shared-component"), started).await;
        let sources = vec!["incident_index".to_string()];
        let scope = ToolScope {
            incident_id: mine,
            scope_user_id: owner,
        };
        let outcome = execute_tool(
            &pool,
            &sources,
            scope,
            TOOL_GET_RELATED,
            &json!({ "sourceId": "incident_index" }),
        )
        .await
        .expect("an authorised source must read");
        let ids: Vec<String> = outcome.payload["items"]
            .as_array()
            .expect("items must be an array")
            .iter()
            .filter_map(|item| item.get("incidentId").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        assert!(
            ids.contains(&mine.to_string()),
            "the incident itself must be in its own index page"
        );
        assert!(
            ids.contains(&peer.to_string()),
            "a peer incident of the same owner must be visible"
        );
        assert!(
            !ids.contains(&theirs.to_string()),
            "another operator's incident must not be reachable through the index"
        );
        cleanup(&pool, &[owner, stranger]).await;
    }

    #[tokio::test]
    async fn an_unknown_scope_account_cannot_be_substituted() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let failure = scope_caller(&pool, Uuid::new_v4())
            .await
            .expect_err("an account that does not exist must not become a caller");
        assert_eq!(failure.code, "SCOPE_IDENTITY_UNAVAILABLE");
        assert_eq!(failure.outcome, "REFUSED");
    }

    // -----------------------------------------------------------------------
    // The schema's own guarantees. These are the ones a handler cannot forget,
    // because they are enforced by the database the handler writes to.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_hypothesis_cannot_cite_evidence_from_another_incident() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let other = seed_incident(&pool, owner, None, started).await;
        let foreign_evidence =
            seed_evidence(&pool, other, started, "LOG_EXCERPT", "agent", "UNVERIFIED").await;
        let run = seed_run(&pool, incident, owner).await;
        let hypothesis = seed_hypothesis(&pool, run).await;
        let error = sqlx::query(
            "INSERT INTO kernel.investigation_hypothesis_evidence
                 (hypothesis_id, evidence_id, role) VALUES ($1,$2,'SUPPORTING')",
        )
        .bind(hypothesis)
        .bind(foreign_evidence)
        .execute(&pool)
        .await
        .expect_err("the database must refuse a citation of another incident's evidence");
        assert!(
            error.to_string().contains("cannot cite"),
            "expected the citation guard, got: {error}"
        );

        // And the same row, cited for the incident it belongs to, is accepted.
        sqlx::query("DELETE FROM kernel.incidents WHERE incident_id=$1")
            .bind(other)
            .execute(&pool)
            .await
            .unwrap();
        let own_evidence = seed_evidence(
            &pool,
            incident,
            started,
            "OPERATOR_NOTE",
            "operator",
            "UNVERIFIED",
        )
        .await;
        sqlx::query(
            "INSERT INTO kernel.investigation_hypothesis_evidence
                 (hypothesis_id, evidence_id, role) VALUES ($1,$2,'SUPPORTING')",
        )
        .bind(hypothesis)
        .bind(own_evidence)
        .execute(&pool)
        .await
        .expect("the incident's own evidence must be citable");

        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn a_hypothesis_cannot_speak_the_verdict_vocabulary() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        for verdict_word in ["CONFIRMED", "REFUTED", "INCONCLUSIVE"] {
            let error = sqlx::query(
                "INSERT INTO kernel.investigation_hypotheses
                     (hypothesis_id, run_id, ordinal, statement, stance, confidence, reasoning,
                      adapter_kind)
                 VALUES ($1,$2,9,'a hypothesis that claims to be a verdict',$3,'LOW',
                         'this must be refused','TEST_FIXTURE')",
            )
            .bind(Uuid::new_v4())
            .bind(run)
            .bind(verdict_word)
            .execute(&pool)
            .await
            .err()
            .unwrap_or_else(|| panic!("{verdict_word} must not be a hypothesis stance"));
            assert!(
                error
                    .to_string()
                    .contains("investigation_hypotheses_stance_check")
                    || error.to_string().contains("check constraint"),
                "expected the stance CHECK constraint, got: {error}"
            );
        }
        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn an_uncertain_hypothesis_must_say_what_is_missing() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        let error = sqlx::query(
            "INSERT INTO kernel.investigation_hypotheses
                 (hypothesis_id, run_id, ordinal, statement, stance, confidence, reasoning,
                  adapter_kind)
             VALUES ($1,$2,2,'a hypothesis with no gap declared','UNCERTAIN','LOW',
                     'this must be refused','TEST_FIXTURE')",
        )
        .bind(Uuid::new_v4())
        .bind(run)
        .execute(&pool)
        .await
        .expect_err("UNCERTAIN without a gap code must be refused");
        assert!(
            error
                .to_string()
                .contains("investigation_uncertain_has_gap_check")
                || error.to_string().contains("check constraint"),
            "expected the gap CHECK constraint, got: {error}"
        );
        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn a_run_cannot_be_relabelled_as_a_different_adapter() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        sqlx::query(
            "INSERT INTO kernel.investigation_model_providers
                 (provider_id, kind, display_name, credential_env_var, base_url, model_id, enabled)
             VALUES ('http-openai-compatible-v1','HTTP_OPENAI_COMPATIBLE','test provider',
                     'OPSWEAVE_TEST_MODEL_KEY','https://provider.invalid','test-model',true)
             ON CONFLICT (provider_id) DO NOTHING",
        )
        .execute(&pool)
        .await
        .unwrap();
        let error = sqlx::query(
            "UPDATE kernel.investigation_runs SET provider_id='http-openai-compatible-v1' WHERE run_id=$1",
        )
        .bind(run)
        .execute(&pool)
        .await
        .expect_err("a run must not be able to claim a provider whose kind it does not match");
        assert!(
            error
                .to_string()
                .contains("which is not what that provider is"),
            "expected the adapter guard, got: {error}"
        );
        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn a_human_review_of_an_investigation_creates_no_verdict() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        sqlx::query(
            "INSERT INTO kernel.investigation_human_reviews (run_id, decision, note, reviewed_by)
             VALUES ($1,'ACCEPTED','the reasoning is usable for triage',$2)",
        )
        .bind(run)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("a review is recordable");
        let verdicts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM kernel.incident_verdicts WHERE incident_id=$1",
        )
        .bind(incident)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(verdicts, 0, "a review must not become a verdict");
        let status: String =
            sqlx::query_scalar("SELECT status FROM kernel.incidents WHERE incident_id=$1")
                .bind(incident)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "OPEN", "a review must not move the incident either");
        // The review's vocabulary cannot express a verdict, and vice versa.
        let error = sqlx::query(
            "INSERT INTO kernel.investigation_human_reviews (run_id, decision, note, reviewed_by)
             VALUES ($1,'CONFIRMED','this is a verdict word and must be refused',$2)",
        )
        .bind(run)
        .bind(owner)
        .execute(&pool)
        .await
        .expect_err("CONFIRMED must not be a review decision");
        assert!(
            error.to_string().contains("decision_check")
                || error.to_string().contains("check constraint"),
            "expected the decision CHECK constraint, got: {error}"
        );
        cleanup(&pool, &[owner]).await;
    }

    /// G12 F (P1-3): "no UPDATE path" was a statement about the handler, and 0020 wrote
    /// it as if it were a statement about the table - an UPDATE ... SET decision changed
    /// a human's review. Migration 0021 makes it a statement about the table.
    #[tokio::test]
    async fn a_human_review_cannot_be_rewritten_in_place() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        sqlx::query(
            "INSERT INTO kernel.investigation_human_reviews (run_id, decision, note, reviewed_by)
             VALUES ($1,'ACCEPTED','the reasoning is usable for triage',$2)",
        )
        .bind(run)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("a first review is recordable");

        let rewrite = sqlx::query(
            "UPDATE kernel.investigation_human_reviews SET decision='REJECTED' WHERE run_id=$1",
        )
        .bind(run)
        .execute(&pool)
        .await
        .expect_err("a review is write-once: the database must refuse the rewrite");
        let message = rewrite.to_string();
        assert!(
            message.contains("write-once") || message.contains("restrict"),
            "expected the immutability trigger, got: {message}"
        );

        let decision: String = sqlx::query_scalar(
            "SELECT decision FROM kernel.investigation_human_reviews WHERE run_id=$1",
        )
        .bind(run)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            decision, "ACCEPTED",
            "the review that was written is the one that stands"
        );

        cleanup(&pool, &[owner]).await;
    }

    #[tokio::test]
    async fn a_token_budget_overrun_is_recorded_as_a_measurement_not_clamped() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        sqlx::query(
            "UPDATE kernel.investigation_runs
                SET token_budget=200, prompt_tokens=180, completion_tokens=60, tokens_used=240
              WHERE run_id=$1",
        )
        .bind(run)
        .execute(&pool)
        .await
        .expect("a spend past the budget is storable: it is a measurement, not a promise");
        let recorded: i64 =
            sqlx::query_scalar("SELECT tokens_used FROM kernel.investigation_runs WHERE run_id=$1")
                .bind(run)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(recorded, 240);
        cleanup(&pool, &[owner]).await;
    }

    // -----------------------------------------------------------------------
    // G12 F (P1-1 / P1-7): a STORED evidence row is actually read, byte for byte.
    //
    // The defect these tests exist for was invisible to CI because nothing ever
    // drove read_evidence at a row that had bytes: the tool declared the bytea
    // column as String, so every such read failed with a libpq decode error while
    // the HTTP read of the same bytes worked. A test that only counts invocations
    // and outcomes cannot see the difference between "the tool ran" and "the tool
    // returned the bytes that were submitted", so this one compares the bytes.
    // -----------------------------------------------------------------------

    /// The fixture the two P1-1 tests share: an incident owned by an operator, one
    /// evidence row whose content is STORED, and the bytes the caller submitted.
    async fn stored_evidence(pool: &PgPool, body: &str) -> (Uuid, Uuid, Uuid) {
        let owner = seed_user(pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(pool, owner, None, started).await;
        let evidence = seed_evidence(
            pool,
            incident,
            started + ChronoDuration::minutes(5),
            "LOG_EXCERPT",
            "g12f-stored",
            "OPERATOR_ASSERTED",
        )
        .await;
        sqlx::query(
            "INSERT INTO kernel.incident_evidence_content
               (evidence_id,content_type,body,content_bytes,sha256)
             VALUES ($1,'text/plain',$2,$3,$4)",
        )
        .bind(evidence)
        .bind(body.as_bytes())
        .bind(body.len() as i32)
        .bind(sha256_hex(body.as_bytes()))
        .execute(pool)
        .await
        .unwrap();
        (owner, incident, evidence)
    }

    #[tokio::test]
    async fn read_evidence_returns_the_bytes_that_were_submitted() {
        const BODY: &str = "node-7 kernel: oom_kill process=cadvisor-x memory=1.9Gi";
        let Some(pool) = test_pool().await else {
            return;
        };
        let (owner, incident, evidence) = stored_evidence(&pool, BODY).await;
        let scope = ToolScope {
            incident_id: incident,
            scope_user_id: owner,
        };

        let outcome = execute_tool(
            &pool,
            &[],
            scope,
            TOOL_READ_EVIDENCE,
            &json!({ "incidentId": incident, "evidenceId": evidence }),
        )
        .await
        .expect("a read of the caller's own STORED content must not fail");

        assert_eq!(outcome.predicate, PREDICATE_EVIDENCE_CONTENT);
        assert_eq!(
            outcome.payload["content"]["body"],
            serde_json::json!(BODY),
            "the bytes the tool returns must be the bytes that were submitted"
        );
        assert_eq!(
            outcome.payload["content"]["bytes"],
            serde_json::json!(BODY.len())
        );
        assert_eq!(
            outcome.payload["content"]["sha256"],
            serde_json::json!(sha256_hex(BODY.as_bytes())),
            "the digest in the payload is recomputed over the bytes in hand"
        );
        assert_eq!(
            outcome.payload["content"]["truncated"],
            serde_json::json!(false)
        );

        cleanup(&pool, &[owner]).await;
    }

    /// The second half of P1-7: a read that FAILS has to reach the hypothesis. The
    /// fixture's own statement of the record must not claim more than it read.
    #[test]
    fn a_failed_read_with_rows_cited_is_named_in_gaps_and_lowers_confidence() {
        let started = Utc::now();
        let row = Uuid::new_v4();
        let mut transcript = transcript_with(
            started,
            &[(row, started + ChronoDuration::minutes(1), "SOURCE_ATTESTED")],
        );
        transcript.failed = true;
        let hypothesis = fixture_hypothesis(&transcript);
        assert!(
            hypothesis.gap_codes.contains(&"TOOL_FAILED".to_string()),
            "a failed read must appear in gapCodes even when other reads returned rows, got {:?}",
            hypothesis.gap_codes
        );
        assert_ne!(
            hypothesis.confidence, "HIGH",
            "a conclusion over a record with a failed read is not a high-confidence one"
        );
        let uncertainty = hypothesis
            .uncertainty
            .as_deref()
            .expect("a run with a failed read must state an uncertainty");
        assert!(
            uncertainty.contains("failed inside the Kernel"),
            "the uncertainty must say a read failed, got: {uncertainty}"
        );
    }

    /// A refusal and a failure can both happen in one run, and both have to survive: the
    /// old code reported one or the other, never both.
    #[test]
    fn a_refused_and_a_failed_read_are_both_reported() {
        let started = Utc::now();
        let row = Uuid::new_v4();
        let mut transcript = transcript_with(started, &[(row, started, "OPERATOR_ASSERTED")]);
        transcript.refused = true;
        transcript.failed = true;
        let hypothesis = fixture_hypothesis(&transcript);
        assert!(hypothesis.gap_codes.contains(&"TOOL_REFUSED".to_string()));
        assert!(hypothesis.gap_codes.contains(&"TOOL_FAILED".to_string()));
    }

    /// G12 F (P1-6): the payload is kept as the exact bytes the digest covers, so a later
    /// reader can recompute the digest instead of believing it. This is the property 0020
    /// only appeared to have.
    #[tokio::test]
    async fn a_recorded_payload_makes_its_digest_recomputable() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let owner = seed_user(&pool, "operator").await;
        let started = Utc::now() - ChronoDuration::hours(1);
        let incident = seed_incident(&pool, owner, None, started).await;
        let run = seed_run(&pool, incident, owner).await;
        let payload = r#"{"content":{"body":"disk full on node-7","bytes":19},"evidenceId":"00000000-0000-0000-0000-000000000001"}"#;
        let digest = sha256_hex(payload.as_bytes());
        let horizon = Utc::now() + ChronoDuration::days(7);
        let started_at = Utc::now();
        record_invocation(
            &pool,
            InvocationRecord {
                run_id: run,
                sequence: 1,
                attempt: 1,
                tool: TOOL_READ_EVIDENCE,
                arguments: &json!({}),
                outcome: "OK",
                error_code: None,
                error_detail: None,
                predicate: Some(PREDICATE_EVIDENCE_CONTENT),
                scope_actor: Some(owner),
                result_body: Some(payload),
                result_bytes: Some(payload.len() as i32),
                result_digest: Some(&digest),
                result_retention: Some(horizon),
                evidence_refs: &[],
                started_at,
                finished_at: started_at,
                duration_ms: 1,
            },
        )
        .await
        .expect("a recorded payload is storable");

        let (stored, stored_digest, stored_horizon): (String, String, Option<DateTime<Utc>>) =
            sqlx::query_as(
                "SELECT result_body, result_digest, result_retention_expires_at
                   FROM kernel.investigation_tool_invocations WHERE run_id=$1",
            )
            .bind(run)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            sha256_hex(stored.as_bytes()),
            stored_digest,
            "the digest must be recomputable from what was stored"
        );
        assert_eq!(
            stored, payload,
            "the stored text is the exact bytes that were hashed"
        );
        assert_eq!(
            stored_horizon.map(|value| value.timestamp()),
            Some(horizon.timestamp()),
            "the copy carries the horizon of the content it quotes"
        );

        // And a body without the digest and length that describe it is not a record.
        let orphan = sqlx::query(
            "INSERT INTO kernel.investigation_tool_invocations
               (invocation_id, run_id, sequence, attempt, tool_name, arguments, outcome,
                error_code, authorization_predicate, scope_actor, result_body,
                evidence_refs, started_at, finished_at, duration_ms)
             VALUES ($1,$2,2,1,'read_evidence','{}'::jsonb,'OK',NULL,'P',NULL,'{}','[]'::jsonb,now(),now(),1)",
        )
        .bind(Uuid::new_v4())
        .bind(run)
        .execute(&pool)
        .await
        .expect_err("a retained payload must carry its digest and length");
        assert!(
            orphan.to_string().contains("result_body_check")
                || orphan.to_string().contains("check constraint"),
            "expected the pairing constraint, got: {orphan}"
        );

        cleanup(&pool, &[owner]).await;
    }
}
