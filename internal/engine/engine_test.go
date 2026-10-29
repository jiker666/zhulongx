package engine

import (
	"context"
	"errors"
	"fmt"
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

func TestExecuteRepairSalvagesMissingJSON(t *testing.T) {
	// The agent does the work but its final turn carries no JSON (truncated
	// turn / compaction cut). One repair round on the same runner must
	// rescue the report instead of re-running the whole step.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"the step"}]}}`),
		ok("I found the flag but here is only narrative, no object"),
		ok(`{"accepted":true,"data":{"finding":{"content":"salvaged by repair","evidence":"e"}}}`),
	)
	g, _ := st.CreateGoal(ctx, "repair", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)

	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepDone {
		t.Fatalf("repair should finish the step on attempt 1: %+v", steps[0])
	}
}

func TestExecuteRepairFailsThenRetries(t *testing.T) {
	// Both the report and the repair round miss the contract → ordinary
	// retryable failure; a later clean attempt still finishes the step.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"the step"}]}}`),
		ok("narrative only, no object"),
		ok("still no object"),
		ok(`{"accepted":true,"data":{"finding":{"content":"clean retry","evidence":"e"}}}`),
	)
	g, _ := st.CreateGoal(ctx, "repairfail", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)

	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepPending {
		t.Fatalf("double miss should be retryable: %+v", steps[0])
	}

	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepDone {
		t.Fatalf("valid retry should finish: %+v", steps[0])
	}
}

func TestStepGateDefersClaim(t *testing.T) {
	// With the gate closed the step must stay pending and no runner turn
	// may be spent on it; opening the gate lets the ordinary flow run.
	ctx := context.Background()
	e, st, fr := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"the step"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"done","evidence":"e"}}}`),
	)
	g, _ := st.CreateGoal(ctx, "gated", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)

	gateOpen := false
	e.StepGate = func(context.Context, string) bool { return gateOpen }

	e.scheduleGoal(ctx, g.ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepPending {
		t.Fatalf("closed gate must defer the step: %+v", steps[0])
	}
	if len(fr.queue) != 1 {
		t.Fatalf("closed gate must not spend runner turns, queue left: %d", len(fr.queue))
	}

	gateOpen = true
	e.scheduleGoal(ctx, g.ID)
	e.wg.Wait()
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepDone {
		t.Fatalf("open gate should run the step: %+v", steps[0])
	}
}

func TestGoalStepBudgetStopsAndRequeuesPass2(t *testing.T) {
	// One done step exhausts GoalStepBudget=1: the goal stops instead of
	// spending another Decide round, and is requeued IMMEDIATELY (run 41925:
	// a drain-gated requeue never fires on a 63-challenge queue) as a pass-2
	// goal seeded with the ledger fact.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s1"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"did s1","evidence":"e"}}}`),
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"p2 step"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"did p2","evidence":"e"}}}`),
	)
	e.cfg.Runtime.GoalStepBudget = 1
	e.cfg.Runtime.RunDeadline = cfg.Duration(time.Hour)
	e.startedAt = time.Now()

	g, _ := st.CreateGoal(ctx, "budget", "origin-x", "objective-x")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)

	e.scheduleGoal(ctx, g.ID) // budget hit → stop + immediate pass-2 requeue, no extra Decide round
	got, _ := st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalStopped {
		t.Fatalf("budget must stop the goal: %s", got.Status)
	}
	goals, _ := st.ListGoals(ctx)
	if len(goals) != 2 || goals[1].Title != "budget" {
		t.Fatalf("pass-2 goal missing right after stop: %+v", goals)
	}
	facts, _ := st.ListFacts(ctx, goals[1].ID)
	if len(facts) == 0 || !strings.Contains(facts[len(facts)-1].Content, "第二遍") {
		t.Fatalf("pass-2 seed fact missing: %+v", facts)
	}

	// Pass-2 goal exhausting its budget must NOT spawn a pass 3.
	e.decide(ctx, goals[1].ID, "initial")
	steps2, _ := st.ListSteps(ctx, goals[1].ID)
	st.ClaimNextStep(ctx, goals[1].ID, "zhulongx")
	e.executeStep(ctx, goals[1].ID, steps2[0].ID)
	e.scheduleGoal(ctx, goals[1].ID)
	goals, _ = st.ListGoals(ctx)
	if len(goals) != 2 {
		t.Fatalf("no third pass allowed: %d goals", len(goals))
	}
}

func TestGoalWallBudgetStops(t *testing.T) {
	// GoalWallBudget counts from the first step claimed through the real
	// scheduling path; an expired clock stops the goal before any new work.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s1"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"done","evidence":"e"}}}`),
	)
	e.cfg.Runtime.GoalWallBudget = cfg.Duration(time.Minute)
	fake := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return fake }

	g, _ := st.CreateGoal(ctx, "wall", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")

	e.scheduleGoal(ctx, g.ID) // claims at fake T0 and runs the step
	e.wg.Wait()
	fake = fake.Add(2 * time.Minute)
	e.scheduleGoal(ctx, g.ID)
	got, _ := st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalStopped {
		t.Fatalf("wall budget must stop the goal: %s", got.Status)
	}
}

