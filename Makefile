.PHONY: build test contract web demo-up demo-down clean
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
demo-down:
	scripts/demo_down.sh
clean:
	cargo clean
