package pi

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// TestRealPiProtocolSmoke exercises the adapter against a REAL pi CLI
// (npm i -g @mariozechner/pi-coding-agent). It verifies protocol behavior
// only — no model call is required to succeed: even without a configured
// provider the session completes (message stream with stopReason error,
// then agent_end), which is exactly the contract the adapter relies on.
//
// Skipped unless ZHX_PI_SMOKE=1 and `pi` is on PATH, so CI without pi
// stays green.
func TestRealPiProtocolSmoke(t *testing.T) {
	if os.Getenv("ZHX_PI_SMOKE") == "" {
		t.Skip("ZHX_PI_SMOKE not set")
	}
	if _, err := exec.LookPath("pi"); err != nil {
		t.Skip("pi not on PATH:", err)
	}
	a, err := Start(LaunchConfig{
		Command: "pi",
		// Provider selection is left to the user's own pi config
		// (~/.pi/agent/models.json); mode 2 needs a live one.
		// isolation: no extensions/skills/context files, no startup network
		Args: []string{"--no-extensions", "--no-skills", "--no-context-files", "--offline"},
	})
	if err != nil {
		t.Fatalf("start real pi: %v", err)
	}
	defer a.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// The prompt may fail at the model layer (no provider configured);
	// protocol-wise the run must still COMPLETE, not hang or crash.
	res, err := a.Prompt(ctx, "Reply with exactly: pong")
	if err != nil {
		t.Fatalf("prompt did not complete at protocol level: %v", err)
	}
	t.Logf("completed: text=%q toolCalls=%d events=%d", res.Text, res.ToolCalls, len(res.Events))

	// Mode 2 (ZHX_PI_SMOKE=2) additionally requires a live provider —
	// e.g. ZHIPU_API_KEY + a glm/glm-5.3 entry in ~/.pi/agent/models.json —
	// and asserts an actual model round-trip.
	if os.Getenv("ZHX_PI_SMOKE") == "2" {
		if strings.TrimSpace(res.Text) == "" {
			t.Fatalf("mode 2 expects a non-empty model reply, got %q", res.Text)
		}
	}

	// second prompt on the same process: adapter must reuse it
	res2, err := a.Prompt(ctx, "Reply with exactly: pong")
	if err != nil {
		t.Fatalf("second prompt: %v", err)
	}
	t.Logf("second completed: text=%q", res2.Text)
}
