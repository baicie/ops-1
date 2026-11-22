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
    pub reason: Option<&'static str>,
    /// Said plainly in the payload because a consumer that drops it will read the
    /// verdict as a guarantee.
    pub caveat: &'static str,
}

const CAVEAT: &str = "read-only estimate at the moment this ran; the scheduler still \
     re-evaluates every slot, and another deployment may place in between";

/// Everything the preflight needs, gathered read-only by the caller.
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
    Preflight {
        verdict: if fits { "FITS" } else { "CAPACITY_BLOCKED" },
        nodes,
        replicas_requested: input.replicas,
        replicas_placeable,
        reason: if fits {
            None
        } else {
            Some(
                furthest
                    .as_ref()
                    .map(|(_, r)| r.code())
                    .unwrap_or("NO_ELIGIBLE_NODE"),
            )
        },
        caveat: CAVEAT,
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
    fn a_full_node_is_CAPACITY_BLOCKED_with_the_number() {
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
    fn a_node_that_is_not_READY_is_not_counted() {
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
}
