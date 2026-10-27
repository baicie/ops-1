.PHONY: build test contract web demo-up demo-data demo-down clean ops-up ops-init ops-stop ops-status ops-doctor ops-data
build:
	cargo build -p opsweave-kernel -p opsweave-node -p opsweave-opsctl
web:
	pnpm --filter @opsweave/platform-web build
test:
	cargo test --workspace
	cargo clippy --workspace --all-targets -- -D warnings
	pnpm --filter @opsweave/platform-web typecheck
	pnpm --filter @opsweave/hello-web typecheck
contract:
	python3 tests/contract/validate_contracts.py
demo-up:
	BUILD=1 scripts/demo_up.sh
demo-data:
	scripts/build-data-plugins.sh
	scripts/demo_data_up.sh
demo-down:
	scripts/demo_down.sh

# OpsWeave local lifecycle wrapper (see scripts/opsweave.sh help).
ops-up:
	./scripts/opsweave.sh up
ops-init:
	./scripts/opsweave.sh init
ops-stop:
	./scripts/opsweave.sh stop
ops-status:
	./scripts/opsweave.sh status
ops-doctor:
	./scripts/opsweave.sh doctor
ops-data:
	./scripts/opsweave.sh data
clean:
	cargo clean
