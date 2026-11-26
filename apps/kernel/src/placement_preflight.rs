//! Read-only placement preflight: answer "would this deploy fit" BEFORE building.
//!
//! WHY THIS EXISTS
//!
//! On 2026-11-22 the staging deploy failed with `INSTANCE_CAPACITY_EXCEEDED` after
//! spending the whole build and push budget. The condition was knowable before any
//! of that work started: the node had four instances against a per-node limit of
//! four. Discovering it at the end costs a full image build, a registry push and a
//! deploy timeout, every time, and the message arrives long after the decision that
//! could have used it.
//!
//! WHAT IT MUST NOT DO
//!
//! It must not re-implement the capacity rule. "Compare the instance count to the
//! limit" is the summary of `evaluate_node`, not the rule: the real gate also
//! checks that the node is READY, not revoked, matches the placement selector, has
//! a resource snapshot, and has CPU and memory budget left after the reservation it
//! already carries. A preflight with a simplified rule would answer `FITS` for
//! deployments the scheduler then refuses - the same class of defect as a validator
//! that disagrees with the thing it validates.
//!
//! So this module calls `evaluate_node` itself, for the same slot count the planner
//! would place, with the same `NodeUsage` inputs. It reads; it never writes.
//!
//! WHAT IT CANNOT PROMISE
//!
//! A preflight is a statement about the moment it ran. Another deployment can place
//! in between - that race is not closable from here, and the real gate still runs.
//! The output says so rather than implying the deploy is now safe.

use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

use crate::deployments::{evaluate_node, NodeUsage, PlacementContext, PlacementRejection};
use crate::nodes::NodeRow;
use opsweave_contracts::ResourceRequirements;

/// One node's answer, with the numbers that produced it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct NodePreflight {
    pub node: String,
    pub node_id: Uuid,
    /// `FITS`, `NO_CAPACITY`, `NOT_READY`, `SELECTOR_MISMATCH`, `NO_RESOURCE_SNAPSHOT`.
    pub verdict: &'static str,
    /// Machine-readable code when the verdict is not `FITS`.
    pub code: Option<&'static str>,
    /// The numbers behind the answer. Never empty for a refusal.
    pub detail: Option<String>,
    pub instances_on_node: usize,
    pub instances_for_deployment: usize,
    pub free_slots_per_node: Option<usize>,
    pub free_slots_per_deployment: Option<usize>,
}

/// The preflight result for one deployment request.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Preflight {
    /// `FITS` when at least one node can take every requested replica.
    /// `CAPACITY_BLOCKED` when none can - the case that used to be discovered by
    /// timing out.
    pub verdict: &'static str,
    /// Which nodes fit, and why the others did not.
    pub nodes: Vec<NodePreflight>,
    pub replicas_requested: i32,
    /// How many replicas could be placed right now, across all nodes.
    pub replicas_placeable: i32,
    /// Present whenever `verdict` is not `FITS`, named after the rejection code of
    /// the node that got furthest - so "the node is full" and "the selector matches
    /// nothing" are not the same message.
    ///
    /// `NOT_ENOUGH_NODES` is this object's own code, used when every node FIT but
    /// their slots did not add up to the requested count. It is not a node
    /// rejection, so it has no per-node row to point at.
    pub reason: Option<&'static str>,
    /// The numbers behind `reason`, at the top level.
    ///
    /// A refusal whose only text is a code is a boolean in disguise, and the
    /// caller should not have to reconstruct the arithmetic from `nodes[]` to
    /// know whether to add a node or shrink the request. Empty when the verdict
    /// is `FITS`.
    pub detail: Option<String>,
    /// Said plainly in the payload because a consumer that drops it will read the
    /// verdict as a guarantee.
    pub caveat: &'static str,
    /// How many node slots a SAFE reclamation would free, and what would be freed.
    ///
    /// This is the difference between `CAPACITY_BLOCKED` and `RECLAIM_REQUIRED`:
    /// the first says "there is no room", the second says "there is no room until
    /// the candidates below are released". A caller that only reads `verdict`
    /// cannot tell a full node from a node full of its own abandoned attempts, and
    /// those have opposite remedies.
    ///
    /// Always present, zero when nothing is reclaimable, so a consumer does not
    /// have to distinguish "none" from "not computed".
    pub reclaim: ReclaimPlan,
}

/// What a reclamation of superseded candidates would free.
///
/// This does not compute capacity - `Preflight` already did, with the planner's own
/// `evaluate_node`. It reports what would become available if the candidates named
/// here were released, and names them so the recommendation is checkable.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ReclaimPlan {
    /// Slots that would be freed by releasing the candidates below.
    pub slots_freed: usize,
    /// The deployments that would be released, newest first per plugin.
    pub candidates: Vec<ReclaimCandidate>,
    /// Why nothing (or something) is reclaimable, in words.
    pub detail: String,
    /// Per-deployment reasons for the ones NOT reclaimed, with stable codes.
    ///
    /// This is the field that answers "why is this instance still holding a slot?"
    /// (TASK-23). Without it `detail` can only say "nothing is safely reclaimable",
    /// which is true and useless: the operator cannot tell a candidate that is
    /// protected by an ACTIVE revision from one whose container state is unknown,
    /// and those need different actions - one is working as intended, the other is
    /// waiting for a human.
    ///
    /// Never empty when `candidates` is empty and something was examined.
    pub protected: Vec<ProtectedCandidate>,
}

/// One deployment the rule examined and refused, and why.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProtectedCandidate {
    pub deployment: String,
    /// A `ReclaimEligibility` code: `ACTIVE_REVISION_PROTECTED`,
    /// `ROUTABLE_INSTANCE_PRESENT`, `DEPLOYMENT_STILL_RECOVERING`,
    /// `NOTHING_WAITING`, `NO_SUCCESSOR`, `RUNTIME_MAY_BE_RUNNING`, …
    pub code: &'static str,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct ReclaimCandidate {
    pub plugin_id: String,
    pub version: String,
    pub deployment_id: Uuid,
    pub status: String,
    /// Which newer version supersedes it. Never empty: a candidate is only
    /// reclaimable because something is newer.
    pub superseded_by: String,
}

// ---------------------------------------------------------------------------
// RECLAIM ELIGIBILITY (ADR-030)
// ---------------------------------------------------------------------------
//
// WHY THIS IS A SEPARATE, PURE DECISION
//
// The reclamation sweep and the preflight must agree about what is reclaimable.
// They used to be two copies of one SQL predicate kept in step by a test, and
// Phase 8 found the cost of that: the copy drifted on `created_at` vs `version`
// and nothing in the suite noticed until a fixture straddled a digit boundary.
//
// ADR-030 D2 says the eligibility rule is held by the Kernel and answered as one
// of four outcomes with a stable code. So it is here, as a function of the facts
// about ONE deployment, with no database access of its own. The sweep and the
// preflight both call it; neither restates it.
//
// WHY IT IS NOT SQL
//
// The predicate needs to distinguish "DEGRADED because it was effective and lost
// replicas" from "DEGRADED because it never became effective" (ADR-030 D3/E4).
// That is a fact about `activation_revisions`, not about the status string, and a
// rule that reads only `status` cannot see it. Writing it as a function makes each
// protection separately testable, which TASK-10 requires: every protection gets its
// own counterexample.
//
// IT FAILS CLOSED. Anything unexpected - an unknown status, a deployment whose
// instances cannot be classified - is INSUFFICIENT_EVIDENCE, never RECLAIMABLE.