func TestRequeueRespectsDeadline(t *testing.T) {
	// A run deadline already within the 10-minute floor forbids requeueing.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s1"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"did s1","evidence":"e"}}}`),
	)
	e.cfg.Runtime.GoalStepBudget = 1
	e.cfg.Runtime.RunDeadline = cfg.Duration(time.Minute)
	e.startedAt = time.Now().Add(-2 * time.Minute) // deadline already ~past

	g, _ := st.CreateGoal(ctx, "deadline", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)
	e.scheduleGoal(ctx, g.ID) // stop → immediate requeue attempt, blocked by deadline
	e.tick(ctx)
	goals, _ := st.ListGoals(ctx)
	if len(goals) != 1 {
		t.Fatalf("past-deadline requeue forbidden: %d goals", len(goals))
	}
}

func TestExecuteWaitingSlotDefersStep(t *testing.T) {
	// A WAITING_SLOT report is scheduling state: the step returns to pending
	// at zero attempt cost, produces no finding, and stays claimable — the
	// gate re-admits the goal when a container slot frees (run 41925: d-02
	// burned model rounds narrating waits and never re-entered).
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s1"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"WAITING_SLOT: no challenge container yet"}}}`),
	)
	g, _ := st.CreateGoal(ctx, "wait", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)

	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepPending {
		t.Fatalf("WAITING_SLOT must defer the step: %+v", steps[0])
	}
	if steps[0].Attempts != 1 || steps[0].LastError != "" {
		t.Fatalf("deferral costs only the claim, no failure cycle: %+v", steps[0])
	}
	if steps[0].FindingID != "" {
		t.Fatalf("deferral must not record a finding: %+v", steps[0])
	}
	if _, err := st.ClaimNextStep(ctx, g.ID, "zhulongx"); err != nil {
		t.Fatalf("deferred step must be claimable again: %v", err)
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

// countingBlockRunner blocks in Prompt (like blockingRunner) but counts
// calls, so the test can prove how many Decide rounds actually started.
type countingBlockRunner struct {
	mu    sync.Mutex
	calls int
}

func (c *countingBlockRunner) Prompt(ctx context.Context, _ string) (*pi.PromptResult, error) {
	c.mu.Lock()
	c.calls++
	c.mu.Unlock()
	<-ctx.Done()
	return nil, ctx.Err()
}

func (c *countingBlockRunner) Close() error { return nil }

func (c *countingBlockRunner) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

func TestDecideIsGloballySerial(t *testing.T) {
	ctx := context.Background()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := cfg.Default()
	c.Runtime.TickInterval = cfg.Duration(5 * time.Millisecond)
	r := &countingBlockRunner{}
	e := New(st, c, slog.New(slog.NewTextHandler(&strings.Builder{}, nil)),
		func() (Runner, error) { return r, nil })

	if _, err := st.CreateGoal(ctx, "one", "o", "obj"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateGoal(ctx, "two", "o", "obj"); err != nil {
		t.Fatal(err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	go e.Run(runCtx)
	defer func() { cancel(); e.Stop() }()

	// goal 1's initial Decide starts and blocks; goal 2's initial Decide
	// must NOT start while the global Decide slot is held.
	waitFor(t, 3*time.Second, func() bool { return r.count() == 1 },
		"first decide round never started")
	time.Sleep(200 * time.Millisecond) // >> several ticks for goal 2 to slip in
	if got := r.count(); got != 1 {
		t.Fatalf("Decide is not globally serial: %d rounds started", got)
	}
}

func TestExecutePolicyViolationIsPermanent(t *testing.T) {
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"the step"}]}}`),
		failWith(fmt.Errorf("%w: command matched (?i)rm\\s+-rf", pi.ErrPolicyViolation)),
	)
	g, _ := st.CreateGoal(ctx, "policy", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	if len(steps) != 1 {
		t.Fatalf("no step declared: %+v", steps)
	}
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)
	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepFailed || steps[0].Attempts != 1 {
		t.Fatalf("policy violation must fail fast without retry: %+v", steps[0])
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

func TestNoopGuardRescueHint(t *testing.T) {
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{}}`),
		ok(`{"accepted":true,"data":{}}`),
		ok(`{"accepted":true,"data":{}}`),
		ok(`{"accepted":true,"data":{}}`),
	)
	g, _ := st.CreateGoal(ctx, "rescue", "o", "obj")
	calls := 0
	e.NoopRescue = func(_ context.Context, goalID string) (string, bool) {
		calls++
		return "try the username field", true
	}
	e.decide(ctx, g.ID, "initial") // noop 1
	e.decide(ctx, g.ID, "tick")    // noop 2 -> at limit: rescue fires
	if calls != 1 {
		t.Fatalf("rescue calls = %d, want 1", calls)
	}
	hints, err := st.ListHints(ctx, g.ID)
	if err != nil || len(hints) != 1 || !strings.Contains(hints[0].Content, "username field") {
		t.Fatalf("rescue hint not written: %v %+v", err, hints)
	}
	got, _ := st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalActive {
		t.Fatalf("goal should survive the rescue, got %s", got.Status)
	}
	e.decide(ctx, g.ID, "tick") // noop 1 after rescue
	e.decide(ctx, g.ID, "tick") // noop 2 -> rescue already fired, now stop
	if calls != 1 {
		t.Fatalf("rescue must fire once per goal, calls = %d", calls)
	}
	got, _ = st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalStopped {
		t.Fatalf("goal should stop after the guided round, got %s", got.Status)
	}
}
