package engine

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"zhulongx/internal/cfg"
	"zhulongx/internal/fgs"
	"zhulongx/internal/pi"
	"zhulongx/internal/store"
)

// fakeRunner plays a scripted sequence of responses across every runner
// launch (one per Decide round / Execute attempt).
type fakeRunner struct {
	mu     sync.Mutex
	queue  []func(msg string) (*pi.PromptResult, error)
	closed int
}

func (f *fakeRunner) Prompt(_ context.Context, msg string) (*pi.PromptResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.queue) == 0 {
		return nil, errors.New("script exhausted")
	}
	next := f.queue[0]
	f.queue = f.queue[1:]
	return next(msg)
}

func (f *fakeRunner) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed++
	return nil
}

func ok(text string) func(string) (*pi.PromptResult, error) {
	return func(string) (*pi.PromptResult, error) {
		return &pi.PromptResult{Disposition: "started", Text: text}, nil
	}
}

func failWith(err error) func(string) (*pi.PromptResult, error) {
	return func(string) (*pi.PromptResult, error) { return nil, err }
}

func newEngine(t *testing.T, script ...func(string) (*pi.PromptResult, error)) (*Engine, *store.Store, *fakeRunner) {
	t.Helper()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	fr := &fakeRunner{queue: append([]func(string) (*pi.PromptResult, error){}, script...)}
	c := cfg.Default()
	c.Runtime.TickInterval = cfg.Duration(5 * time.Millisecond)
	c.Runtime.StepMaxAttempts = 2
	c.Runtime.DecideNoopLimit = 2
	c.Pi.SpawnRetries = 0
	e := New(st, c, slog.New(slog.NewTextHandler(&strings.Builder{}, nil)), func() (Runner, error) {
		return fr, nil
	})
	return e, st, fr
}

func TestEngineClosedLoopToCompletion(t *testing.T) {
	// ValidateDecide requires from non-empty — seed a fact first, then
	// reference it.
	ctx := context.Background()
	script := []func(string) (*pi.PromptResult, error){
		// decide #1: declare one step from the human fact
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"recon the target"}]}}`),
		// execute #1: produce a finding
		ok(`{"accepted":true,"data":{"finding":{"content":"target exposes api v2","evidence":"curl output 200"}}`),
		// decide #2: promote the finding, then complete from the new fact
		ok(`{"accepted":true,"data":{"findings":{"promote":["fd_0001"],"discard":[]},"complete":{"from":["f_0002"],"description":"objective met"}}}`),
	}
	e, st, _ := newEngine(t, script...)
	g, err := st.CreateGoal(ctx, "loop", "origin", "objective")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddHumanFact(ctx, g.ID, "seed fact", "tester"); err != nil {
		t.Fatal(err)
	}

	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	if len(steps) != 1 || steps[0].Status != fgs.StepPending {
		t.Fatalf("after decide#1: %+v", steps)
	}

	claimed, err := st.ClaimNextStep(ctx, g.ID, "zhulongx")
	if err != nil {
		t.Fatal(err)
	}
	e.executeStep(ctx, g.ID, claimed.ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepDone || steps[0].FindingID == "" {
		t.Fatalf("after execute: %+v", steps[0])
	}

	e.decide(ctx, g.ID, "findings grew")
	fds, _ := st.ListFindings(ctx, g.ID, false)
	if len(fds) != 1 || fds[0].Status != fgs.FindingPromoted || fds[0].FactID != "f_0002" {
		t.Fatalf("finding not promoted: %+v", fds)
	}
	got, _ := st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalCompleted {
		t.Fatalf("goal status: %s", got.Status)
	}
}

func TestExecuteRetryableThenExhaustion(t *testing.T) {
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"the step"}]}}`),
		failWith(pi.ErrProcessExit),
		failWith(pi.ErrProcessExit),
	)
	g, _ := st.CreateGoal(ctx, "retry", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	if len(steps) != 1 {
		t.Fatalf("no step declared: %+v", steps)
	}
	// attempt 1: crash → pending (attempts=1, max=2)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepPending {
		t.Fatalf("after crash#1: %+v", steps[0])
	}
	// attempt 2: crash again → failed (exhausted)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepFailed {
		t.Fatalf("after crash#2: %+v", steps[0])
	}
}