/// One deployment, as the eligibility rule needs to see it.
///
/// Deliberately NOT the row type: this is the input to a decision, and building it
/// from a row is the caller's job. A caller that cannot fill a field must say so
/// rather than substitute a default - see `ReclaimFacts::unknown`.
#[derive(Debug, Clone)]
pub struct ReclaimFacts {
    pub deployment_id: Uuid,
    pub plugin_id: String,
    pub version: String,
    pub status: String,
    pub generation: i64,
    /// An ACTIVE `activation_revisions` row points at this deployment. This is what
    /// the Gateway routes on, and it is NOT the same as `status == "ACTIVE"`.
    pub has_active_revision: bool,
    /// At least one of its instances is `state='READY'` and `desired_action='START'`,
    /// i.e. the Gateway could pick it right now.
    pub has_ready_instance: bool,
    /// At least one instance still references a container.
    ///
    /// `desired_action='STOP'` only records the PLAN to stop. A container id says a
    /// process may actually exist, and stopping it is a physical action (ADR-030 D4).
    pub instance_may_have_container: bool,
    /// Every instance's `desired_action` is `STOP`, or it has no instances at all.
    pub instances_idle_or_absent: bool,
    /// A newer deployment of the SAME plugin exists (`created_at`, never `version`).
    pub superseded_by_newer: bool,
    /// Some deployment of the same plugin is `PENDING`/`PREPARING`, i.e. something is
    /// waiting on a slot right now.
    pub a_sibling_is_waiting: bool,
}

/// The four answers ADR-030 D2 requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReclaimEligibility {
    /// Every protection holds. The sweep may release it.
    Reclaimable,
    /// A protection applies. Not a defect - the row is doing its job.
    Protected(&'static str),
    /// A deciding fact is missing or unreadable. Never released on a guess.
    InsufficientEvidence(&'static str),
}

impl ReclaimEligibility {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Reclaimable => "RECLAIMABLE",
            Self::Protected(c) | Self::InsufficientEvidence(c) => c,
        }
    }

    pub fn is_reclaimable(&self) -> bool {
        matches!(self, Self::Reclaimable)
    }
}

/// The rule. ADR-030 D3, in order, first match wins.
///
/// ORDER MATTERS FOR THE MESSAGE, NOT FOR THE ANSWER: every condition below is
/// required, so a deployment failing two of them is not reclaimable either way. The
/// order exists so the reason names the most specific protection - "an ACTIVE
/// revision points at it" tells an operator more than "it has a container".
pub fn reclaim_eligibility(f: &ReclaimFacts) -> ReclaimEligibility {
    // E2 FIRST, because it is the protection a wrong answer is most expensive to
    // get wrong: releasing a deployment the Gateway routes on takes a live route
    // down (gateway.rs:349 reads this revision and nothing about status).
    if f.has_active_revision {
        return ReclaimEligibility::Protected("ACTIVE_REVISION_PROTECTED");
    }

    // E3: ROUTABLE, WHICH IS A CONJUNCTION, NOT EITHER HALF.
    //
    // The first version of this rule protected any deployment with a READY instance.
    // That is not what the Gateway does, and four Phase 8 tests caught it: a
    // deployment with a healthy instance and NO ACTIVE revision is invisible to
    // `route_candidates` (it joins on the revision), so refusing to reclaim it
    // blocks the very mechanism the brief tells us to reuse.
    //
    // Serving requires BOTH, and `gateway.rs:349` says so in one query. An ACTIVE
    // revision alone is E2 above; a READY instance alone is a deployment waiting to
    // be activated, which is a candidate. Only together do they answer traffic.
    if f.has_ready_instance && f.has_active_revision {
        return ReclaimEligibility::Protected("ROUTABLE_INSTANCE_PRESENT");
    }

    // E4: which state is this row actually in?
    //
    // `DEGRADED` is two states under one label. Reached via the `failed > 0`
    // branch it means "never became effective, replicas failed" - a candidate. A
    // deployment that is effective is protected by E2 above, so a DEGRADED row that
    // reaches here was never effective; that is exactly ADR-030 case C.
    //
    // Anything else - `PENDING`, `PREPARING`, `ACTIVE`, `DRAINING`, `FAILED`,
    // `DISABLED`, or a status this code has never heard of - is not a candidate.
    match f.status.as_str() {
        "READY" | "DEGRADED" => {}
        "PENDING" | "PREPARING" => {
            // Still trying. Reclaiming it would be killing an attempt in progress.
            return ReclaimEligibility::Protected("DEPLOYMENT_STILL_RECOVERING");
        }
        "DRAINING" => return ReclaimEligibility::Protected("ALREADY_RECLAIMING"),
        _ => return ReclaimEligibility::Protected("NOT_A_CANDIDATE_STATUS"),
    }

    // E1: a candidate is only reclaimable because something is newer.
    //
    // Without this a plugin's ONLY version could be released, taking the plugin
    // offline with no replacement. staging's hello@0.0.1 and
    // data-integration@0.0.2 are each their plugin's only activated version.
    if !f.superseded_by_newer {
        return ReclaimEligibility::Protected("NO_SUCCESSOR");
    }

    // E5: only make room when something is waiting for one.
    //
    // This is the clause that keeps a rollback target alive: `rollback` leaves the
    // target READY and a later deployment supersedes it by `created_at`, so without
    // this the sweep would drain it while the operator is activating it. Measured
    // in Phase 8 as `left: "DISABLED" right: "READY"`.
    if !f.a_sibling_is_waiting {
        return ReclaimEligibility::Protected("NOTHING_WAITING");
    }

    // E8: PHYSICAL EVIDENCE, AND ONLY WHERE IT IS THE QUESTION.
    //
    // A container id means a process may exist; `desired_action='STOP'` only says
    // the platform intends it to end. The brief is explicit that a STOP plan is not
    // proof of released resources.
    //
    // BUT A `READY` CANDIDATE'S CONTAINER IS NOT A RISK - IT IS THE POINT.
    //
    // `READY` means every replica is up and healthy and the version was simply never
    // activated. Its container is the product of a SUCCESSFUL deploy, it has never
    // carried a route, and releasing it is what the existing reclaim has always
    // done - Phase 8's suite asserts exactly that and four of those tests caught this
    // rule being stricter than the mechanism it replaced.
    //
    // `DEGRADED`, by contrast, means the attempt FAILED. A failed container may be
    // mid-write, and nothing about the row says whether it is.
    //
    // So the evidence requirement applies to the case that raised the question.
    // Applying it to both is not "more careful": it stops the mechanism the brief
    // tells us to reuse, for the case that mechanism was built for.
    let is_failed_attempt = f.status == "DEGRADED";
    if is_failed_attempt && f.instance_may_have_container && !f.instances_idle_or_absent {
        return ReclaimEligibility::InsufficientEvidence("RUNTIME_MAY_BE_RUNNING");
    }

    // E8's other half, scoped the same way. For a FAILED attempt, instance rows that
    // are neither running nor idle are a shape this rule does not classify, so it
    // refuses rather than guesses.
    //
    // Not applied to `READY`: there the rows are healthy by definition, and the
    // existing reclaim has always released them. Being "more careful" than the
    // mechanism being replaced is not caution, it is a regression with a good story.
    if is_failed_attempt && !f.instances_idle_or_absent {
        return ReclaimEligibility::InsufficientEvidence("RUNTIME_STATE_UNKNOWN");
    }

    ReclaimEligibility::Reclaimable
}

