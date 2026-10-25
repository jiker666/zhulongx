// Package e2e runs the zhulongx binary end-to-end against the mockpi RPC
// double: real CLI process, real SQLite file, real subprocess scheduling,
// including a hard-kill crash followed by restart recovery.
package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func buildBin(t *testing.T, pkg, name string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), name+".exe")
	cmd := exec.Command("go", "build", "-o", bin, pkg)
	cmd.Env = append(os.Environ(), "GOFLAGS=")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build %s: %v\n%s", name, err, out)
	}
	return bin
}

type harness struct {
	t       *testing.T
	dir     string
	zhx     string
	cfgPath string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	zhx := buildBin(t, "zhulongx/cmd/zhulongx", "zhulongx")
	mock := buildBin(t, "zhulongx/internal/pi/mockpi", "mockpi")

	cfgPath := filepath.Join(dir, "zhulongx.yaml")
	cfg := "db_path: " + filepath.ToSlash(filepath.Join(dir, "zhulongx.db")) + `
log_level: debug
runtime:
  tick_interval: 200ms
  decide_timeout: 30s
  execute_timeout: 30s
  max_concurrent_steps: 2
  max_steps_per_decide: 3
  step_max_attempts: 3
  decide_noop_limit: 5
pi:
  command: "` + filepath.ToSlash(mock) + `"
  spawn_retries: 1
`
	if err := os.WriteFile(cfgPath, []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	return &harness{t: t, dir: dir, zhx: zhx, cfgPath: cfgPath}
}

func (h *harness) args(args ...string) []string {
	return append(args, "--config", h.cfgPath)
}

func (h *harness) zhxOut(args ...string) (string, error) {
	out, err := exec.Command(h.zhx, h.args(args...)...).CombinedOutput()
	return string(out), err
}

// startRunner launches `zhulongx run` with the given env extras.
func (h *harness) startRunner(env ...string) *exec.Cmd {
	cmd := exec.Command(h.zhx, h.args("run")...)
	cmd.Env = append(os.Environ(), env...)
	setProcAttr(cmd)
	if err := cmd.Start(); err != nil {
		h.t.Fatalf("start run: %v", err)
	}
	return cmd
}

func (h *harness) waitFor(desc string, d time.Duration, cond func(string) bool) string {
	h.t.Helper()
	deadline := time.Now().Add(d)
	var last string
	for time.Now().Before(deadline) {
		out, _ := h.zhxOut("status", "GOAL")
		last = out
		if cond(out) {
			return out
		}
		time.Sleep(200 * time.Millisecond)
	}
	h.t.Fatalf("condition not met (%s); last status:\n%s", desc, last)
	return last
}

func TestEndToEndFlowWithCrashRecovery(t *testing.T) {
	h := newHarness(t)

	out, err := h.zhxOut("goal", "new", "--title", "e2e goal", "--origin", "verify the loop", "--objective", "complete through mock pi")
	if err != nil {
		t.Fatalf("goal new: %v\n%s", err, out)
	}
	goalID := strings.TrimSpace(out)

	if out, err := h.zhxOut("fact", "add", goalID, "--content", "seed fact", "--creator", "tester"); err != nil {
		t.Fatalf("fact add: %v\n%s", err, out)
	}

	// Phase 1 — slow agent; crash the engine mid-execute.
	runner := h.startRunner("MOCK_SCENARIO=flow", "MOCK_DELAY_MS=15000")

	// wait until a step is running (decide declared it, execute claimed it)
	deadline := time.Now().Add(20 * time.Second)
	running := false
	for time.Now().Before(deadline) {
		out, _ = h.zhxOut("status", goalID)
		if strings.Contains(out, "running") {
			running = true
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !running {
		killTree(runner)
		t.Fatalf("step never reached running state; status:\n%s", out)
	}

	killTree(runner) // hard crash simulation

	// The killed engine leaves the step running in the DB.
	out, _ = h.zhxOut("status", goalID)
	if !strings.Contains(out, "running") {
		t.Fatalf("step should still be running after crash:\n%s", out)
	}

	// Phase 2 — restart with a fast agent; recovery must return the
	// orphaned step to the queue and the loop must drive the goal to
	// completed.
	runner2 := h.startRunner("MOCK_SCENARIO=flow", "MOCK_DELAY_MS=15")
	defer killTree(runner2)

	done := make(chan string, 1)
	go func() {
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			o, _ := h.zhxOut("status", goalID)
			if strings.Contains(o, "completed") {
				done <- o
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
		done <- ""
	}()
	select {
	case o := <-done:
		if o == "" {
			t.Fatal("goal did not complete after restart")
		}
	case <-time.After(35 * time.Second):
		t.Fatal("goal completion poll timed out")
	}

	// Recovery must be visible in the audit trail.
	audit, _ := h.zhxOut("audit", goalID)
	if !strings.Contains(audit, "step.reclaimed") {
		t.Fatalf("no step.reclaimed audit entry after restart:\n%s", audit)
	}

	// Findings must exist and at least one be promoted to a fact.
	detail, _ := h.zhxOut("status", goalID)
	if !strings.Contains(detail, "promoted") {
		t.Fatalf("no promoted finding in final state:\n%s", detail)
	}
	yamlOut, _ := h.zhxOut("export", goalID)
	for _, want := range []string{"objective: complete through mock pi", "facts:", "steps:", "findings:"} {
		if !strings.Contains(yamlOut, want) {
			t.Fatalf("export missing %q:\n%s", want, yamlOut)
		}
	}
	fmt.Fprintln(os.Stderr, "e2e final status:\n"+detail)
}
