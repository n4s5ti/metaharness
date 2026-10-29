#!/usr/bin/env bash
# kimi-k3-harness — tmux workbench
#
# Creates a `kimi` tmux session with one window per thing you can actually run.
# Nothing here needs the 1.56 TB Kimi K3 checkpoint; every pane is self-contained.
#
#   ./kimi-tmux.sh          create (or re-attach to) the session
#   tmux attach -t kimi     re-attach later
#   tmux kill-session -t kimi   tear down

set -euo pipefail

H="/home/n4s5ti/src/metaharness/kimi-k3-harness"
K3RS="$H/crates/k3rs"
SESSION="kimi"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "session '$SESSION' already exists — attaching"
  exec tmux attach -t "$SESSION"
fi

# --- window 0: bench — the Rust engine's real kernels, no checkpoint needed ---
tmux new-session -d -s "$SESSION" -n bench -c "$K3RS"
tmux send-keys -t "$SESSION:bench" \
  'clear; echo "k3rs kernel bench — real Kimi K3 dims, no checkpoint."; echo "Run: ./target/release/k3rs --bench"; echo' C-m

# --- window 1: tests — 9 kernel tests incl. AVX2 bitwise identity ---
tmux new-window -t "$SESSION" -n tests -c "$K3RS"
tmux send-keys -t "$SESSION:tests" \
  'clear; echo "k3rs conformance tests."; echo "Run: cargo test --release"; echo' C-m

# --- window 2: flywheel — the WASM kernel evolution loop ---
tmux new-window -t "$SESSION" -n flywheel -c "$H"
tmux send-keys -t "$SESSION:flywheel" \
  'clear; echo "Flywheel: run -> measure -> mutate -> verify -> promote."; echo "Run: npm run build:wasm && npm run flywheel"; echo "Compare: npm run bench:kernel"; echo' C-m

# --- window 3: harness — the agent CLI itself ---
tmux new-window -t "$SESSION" -n harness -c "$H"
tmux send-keys -t "$SESSION:harness" \
  'clear; echo "kimi-k3-harness CLI."; echo "Run: npm run doctor"; echo' C-m

# --- window 4: shell — scratch ---
tmux new-window -t "$SESSION" -n shell -c "$H"

tmux select-window -t "$SESSION:bench"
echo "created tmux session '$SESSION' (bench, tests, flywheel, harness, shell)"
echo "attach with: tmux attach -t $SESSION"