const CAVEAT: &str = "read-only estimate at the moment this ran; the scheduler still \
     re-evaluates every slot, and another deployment may place in between";

/// Everything the preflight needs, gathered read-only by the caller.
#[derive(Clone)]
pub struct PreflightInput {
    pub nodes: Vec<NodeRow>,
    pub selector: BTreeMap<String, String>,
    pub requested: ResourceRequirements,
    pub replicas: i32,
    pub max_instances_per_deployment: usize,
    pub max_instances_per_node: usize,
    /// Reserved CPU/memory per node id, from instances that are not ghosts.
    pub reserved: HashMap<Uuid, (i64, i64)>,
    /// Instances of THIS deployment per node.
    pub used_nodes: HashMap<Uuid, usize>,
    /// Every non-ghost instance per node.
    pub global_counts: HashMap<Uuid, usize>,
    /// Per-node count of instances of this deployment, for the per-deployment limit.
    pub deployment_counts: HashMap<Uuid, usize>,
    /// Candidates a safe reclamation would release, gathered read-only. Empty when
    /// the caller did not ask for a reclaim plan.
    pub reclaimable: Vec<ReclaimCandidate>,
    /// Deployments examined and refused, with the rule's own code for each.
    pub protected: Vec<ProtectedCandidate>,
}

/// Evaluate every node against the REAL placement gate.
///
/// `used_nodes` is the per-deployment count the planner limits against; the
/// existing code calls the same map that way, and the two "free slots" fields are
/// derived from it so a reader can see which limit is the binding one.
pub fn preflight(input: &PreflightInput) -> Preflight {
    let placement = PlacementContext {
        selector: &input.selector,
        requested: &input.requested,
        max_instances_per_deployment: input.max_instances_per_deployment,
        max_instances_per_node: input.max_instances_per_node,
    };

    let mut nodes = Vec::with_capacity(input.nodes.len());
    let mut replicas_placeable = 0_i32;
    let mut furthest: Option<(String, PlacementRejection)> = None;

    for node in &input.nodes {
        let usage = NodeUsage::of(
            node,
            &input.reserved,
            &input.used_nodes,
            &input.global_counts,
        );
        let verdict = evaluate_node(node, usage, &placement);
        let per_deployment = input.deployment_counts.get(&node.id).copied().unwrap_or(0);
        let (code, detail, kind) = match &verdict {
            Ok(()) => (None, None, "FITS"),
            Err(rejection) => {
                // Keep the rejection that got furthest: it is the one that explains
                // the deploy rather than a node that was never a candidate.
                let better = furthest
                    .as_ref()
                    .map(|(_, best)| rejection.progress() > best.progress())
                    .unwrap_or(true);
                if better {
                    furthest = Some((node.name.clone(), rejection.clone()));
                }
                (
                    Some(rejection.code()),
                    Some(rejection.detail()),
                    verdict_kind(rejection),
                )
            }
        };

        // How many MORE replicas this node could take, by the binding limit. This is
        // derived from the same two numbers `evaluate_node` compares, so it cannot
        // disagree with the verdict above.
        let free_per_node = input
            .max_instances_per_node
            .saturating_sub(usage.node_instances);
        let free_per_deployment = input
            .max_instances_per_deployment
            .saturating_sub(per_deployment);
        if verdict.is_ok() {
            replicas_placeable += free_per_node.min(free_per_deployment) as i32;
        }

        nodes.push(NodePreflight {
            node: node.name.clone(),
            node_id: node.id,
            verdict: kind,
            code,
            detail,
            instances_on_node: usage.node_instances,
            instances_for_deployment: per_deployment,
            free_slots_per_node: Some(free_per_node),
            free_slots_per_deployment: Some(free_per_deployment),
        });
    }

    let fits = replicas_placeable >= input.replicas;
    // WHEN NO NODE REFUSED, THE REASON IS THAT THERE ARE NOT ENOUGH NODES - not
    // that none is eligible.
    //
    // `NO_ELIGIBLE_NODE` was the fallback whenever `furthest` was `None`, and
    // `furthest` is `None` when every node individually FIT but their slots did
    // not add up to the requested replica count. That is the ordinary
    // "ask for 5, have 2 nodes" case, and calling it "no eligible node" tells an
    // operator the opposite of the truth: the nodes are eligible, there are too
    // few of them.
    //
    // Measured 2026-11-25 with TASK-25's isolated harness: `replicas=5` on two
    // healthy nodes reported `NO_ELIGIBLE_NODE` with no detail. The numbers were
    // already in the payload (`replicasPlaceable`), so the answer was correct and
    // the WORDING was wrong.
    let reason = if fits {
        None
    } else {
        Some(match furthest.as_ref() {
            Some((_, rejection)) => rejection.code(),
            None if replicas_placeable > 0 => "NOT_ENOUGH_NODES",
            None => "NO_ELIGIBLE_NODE",
        })
    };
    // The numbers, at the top level, so a caller can act without walking `nodes`.
    // For a node rejection the per-node detail already names them; this repeats the
    // aggregate that made the plan impossible.
    let detail = if fits {
        None
    } else {
        Some(match (reason, furthest.as_ref()) {
            (Some("NOT_ENOUGH_NODES"), _) => format!(
                "{} replica(s) requested, {} placeable: the nodes are eligible, there are \
                 not enough free slots across them",
                input.replicas, replicas_placeable
            ),
            (Some(code), Some((node, rejection))) => {
                format!("{} on node {}: {}", code, node, rejection.detail())
            }
            (Some(code), None) => format!(
                "{}: {} replica(s) requested, {} placeable, and no node reported a reason",
                code, input.replicas, replicas_placeable
            ),
            _ => format!(
                "{} replica(s) requested, {} placeable",
                input.replicas, replicas_placeable
            ),
        })
    };
    // THE PLAN VERDICT, WHICH IS NOT A NEW CAPACITY CALCULATION.
    //
    // `fits` and `replicas_placeable` come from `evaluate_node` above - the real
    // gate. All this adds is the answer to "and if it does not fit, is that because
    // the cluster is too small, or because it is full of rows we own and abandoned?"
    //
    // Nothing here may turn a CAPACITY_BLOCKED into a FITS. `RECLAIM_REQUIRED` is a
    // refusal that names a next step; a caller that ignores it is exactly where it
    // was before. That distinction is why the verdict word changes and the reason
    // stays the same code.
    let slots_freed = input.reclaimable.len();
    let reclaim = ReclaimPlan {
        slots_freed,
        candidates: input.reclaimable.clone(),
        protected: input.protected.clone(),
        detail: if slots_freed == 0 {
            // Name the codes rather than assert that nothing is wrong. "Nothing is
            // safely reclaimable" was true and unactionable; "RUNTIME_MAY_BE_RUNNING"
            // tells the operator which of several very different things to do.
            if input.protected.is_empty() {
                // The original wording, kept: it is the accurate one when nothing was
                // even examined. The branch below is the new case - something WAS
                // examined and refused - where naming the code is what an operator
                // needs and "nothing is reclaimable" is true but useless.
                "nothing is safely reclaimable: no superseded candidate is holding a slot"
                    .to_string()
            } else {
                let codes: Vec<String> = input
                    .protected
                    .iter()
                    .map(|p| format!("{}: {}", p.deployment, p.code))
                    .collect();
                format!(
                    "{} candidate(s) examined and none released — {}",
                    input.protected.len(),
                    codes.join("; ")
                )
            }
        } else {
            format!(
                "{} slot(s) held by superseded candidates that were never activated; releasing them \
                 would leave {} placeable",
                slots_freed,
                replicas_placeable + slots_freed as i32
            )
        },
    };
    let reclaim_would_help = !fits && (replicas_placeable + slots_freed as i32) >= input.replicas;

    Preflight {
        verdict: if fits {
            "FITS"
        } else if reclaim_would_help {
            "RECLAIM_REQUIRED"
        } else {
            "CAPACITY_BLOCKED"
        },
        nodes,
        replicas_requested: input.replicas,
        replicas_placeable,
        reason,
        detail: if reclaim_would_help {
            Some(format!(
                "{}; reclaiming the {} listed slot(s) would make it fit",
                detail.unwrap_or_default().trim_end_matches(';'),
                slots_freed
            ))
        } else {
            detail
        },
        caveat: CAVEAT,
        reclaim,
    }
}

