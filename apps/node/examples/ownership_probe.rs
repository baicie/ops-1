// P001-C1.3 - drive the real ownership decision for one NAMED container.
//
// `format!("{:?}")` is not a stable output and the shell scripts cannot link the
// library, so this example exists to answer one question from a shell:
//
//     cargo run -p opsweave-node --example ownership_probe -- \
//         --installation <id> --container <name> [--remove]
//
// It prints a machine-readable line and exits 0 when the answer is `foreign`
// (which is what a scoped installation must see for someone else's container),
// so a caller can assert on the exit code as well as the text.
//
// Why this exists at all: the negative suite used to claim the compiled adapter
// had checked the container it planted, when the adapter test it ran builds its
// OWN container from its own random ids. The claim was wrong, and the fix is to
// actually point the adapter at the planted container rather than to reword the
// claim.
use clap::Parser;
use opsweave_node::docker::{DockerAdapter, Ownership};

#[derive(Parser)]
#[command(
    name = "ownership_probe",
    about = "Ask the real DockerAdapter who owns one container"
)]
struct Args {
    /// The installation identity to probe WITH. The container's labels decide
    /// whether this identity owns it.
    #[arg(long)]
    installation: String,
    /// The exact container name to probe.
    #[arg(long)]
    container: String,
    /// Also call the guarded removal path and report what it did.
    #[arg(long, default_value_t = false)]
    remove: bool,
    #[arg(
        long,
        env = "OPSWEAVE_DOCKER_HOST",
        default_value = "unix:///var/run/docker.sock"
    )]
    docker_host: String,
}

fn label(ownership: Ownership) -> &'static str {
    match ownership {
        Ownership::Ours => "ours",
        Ownership::Foreign => "foreign",
        Ownership::Absent => "absent",
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let adapter = DockerAdapter::new("docker".to_string(), args.docker_host)
        .with_installation_id(args.installation);

    let ownership = adapter.ownership_of(&args.container).await?;
    println!("ownership={}", label(ownership));

    if args.remove {
        // The guarded removal. For a foreign container this must return
        // `Foreign` and leave it running - that is the property under test.
        let removed = adapter.stop_and_remove_owned(&args.container).await?;
        println!("remove_result={}", label(removed));
        if let Some(info) = adapter.inspect(&args.container).await? {
            println!("still_running={}", info.running);
        } else {
            println!("still_running=false");
            println!("container_present=false");
        }
    }

    // Exit 0 only for the answer a scoped installation must give about a
    // container it did not create. Anything else is a finding for the caller.
    if ownership == Ownership::Foreign {
        std::process::exit(0);
    }
    std::process::exit(3)
}
