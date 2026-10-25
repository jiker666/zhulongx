package pi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// buildMock compiles mockpi once for the test binary run and returns its path.
func buildMock(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "mockpi.exe")
	cmd := exec.Command("go", "build", "-o", bin, "zhulongx/internal/pi/mockpi")
	cmd.Env = append(os.Environ(), "GOFLAGS=")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build mockpi: %v\n%s", err, out)
	}
	return bin
}

func launch(t *testing.T, bin, scenario string, env ...string) *Adapter {
	t.Helper()
	a, err := Start(LaunchConfig{
		Command: bin,
		Env:     append([]string{fmt.Sprintf("MOCK_SCENARIO=%s", scenario)}, env...),
	})
	if err != nil {
		t.Fatalf("start mockpi: %v", err)
	}
	t.Cleanup(func() { a.Close() })
	return a
}

func TestPromptNormalFlow(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "normal", "MOCK_FINAL_TEXT=hello final")
	res, err := a.Prompt(context.Background(), "do the thing")
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if res.Text != "hello final" {
		t.Fatalf("text (get_last_assistant_text preferred): %q", res.Text)
	}
}

func TestPromptStreamedFallback(t *testing.T) {
	// get_last_assistant_text returns empty → adapter must fall back to the
	// streamed message_end content.
	bin := buildMock(t)
	a := launch(t, bin, "no_text", "MOCK_FINAL_TEXT=whatever")
	res, err := a.Prompt(context.Background(), "go")
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	// get_last_assistant_text returned "" — the streamed message_end content
	// must still come through; a broken fallback would yield "".
	if res.Text != "whatever" {
		t.Fatalf("streamed fallback text: %q", res.Text)
	}
}

func TestPromptGarbageLinesIgnored(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "garbage")
	res, err := a.Prompt(context.Background(), "go")
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	found := false
	for _, e := range res.Events {
		if strings.Contains(e, "unparseable") {
			found = true
		}
	}
	if !found {
		t.Fatalf("garbage line not recorded in events: %v", res.Events)
	}
}

func TestPromptToolUseCounted(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "tool_use")
	res, err := a.Prompt(context.Background(), "go")
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if res.ToolCalls != 1 {
		t.Fatalf("tool calls: %d", res.ToolCalls)
	}
}

func TestSettledBeforeResponse(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "handled")
	res, err := a.Prompt(context.Background(), "go")
	if err != nil {
		t.Fatalf("handled: %+v %v", res, err)
	}
}

func TestCommandFailure(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "cmd_fail")
	_, err := a.Prompt(context.Background(), "go")
	if !errors.Is(err, ErrProtocol) {
		t.Fatalf("want ErrProtocol, got %v", err)
	}
}

func TestCrashBeforeResponse(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "crash")
	_, err := a.Prompt(context.Background(), "go")
	if !errors.Is(err, ErrProcessExit) {
		t.Fatalf("want ErrProcessExit, got %v", err)
	}
	if !strings.Contains(err.Error(), "exit=3") {
		t.Fatalf("exit code surfaced: %v", err)
	}
}

func TestExitDuringRun(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "exit_late")
	_, err := a.Prompt(context.Background(), "go")
	if !errors.Is(err, ErrProcessExit) {
		t.Fatalf("want ErrProcessExit, got %v", err)
	}
}

func TestTimeoutCancelsAndKills(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "no_settled")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := a.Prompt(ctx, "go")
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("want ErrTimeout, got %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("timeout took too long: %v", time.Since(start))
	}
	select {
	case <-a.exited:
	case <-time.After(6 * time.Second):
		t.Fatal("process not killed after timeout")
	}
}

func TestSecondPromptReusesProcess(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "normal")
	if _, err := a.Prompt(context.Background(), "first"); err != nil {
		t.Fatalf("first: %v", err)
	}
	res, err := a.Prompt(context.Background(), "second")
	if err != nil {
		t.Fatalf("second: %+v %v", res, err)
	}
}

func TestCloseIsGracefulAndIdempotent(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "normal")
	if err := a.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := a.Close(); err != nil {
		t.Fatalf("close twice: %v", err)
	}
	select {
	case <-a.exited:
	case <-time.After(6 * time.Second):
		t.Fatal("process did not exit on stdin close")
	}
	if _, err := a.Prompt(context.Background(), "after close"); !errors.Is(err, ErrClosed) {
		t.Fatalf("prompt after close: %v", err)
	}
}

func TestToolPolicyViolationAbortsMidRun(t *testing.T) {
	bin := buildMock(t)
	policy, err := CompileToolPolicy([]string{`rm\s+-rf`})
	if err != nil {
		t.Fatal(err)
	}
	a, err := Start(LaunchConfig{
		Command: bin,
		Policy:  policy,
		Env:     []string{"MOCK_SCENARIO=policy_violation"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	start := time.Now()
	_, err = a.Prompt(context.Background(), "go")
	if !errors.Is(err, ErrPolicyViolation) {
		t.Fatalf("want ErrPolicyViolation, got %v", err)
	}
	if !strings.Contains(err.Error(), "rm") {
		t.Fatalf("violation should name the matched pattern: %v", err)
	}
	// settled fires 2s after the banned command; aborting at the violation
	// must beat it by a wide margin
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("policy abort arrived late (waited for settled?): %v", elapsed)
	}
}

func TestToolPolicyAllowsUnmatchedCommands(t *testing.T) {
	bin := buildMock(t)
	policy, err := CompileToolPolicy([]string{"shutdown"})
	if err != nil {
		t.Fatal(err)
	}
	a, err := Start(LaunchConfig{
		Command: bin,
		Policy:  policy,
		Env:     []string{"MOCK_SCENARIO=tool_use"}, // runs "nmap -sV target"
	})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	res, err := a.Prompt(context.Background(), "go")
	if err != nil {
		t.Fatalf("unmatched command must not trip the policy: %v", err)
	}
	if res.ToolCalls != 1 {
		t.Fatalf("tool calls: %d", res.ToolCalls)
	}
}

func TestStderrIsDiagnosticsOnly(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "stderr_noise")
	res, err := a.Prompt(context.Background(), "go")
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	_ = res
	tail := a.StderrTail(4)
	if !strings.Contains(tail, "irrelevant stderr chatter") {
		t.Fatalf("stderr captured: %q", tail)
	}
}

// Older documented pi builds emitted agent_settled as the completion
// marker; the adapter must complete on it just like on agent_end.
func TestLegacySettledEvent(t *testing.T) {
	bin := buildMock(t)
	a := launch(t, bin, "legacy_settled", "MOCK_FINAL_TEXT=legacy ok")
	res, err := a.Prompt(context.Background(), "do the thing")
	if err != nil {
		t.Fatalf("prompt: %v", err)
	}
	if res.Text != "legacy ok" {
		t.Fatalf("text: %q", res.Text)
	}
}