/// The short verdict word for one rejection, for the per-node row.
fn verdict_kind(rejection: &PlacementRejection) -> &'static str {
    match rejection {
        PlacementRejection::NodeNotReady { .. } => "NOT_READY",
        PlacementRejection::SelectorMismatch { .. } => "SELECTOR_MISMATCH",
        PlacementRejection::InstanceCapacityExceeded { .. } => "NO_CAPACITY",
        PlacementRejection::ResourceSnapshotMissing { .. } => "NO_RESOURCE_SNAPSHOT",
        PlacementRejection::MemoryInsufficient { .. } => "NO_MEMORY",
        PlacementRejection::CpuInsufficient { .. } => "NO_CPU",
    }
}

// ---------------------------------------------------------------------------
// Gathering the input, read-only, from the same SQL the planner uses.
//
// The three aggregates below are copied from `reconcile_deployment` ON PURPOSE and
// with a cross-check: if the preflight counted instances differently from the
// planner, it would answer FITS for deployments the planner then refuses, which is
// the whole defect class this module exists to avoid. `preflight_counts_match_planner`
// in the tests asserts the two produce the same numbers for one fixture.
// ---------------------------------------------------------------------------

/// Everything the preflight needs for one deployment, read without writing.
///
/// `deployment_id` is `Some` to ask about an existing deployment, `None` to ask
/// "would a new deployment of `requested` with these placement rules fit".
pub async fn gather(
    db: &sqlx::PgPool,
    deployment_id: Option<Uuid>,
    selector: BTreeMap<String, String>,
    requested: ResourceRequirements,
    replicas: i32,
    max_instances_per_deployment: usize,
    max_instances_per_node: usize,
) -> anyhow::Result<Preflight> {
    // EVERY UNREVOKED NODE, NOT ONLY THE READY ONES.
    //
    // This query used to filter `status='READY'`, so a node that was UNREACHABLE
    // or DEGRADED disappeared from the answer entirely. The caller then saw an
    // empty `nodes` list and a `CAPACITY_BLOCKED` verdict with no node to blame -
    // and "there are no nodes" is a very different message from "the node exists
    // and is not ready", which is what `NODE_NOT_READY` exists to say.
    //
    // Measured on 2026-11-25 with TASK-25's isolated harness: mark node-a
    // UNREACHABLE, ask for a plan, and the per-node answers contained no
    // NODE_NOT_READY at all because node-a had been filtered out upstream.
    //
    // `evaluate_node` already rejects a non-READY node with `NodeNotReady`, so
    // including them here is not a second implementation of the rule - it is
    // letting the existing one answer.
    //
    // The `last_seen_at` bound stays: a node that has not reported in 24h is
    // genuinely absent, and the staleness sweep will have marked it UNREACHABLE
    // anyway.
    let nodes = sqlx::query_as::<_, NodeRow>(
        "SELECT * FROM kernel.nodes WHERE revoked_at IS NULL \
         AND last_seen_at > now() - ($1 || ' seconds')::interval ORDER BY name",
    )
    .bind(86400_i64)
    .fetch_all(db)
    .await?;

    // Reserved CPU/memory per node, excluding ghosts - the same predicate the
    // planner uses, so the two cannot disagree about what occupies a slot.
    let alloc_rows = sqlx::query(
        r#"
        SELECT i.node_id,
               COALESCE(SUM((d.resources->>'cpuMillis')::bigint)::bigint, 0) AS cpu,
               COALESCE(SUM((d.resources->>'memoryMiB')::bigint)::bigint, 0) AS mem
        FROM kernel.plugin_instances i
        JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
        WHERE i.desired_action='START'
          AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
          AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)
        GROUP BY i.node_id
        "#,
    )
    .fetch_all(db)
    .await?;
    use sqlx::Row as _;
    let reserved: HashMap<Uuid, (i64, i64)> = alloc_rows
        .into_iter()
        .map(|row| {
            (
                row.get::<Uuid, _>("node_id"),
                (row.get::<i64, _>("cpu"), row.get::<i64, _>("mem")),
            )
        })
        .collect();

    let global_rows = sqlx::query(
        r#"
        SELECT i.node_id, count(*)::bigint AS n
        FROM kernel.plugin_instances i
        JOIN kernel.plugin_deployments d ON d.id=i.deployment_id
        WHERE i.desired_action='START'
          AND d.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
          AND NOT (i.state IN ('UNHEALTHY','UNREACHABLE') AND i.container_id IS NULL)
        GROUP BY i.node_id
        "#,
    )
    .fetch_all(db)
    .await?;
    let global_counts: HashMap<Uuid, usize> = global_rows
        .into_iter()
        .map(|row| {
            (
                row.get::<Uuid, _>("node_id"),
                row.get::<i64, _>("n").max(0) as usize,
            )
        })
        .collect();

    // Per-deployment facts are only asked for when a deployment was named; a
    // hypothetical deploy has no rows yet.
    let (used_nodes, deployment_counts) = match deployment_id {
        Some(id) => {
            let rows = sqlx::query(
                "SELECT node_id, count(*)::bigint AS n FROM kernel.plugin_instances \
                 WHERE deployment_id=$1 AND desired_action='START' GROUP BY node_id",
            )
            .bind(id)
            .fetch_all(db)
            .await?;
            let mut map: HashMap<Uuid, usize> = HashMap::new();
            for row in rows {
                map.insert(
                    row.get::<Uuid, _>("node_id"),
                    row.get::<i64, _>("n").max(0) as usize,
                );
            }
            (map.clone(), map)
        }
        None => (HashMap::new(), HashMap::new()),
    };

    // WHAT A SAFE RECLAMATION WOULD FREE — FROM THE SAME DECISION THE SWEEP USES.
    //
    // This used to be a COPY of the sweep's SQL, kept honest by a test that compared
    // the two. ADR-030 D2 replaced both with one function: `reclaim_facts` reads the
    // facts and `reclaim_eligibility` decides, exactly as `reconcile_once_locked`
    // does. A preflight that promised a reclaim the sweep would not perform would
    // tell an operator to wait for something that never happens, and the only way to
    // be sure it cannot is for there to be one rule.
    //
    // Read-only, like everything else in this function.
    let mut reclaimable: Vec<ReclaimCandidate> = Vec::new();
    let mut protected: Vec<ProtectedCandidate> = Vec::new();
    for fact in reclaim_facts(db).await? {
        let decision = reclaim_eligibility(&fact);
        if decision.is_reclaimable() {
            // `superseded_by` is never empty for a candidate: E1 (`NO_SUCCESSOR`)
            // refuses one with nothing newer, so a reclaimable fact always has one.
            let superseded_by = sqlx::query_scalar::<_, String>(
                "SELECT newer.version FROM kernel.plugin_deployments newer
                  WHERE newer.plugin_id = $1 AND newer.id <> $2
                    AND newer.created_at > (SELECT created_at FROM kernel.plugin_deployments WHERE id = $2)
                    AND newer.status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
                  ORDER BY newer.created_at DESC LIMIT 1",
            )
            .bind(&fact.plugin_id)
            .bind(fact.deployment_id)
            .fetch_optional(db)
            .await?
            .unwrap_or_else(|| "(unknown)".to_string());
            reclaimable.push(ReclaimCandidate {
                plugin_id: fact.plugin_id.clone(),
                version: fact.version.clone(),
                deployment_id: fact.deployment_id,
                status: fact.status.clone(),
                superseded_by,
            });
        } else {
            protected.push(ProtectedCandidate {
                deployment: format!("{}@{}", fact.plugin_id, fact.version),
                code: decision.code(),
            });
        }
    }

    Ok(preflight(&PreflightInput {
        nodes,
        selector,
        requested,
        replicas,
        max_instances_per_deployment,
        max_instances_per_node,
        reserved,
        used_nodes,
        global_counts,
        deployment_counts,
        reclaimable,
        protected,
    }))
}