func TestExecutePermanentPermissionDenied(t *testing.T) {
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"the step"}]}}`),
		failWith(errors.New("pi: command failed: bash: permission denied")),
	)
	g, _ := st.CreateGoal(ctx, "perm", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepFailed || steps[0].Attempts != 1 {
		t.Fatalf("permission denial must fail fast: %+v", steps[0])
	}
}

func TestExecuteInvalidOutputIsRetryable(t *testing.T) {
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"the step"}]}}`),
		ok("I looked around and everything seems fine, no JSON here"),
		ok(`{"accepted":true,"data":{"finding":{"content":"valid after retry","evidence":"e"}}}`),
	)
	g, _ := st.CreateGoal(ctx, "garbage", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)

	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepPending {
		t.Fatalf("garbage output should be retryable: %+v", steps[0])
	}

	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepDone {
		t.Fatalf("valid retry should finish: %+v", steps[0])
	}
}

func TestDecideNoopGuardStopsGoal(t *testing.T) {
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{}}`),
		ok(`{"accepted":true,"data":{}}`),
	)
	g, _ := st.CreateGoal(ctx, "noop", "o", "obj")
	e.decide(ctx, g.ID, "initial")
	e.decide(ctx, g.ID, "tick")
	got, _ := st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalStopped {
		t.Fatalf("noop guard should stop goal, got %s", got.Status)
	}
}

func TestDecideInvalidFromFactSkipsStep(t *testing.T) {
	ctx := context.Background()
	e, st, _ := newEngine(t,
		// references a fact that does not exist → step skipped
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_9999"],"description":"phantom"}]}}`),
	)
	g, _ := st.CreateGoal(ctx, "phantom", "o", "obj")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	if len(steps) != 0 {
		t.Fatalf("phantom step must not be created: %+v", steps)
	}
}

// blockingRunner hangs in Prompt until its context is cancelled, letting
// the test observe scheduling state without the script being consumed.
type blockingRunner struct{}

func (blockingRunner) Prompt(ctx context.Context, _ string) (*pi.PromptResult, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func (blockingRunner) Close() error { return nil }

func TestStartupRecovery(t *testing.T) {
	ctx := context.Background()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := cfg.Default()
	c.Runtime.TickInterval = cfg.Duration(5 * time.Millisecond)
	c.Runtime.ExecuteTimeout = cfg.Duration(30 * time.Second)
	c.Runtime.StepMaxAttempts = 3 // shutdown consumes attempt 2 of 3 → retry stays pending
	e := New(st, c, slog.New(slog.NewTextHandler(&strings.Builder{}, nil)),
		func() (Runner, error) { return blockingRunner{}, nil })

	g, _ := st.CreateGoal(ctx, "recover", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	// simulate a crash: leave a step claimed as running
	s1, _ := st.CreateStep(ctx, g.ID, "in flight", nil, fgs.ActorDecide)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")

	runCtx, cancel := context.WithCancel(ctx)
	go e.Run(runCtx)

	// Recovery is proven by the audit trail, which survives the scheduler
	// immediately re-claiming the step.
	waitFor(t, 3*time.Second, func() bool {
		entries, err := st.ListAudit(ctx, g.ID, 50)
		if err != nil {
			return false
		}
		for _, a := range entries {
			if a.Action == "step.reclaimed" && a.Entity == "step:"+s1.ID {
				return true
			}
		}
		return false
	}, "startup recovery did not reclaim the running step")

	cancel()
	e.Stop()

	// After shutdown the re-claimed attempt fails as retryable (attempt 2
	// of 3) and the step returns to pending.
	waitFor(t, 3*time.Second, func() bool {
		steps, _ := st.ListSteps(ctx, g.ID)
		return len(steps) == 1 && steps[0].Status == fgs.StepPending && steps[0].Attempts == 2
	}, "step did not settle to pending after shutdown")
}

func waitFor(t *testing.T, d time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(msg)
}

func TestFullLoopScheduling(t *testing.T) {
	// drive the real Run loop end-to-end with scripted runners
	ctx := context.Background()
	script := []func(string) (*pi.PromptResult, error){
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"step one"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"finding one","evidence":"e1"}}}`),
		ok(`{"accepted":true,"data":{"findings":{"promote":["fd_0001"],"discard":[]},"complete":{"from":["f_0002"],"description":"done"}}}`),
	}
	e, st, _ := newEngine(t, script...)
	g, _ := st.CreateGoal(ctx, "loop", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")

	runCtx, cancel := context.WithCancel(ctx)
	go e.Run(runCtx)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		got, err := st.GetGoal(ctx, g.ID)
		if err == nil && got.Status == fgs.GoalCompleted {
			cancel()
			e.Stop()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	e.Stop()
	t.Fatal("goal did not complete through the scheduling loop")
}