/// Every deployment worth asking the eligibility rule about, with its facts.
///
/// ONE QUERY, ONE SHAPE. The sweep and the preflight both call this, so the two
/// cannot disagree about a deployment's facts - which is the failure mode
/// ADR-030 D2 exists to prevent. It reads; it never writes.
///
/// IT ONLY RETURNS STATUSES THE RULE COULD ACCEPT. `PENDING`, `PREPARING`,
/// `ACTIVE`, `DRAINING`, `FAILED` and `DISABLED` are filtered out here, which is
/// safe only because `reclaim_eligibility` refuses them anyway - so this is a
/// narrowing of the work, not of the rule. The one that matters is `DEGRADED`:
/// it is included because ADR-030 case C is exactly that status.
pub async fn reclaim_facts(db: &sqlx::PgPool) -> anyhow::Result<Vec<ReclaimFacts>> {
    let rows = sqlx::query(
        r#"
        SELECT d.id, d.plugin_id, d.version, d.status, d.generation,
               EXISTS (
                 SELECT 1 FROM kernel.activation_revisions r
                 WHERE r.deployment_id = d.id AND r.status = 'ACTIVE'
               ) AS has_active_revision,
               EXISTS (
                 SELECT 1 FROM kernel.plugin_instances i
                 WHERE i.deployment_id = d.id
                   AND i.state = 'READY' AND i.desired_action = 'START'
               ) AS has_ready_instance,
               EXISTS (
                 SELECT 1 FROM kernel.plugin_instances i
                 WHERE i.deployment_id = d.id AND i.container_id IS NOT NULL
               ) AS instance_may_have_container,
               NOT EXISTS (
                 SELECT 1 FROM kernel.plugin_instances i
                 WHERE i.deployment_id = d.id AND i.desired_action <> 'STOP'
               ) AS instances_idle_or_absent,
               -- created_at, NEVER version: a version is a content fingerprint with
               -- no ordering (ADR-025). `"0.0.9" > "0.0.10"` is true as a string.
               EXISTS (
                 SELECT 1 FROM kernel.plugin_deployments newer
                 WHERE newer.plugin_id = d.plugin_id
                   AND newer.id <> d.id
                   AND newer.created_at > d.created_at
                   AND newer.status IN
                       ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
               ) AS superseded_by_newer,
               EXISTS (
                 SELECT 1 FROM kernel.plugin_deployments waiting
                 WHERE waiting.plugin_id = d.plugin_id
                   AND waiting.id <> d.id
                   AND waiting.status IN ('PENDING','PREPARING')
               ) AS a_sibling_is_waiting
        FROM kernel.plugin_deployments d
        WHERE d.status IN ('READY','DEGRADED')
        ORDER BY d.plugin_id, d.created_at
        "#,
    )
    .fetch_all(db)
    .await?;

    use sqlx::Row as _;
    Ok(rows
        .into_iter()
        .map(|row| ReclaimFacts {
            deployment_id: row.get("id"),
            plugin_id: row.get("plugin_id"),
            version: row.get("version"),
            status: row.get("status"),
            generation: row.get("generation"),
            has_active_revision: row.get("has_active_revision"),
            has_ready_instance: row.get("has_ready_instance"),
            instance_may_have_container: row.get("instance_may_have_container"),
            instances_idle_or_absent: row.get("instances_idle_or_absent"),
            superseded_by_newer: row.get("superseded_by_newer"),
            a_sibling_is_waiting: row.get("a_sibling_is_waiting"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(name: &str, status: &str) -> NodeRow {
        NodeRow {
            id: Uuid::new_v4(),
            name: name.to_string(),
            control_token_hash: String::new(),
            data_token: String::new(),
            generation: 1,
            os: "linux".to_string(),
            arch: "amd64".to_string(),
            labels: json!({}),
            capabilities: json!({}),
            status: status.to_string(),
            last_seen_at: None,
            data_endpoint: None,
            runtime_adapter_version: None,
            resource_snapshot: Some(json!({
                "cpuCores": 4,
                "memoryTotalBytes": 4_i64 * 1024 * 1024 * 1024,
            })),
            enrolled_at: chrono::Utc::now(),
            revoked_at: None,
            cert_expires_at: None,
        }
    }

    fn input(nodes: Vec<NodeRow>, replicas: i32) -> PreflightInput {
        PreflightInput {
            nodes,
            selector: BTreeMap::new(),
            requested: ResourceRequirements {
                cpu_millis: 100,
                memory_mib: 128,
            },
            replicas,
            max_instances_per_deployment: 4,
            max_instances_per_node: 4,
            reserved: HashMap::new(),
            used_nodes: HashMap::new(),
            global_counts: HashMap::new(),
            deployment_counts: HashMap::new(),
            reclaimable: Vec::new(),
            protected: Vec::new(),
        }
    }

    #[test]
    fn an_empty_ready_node_fits() {
        let r = preflight(&input(vec![node("node-a", "READY")], 1));
        assert_eq!(r.verdict, "FITS");
        assert_eq!(r.replicas_placeable, 4);
        assert!(r.reason.is_none());
    }

    #[test]
    fn a_full_node_is_capacity_blocked_with_the_number() {
        // The staging case: four instances against a per-node limit of four.
        let n = node("node-a", "READY");
        let mut i = input(vec![n.clone()], 1);
        i.global_counts.insert(n.id, 4);
        let r = preflight(&i);
        assert_eq!(r.verdict, "CAPACITY_BLOCKED");
        assert_eq!(r.reason, Some("INSTANCE_CAPACITY_EXCEEDED"));
        let detail = r.nodes[0].detail.as_deref().unwrap_or_default();
        assert!(
            detail.contains('4'),
            "the detail must name the numbers: {detail}"
        );
    }

    #[test]
    fn a_node_that_is_not_ready_is_not_counted() {
        let r = preflight(&input(vec![node("node-a", "UNREACHABLE")], 1));
        assert_eq!(r.verdict, "CAPACITY_BLOCKED");
        assert_eq!(r.reason, Some("NODE_NOT_READY"));
        assert_eq!(r.nodes[0].verdict, "NOT_READY");
    }

    #[test]
    fn two_nodes_add_up() {
        let a = node("node-a", "READY");
        let b = node("node-b", "READY");
        let mut i = input(vec![a.clone(), b.clone()], 2);
        i.global_counts.insert(a.id, 4); // a is full
        let r = preflight(&i);
        assert_eq!(r.verdict, "FITS", "b has room, so two replicas place");
        assert_eq!(r.replicas_placeable, 4);
    }

    /// Every node FIT, but there are not enough of them.
    ///
    /// `NO_ELIGIBLE_NODE` was the fallback here, and it says the opposite of the
    /// truth: the nodes are eligible. Measured 2026-11-25 - five replicas on two
    /// healthy nodes reported "no eligible node" with no detail.
    #[test]
    fn more_replicas_than_slots_is_not_enough_nodes_not_no_eligible_node() {
        let a = node("node-a", "READY");
        let b = node("node-b", "READY");
        let mut i = input(vec![a.clone(), b.clone()], 5);
        // default max_instances_per_node is 1 in `input`, so 2 nodes hold 2.
        i.max_instances_per_node = 1;
        let r = preflight(&i);
        assert_eq!(r.verdict, "CAPACITY_BLOCKED");
        assert_eq!(
            r.reason,
            Some("NOT_ENOUGH_NODES"),
            "both nodes fit individually; the shortfall is the node count, not eligibility"
        );
        let detail = r.detail.expect("a refusal must carry its numbers");
        assert!(detail.contains("5 replica(s) requested"), "{detail}");
        assert!(detail.contains("placeable"), "{detail}");
    }

    /// A node that is not READY is REPORTED, not filtered out.
    ///
    /// `gather` used to select only `status='READY'`, so an unreachable node
    /// vanished from the answer and the caller saw an empty list instead of the
    /// node that was the problem.
    #[test]
    fn a_not_ready_node_is_reported_with_its_own_code() {
        let a = node("node-a", "UNREACHABLE");
        let b = node("node-b", "READY");
        let i = input(vec![a, b], 1);
        let r = preflight(&i);
        let codes: Vec<_> = r.nodes.iter().filter_map(|n| n.code).collect();
        assert!(
            codes.contains(&"NODE_NOT_READY"),
            "the unready node must appear in the per-node answers: {codes:?}"
        );
        // And the ready node still fits - the refusal is per node.
        assert!(
            r.nodes.iter().any(|n| n.verdict == "FITS"),
            "one unready node must not make every node report a refusal"
        );
    }

    /// Every refusal carries a top-level detail, so a caller does not have to
    /// reconstruct the arithmetic from `nodes[]`.
    #[test]
    fn every_refusal_carries_a_top_level_detail() {
        for (label, build) in [
            (
                "selector",
                (|| {
                    let mut n = node("node-a", "READY");
                    n.labels = json!({ "pool": "other" });
                    let mut i = input(vec![n], 1);
                    i.selector.insert("pool".to_string(), "data".to_string());
                    i
                }) as fn() -> PreflightInput,
            ),
            ("not enough nodes", || {
                let a = node("node-a", "READY");
                let b = node("node-b", "READY");
                let mut i = input(vec![a, b], 5);
                i.max_instances_per_node = 1;
                i
            }),
            ("full node", || {
                let a = node("node-a", "READY");
                let mut i = input(vec![a.clone()], 1);
                i.global_counts.insert(a.id, 1);
                i
            }),
        ] {
            let r = preflight(&build());
            if r.verdict == "FITS" {
                continue;
            }
            assert!(
                r.detail.as_deref().is_some_and(|d| !d.is_empty()),
                "{label}: a refusal with no detail is a boolean in disguise"
            );
        }
    }

    #[test]
    fn a_selector_that_matches_nothing_says_so() {
        let mut n = node("node-a", "READY");
        n.labels = json!({ "pool": "other" });
        let mut i = input(vec![n], 1);
        i.selector.insert("pool".to_string(), "data".to_string());
        let r = preflight(&i);
        assert_eq!(r.verdict, "CAPACITY_BLOCKED");
        assert_eq!(r.reason, Some("SELECTOR_MISMATCH"));
    }

    #[test]
    fn a_node_with_no_resource_snapshot_is_not_silently_skipped() {
        let mut n = node("node-a", "READY");
        n.resource_snapshot = None;
        let r = preflight(&input(vec![n], 1));
        assert_eq!(r.verdict, "CAPACITY_BLOCKED");
        assert_eq!(r.reason, Some("RESOURCE_SNAPSHOT_MISSING"));
    }

    #[test]
    fn more_replicas_than_total_slots_is_blocked_even_with_free_nodes() {
        // One node, limit 4, asking for 5.
        let r = preflight(&input(vec![node("node-a", "READY")], 5));
        assert_eq!(r.verdict, "CAPACITY_BLOCKED");
        assert_eq!(r.replicas_placeable, 4);
    }

    #[test]
    fn the_caveat_is_always_present() {
        // A consumer that drops this will read FITS as a guarantee.
        let r = preflight(&input(vec![node("node-a", "READY")], 1));
        assert!(!r.caveat.is_empty());
        assert!(r.caveat.contains("re-evaluates"));
    }

    /// `RECLAIM_REQUIRED` says "blocked, but the blockage is our own abandoned
    /// rows". It must never say that when the cluster is simply too small - that
    /// would send an operator to wait for a reclaim that frees nothing.
    #[test]
    fn reclaim_required_only_when_a_reclaim_would_actually_make_it_fit() {
        // A node at its per-node limit, and one candidate that could be released.
        let node = node("staging-node", "READY");
        let mut base = input(vec![node.clone()], 1);
        base.max_instances_per_node = 1;
        base.global_counts.insert(node.id, 1);
        base.reclaimable = vec![ReclaimCandidate {
            plugin_id: "test.old".into(),
            version: "0.0.1".into(),
            deployment_id: Uuid::new_v4(),
            status: "READY".into(),
            superseded_by: "0.0.2".into(),
        }];
        let plan = preflight(&base);
        assert_eq!(plan.verdict, "RECLAIM_REQUIRED", "{plan:?}");
        assert_eq!(plan.reclaim.slots_freed, 1);
        assert_eq!(plan.reclaim.candidates.len(), 1);
        // The refusal is unchanged: this is still a refusal.
        assert!(plan.reason.is_some(), "a blocked verdict always names why");

        // Same node, nothing reclaimable: the cluster is full for real.
        let mut no_reclaim = base.clone();
        no_reclaim.reclaimable.clear();
        let plan = preflight(&no_reclaim);
        assert_eq!(plan.verdict, "CAPACITY_BLOCKED", "{plan:?}");
        assert_eq!(plan.reclaim.slots_freed, 0);
        assert!(
            plan.reclaim
                .detail
                .contains("nothing is safely reclaimable"),
            "{}",
            plan.reclaim.detail
        );

        // One reclaimable slot but two requested: reclaiming is not enough, so the
        // answer is still CAPACITY_BLOCKED. Promising RECLAIM_REQUIRED here would
        // be a lie by one replica.
        let mut too_big = base.clone();
        too_big.replicas = 2;
        let plan = preflight(&too_big);
        assert_eq!(plan.verdict, "CAPACITY_BLOCKED", "{plan:?}");
        assert_eq!(
            plan.reclaim.slots_freed, 1,
            "the reclaim is still reported, it just does not help"
        );

        // And a node that fits is never RECLAIM_REQUIRED, whatever is reclaimable.
        let free = input(vec![node], 1);
        let mut with_reclaim = free;
        with_reclaim.reclaimable = base.reclaimable.clone();
        let plan = preflight(&with_reclaim);
        assert_eq!(plan.verdict, "FITS", "{plan:?}");
    }

    /// A reclaim plan is a READ of the deployment rows, so it must not change
    /// them. The brief's rule for this endpoint is that FITS is an estimate; the
    /// stronger rule is that asking is never a mutation.
    #[test]
    fn building_a_reclaim_plan_writes_nothing() {
        let node = node("staging-node", "READY");
        let mut base = input(vec![node.clone()], 1);
        base.max_instances_per_node = 1;
        base.global_counts.insert(node.id, 1);
        base.reclaimable = vec![ReclaimCandidate {
            plugin_id: "test.old".into(),
            version: "0.0.1".into(),
            deployment_id: Uuid::new_v4(),
            status: "READY".into(),
            superseded_by: "0.0.2".into(),
        }];
        let before = format!("{:?}", base.reclaimable);
        let _ = preflight(&base);
        assert_eq!(
            format!("{:?}", base.reclaimable),
            before,
            "preflight takes &PreflightInput and may not mutate it"
        );
    }

    /// ADR-030 D3: every protection, one counterexample each.
    ///
    /// These are pure-function tests - no database, no fixtures - because the rule
    /// is a decision about facts. TASK-10 adds the integration matrix that proves
    /// the sweep and the preflight both honour it; this module proves the rule
    /// itself says what ADR-030 says it says.
    mod reclaim_eligibility {
        use super::super::{reclaim_eligibility, ReclaimEligibility, ReclaimFacts};
        use uuid::Uuid;

        /// A candidate that satisfies every condition: READY, no revision, idle,
        /// superseded, with something waiting. Each test below breaks exactly one
        /// field, so a failure names the protection that stopped it.
        fn candidate() -> ReclaimFacts {
            ReclaimFacts {
                deployment_id: Uuid::nil(),
                plugin_id: "opsweave.data-catalog".to_string(),
                version: "0.0.3590".to_string(),
                status: "READY".to_string(),
                generation: 1,
                has_active_revision: false,
                has_ready_instance: false,
                instance_may_have_container: false,
                instances_idle_or_absent: true,
                superseded_by_newer: true,
                a_sibling_is_waiting: true,
            }
        }

        #[test]
        fn a_fully_satisfied_candidate_is_reclaimable() {
            assert_eq!(
                reclaim_eligibility(&candidate()),
                ReclaimEligibility::Reclaimable,
                "the control: without it every test below could pass because the rule \
                 refuses everything"
            );
        }

        /// E2. The most expensive protection to get wrong: `route_candidates` reads
        /// this revision and nothing about `status`, so releasing it empties a live
        /// route.
        #[test]
        fn an_active_revision_protects_even_a_ready_deployment() {
            let mut f = candidate();
            f.has_active_revision = true;
            assert_eq!(
                reclaim_eligibility(&f).code(),
                "ACTIVE_REVISION_PROTECTED",
                "a deployment the Gateway routes on is never a candidate, whatever its status"
            );
        }

        /// E3 IS A CONJUNCTION. A healthy instance with no ACTIVE revision is
        /// invisible to the Gateway (`route_candidates` joins on the revision), so it
        /// is a candidate, not a serving deployment.
        ///
        /// The first version of this test asserted the opposite and passed; four
        /// Phase 8 tests failed and showed which was right.
        #[test]
        fn a_ready_instance_alone_does_not_protect() {
            let mut f = candidate();
            f.has_ready_instance = true;
            assert_eq!(
                reclaim_eligibility(&f),
                ReclaimEligibility::Reclaimable,
                "serving needs the revision AND the instance; only the revision alone is \
                 protected (E2), and this row has neither"
            );
        }

        /// And with both, it is protected - by E2, which is the clause that fires.
        #[test]
        fn both_halves_together_are_protected() {
            let mut f = candidate();
            f.has_ready_instance = true;
            f.has_active_revision = true;
            assert_eq!(
                reclaim_eligibility(&f).code(),
                "ACTIVE_REVISION_PROTECTED",
                "E2 fires first because releasing it is the more expensive mistake"
            );
        }

        /// E4. Case A of ADR-030 is `DEGRADED` WITH a revision, and E2 catches it.
        /// This test is the other half: the status alone is not a rejection either.
        #[test]
        fn a_degraded_candidate_with_no_revision_is_eligible() {
            let mut f = candidate();
            f.status = "DEGRADED".to_string();
            assert_eq!(
                reclaim_eligibility(&f),
                ReclaimEligibility::Reclaimable,
                "DEGRADED via the failed>0 branch is ADR-030 case C - the case staging is in"
            );
        }

        #[test]
        fn a_degraded_deployment_that_is_effective_is_protected() {
            let mut f = candidate();
            f.status = "DEGRADED".to_string();
            f.has_active_revision = true;
            assert_eq!(
                reclaim_eligibility(&f).code(),
                "ACTIVE_REVISION_PROTECTED",
                "ADR-030 case A: activated, serving, under-replicated. The label is the \
                 same as case C and the answer is the opposite"
            );
        }

        #[test]
        fn a_still_recovering_deployment_is_protected() {
            for status in ["PENDING", "PREPARING"] {
                let mut f = candidate();
                f.status = status.to_string();
                assert_eq!(
                    reclaim_eligibility(&f).code(),
                    "DEPLOYMENT_STILL_RECOVERING",
                    "{status} is an attempt in progress, not a failed candidate"
                );
            }
        }

        #[test]
        fn a_status_this_rule_does_not_classify_is_refused() {
            for status in ["ACTIVE", "DRAINING", "FAILED", "DISABLED", "SOMETHING_NEW"] {
                let mut f = candidate();
                f.status = status.to_string();
                let answer = reclaim_eligibility(&f);
                assert!(
                    !answer.is_reclaimable(),
                    "{status} must not be reclaimable; got {}",
                    answer.code()
                );
            }
        }

        #[test]
        fn an_already_draining_deployment_is_not_reclaimed_twice() {
            let mut f = candidate();
            f.status = "DRAINING".to_string();
            assert_eq!(reclaim_eligibility(&f).code(), "ALREADY_RECLAIMING");
        }

        /// E1 / D5. Without this a plugin's only version could be released, taking
        /// the plugin offline with no replacement.
        #[test]
        fn a_deployment_with_no_successor_is_protected() {
            let mut f = candidate();
            f.superseded_by_newer = false;
            assert_eq!(
                reclaim_eligibility(&f).code(),
                "NO_SUCCESSOR",
                "staging's hello@0.0.1 and data-integration@0.0.2 are each their plugin's \
                 only version; neither may be reclaimed"
            );
        }

        /// E5. The clause that keeps a rollback target alive.
        #[test]
        fn nothing_waiting_means_no_reclaim() {
            let mut f = candidate();
            f.a_sibling_is_waiting = false;
            assert_eq!(
                reclaim_eligibility(&f).code(),
                "NOTHING_WAITING",
                "a rollback target is READY and superseded, and it must not be drained \
                 while an operator is activating it"
            );
        }

        /// E8 / D4. `desired_action='STOP'` is a plan; a container id is evidence.
        #[test]
        fn a_failed_candidate_that_may_still_have_a_container_is_not_reclaimed() {
            let mut f = candidate();
            f.status = "DEGRADED".to_string();
            f.instance_may_have_container = true;
            f.instances_idle_or_absent = false;
            assert_eq!(
                reclaim_eligibility(&f),
                ReclaimEligibility::InsufficientEvidence("RUNTIME_MAY_BE_RUNNING"),
                "a FAILED attempt's container may be mid-write; stopping it is a physical \
                 action and the brief forbids treating a STOP plan as proof of release"
            );
        }

        /// A `READY` candidate's container is the opposite: the product of a
        /// successful deploy that never carried a route. Releasing it is what the
        /// existing reclaim has always done - applying E8 here made this rule
        /// stricter than the mechanism it replaces, and four Phase 8 tests said so.
        #[test]
        fn a_ready_candidate_with_a_container_is_still_reclaimable() {
            let mut f = candidate();
            f.instance_may_have_container = true;
            f.instances_idle_or_absent = false;
            assert_eq!(
                reclaim_eligibility(&f),
                ReclaimEligibility::Reclaimable,
                "READY means every replica is healthy; the container is the deploy's \
                 product, not a failed attempt's residue"
            );
        }

        /// The same fact, but the instances are idle - a real container that has
        /// already been told to stop. This is the one case where a container id does
        /// not block the release.
        #[test]
        fn a_container_that_is_already_stopping_does_not_block() {
            let mut f = candidate();
            f.instance_may_have_container = true;
            f.instances_idle_or_absent = true;
            assert_eq!(reclaim_eligibility(&f), ReclaimEligibility::Reclaimable);
        }

        #[test]
        fn an_unclassifiable_instance_shape_fails_closed() {
            let mut f = candidate();
            f.status = "DEGRADED".to_string();
            f.instance_may_have_container = false;
            f.instances_idle_or_absent = false;
            assert_eq!(
                reclaim_eligibility(&f),
                ReclaimEligibility::InsufficientEvidence("RUNTIME_STATE_UNKNOWN"),
                "neither running nor idle is not something this rule may guess about"
            );
        }

        /// The two outcomes that are not `Protected` must still refuse. A caller
        /// that checks only "is this an error code" would treat evidence as consent.
        #[test]
        fn only_the_reclaimable_variant_permits_action() {
            assert!(ReclaimEligibility::Reclaimable.is_reclaimable());
            for outcome in [
                ReclaimEligibility::Protected("X"),
                ReclaimEligibility::InsufficientEvidence("Y"),
            ] {
                assert!(
                    !outcome.is_reclaimable(),
                    "{} must not permit a release",
                    outcome.code()
                );
            }
        }
    }
}
