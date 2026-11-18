package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
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

func TestRunnerCapacityErrorIsDeferred(t *testing.T) {
	for _, msg := range []string{
		"runner launch failed: paging file is too small for this operation to complete",
		"fork/exec pi: resource temporarily unavailable",
		"cannot allocate memory",
	} {
		if !isRunnerCapacityError(errors.New(msg)) {
			t.Fatalf("capacity error not recognized: %q", msg)
		}
	}
	for _, msg := range []string{
		"fork/exec pi: no such file or directory",
		"pi: command failed: invalid protocol",
	} {
		if isRunnerCapacityError(errors.New(msg)) {
			t.Fatalf("non-capacity error misclassified: %q", msg)
		}
	}
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
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"p3 step"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"did p3","evidence":"e"}}}`),
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
	if len(facts) == 0 || !strings.Contains(facts[len(facts)-1].Content, "遍进攻") {
		t.Fatalf("pass-2 seed fact missing: %+v", facts)
	}

	// Pass-2 goal exhausting its budget spawns a pass 3 (the hardest
	// challenges need three looks), but a pass-3 stop is final.
	e.decide(ctx, goals[1].ID, "initial")
	steps2, _ := st.ListSteps(ctx, goals[1].ID)
	st.ClaimNextStep(ctx, goals[1].ID, "zhulongx")
	e.executeStep(ctx, goals[1].ID, steps2[0].ID)
	e.scheduleGoal(ctx, goals[1].ID)
	goals, _ = st.ListGoals(ctx)
	if len(goals) != 3 {
		t.Fatalf("pass-3 goal missing after pass-2 stop: %d goals", len(goals))
	}
	e.decide(ctx, goals[2].ID, "initial")
	steps3, _ := st.ListSteps(ctx, goals[2].ID)
	st.ClaimNextStep(ctx, goals[2].ID, "zhulongx")
	e.executeStep(ctx, goals[2].ID, steps3[0].ID)
	e.scheduleGoal(ctx, goals[2].ID)
	goals, _ = st.ListGoals(ctx)
	if len(goals) != 3 {
		t.Fatalf("no fourth pass allowed: %d goals", len(goals))
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
	// +5m: past the 1m wall budget AND past the 3m active-grace window —
	// a step that landed 5 minutes before the deadline check means the
	// goal went quiet, not mid-flow.
	fake = fake.Add(5 * time.Minute)
	e.scheduleGoal(ctx, g.ID)
	got, _ := st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalStopped {
		t.Fatalf("wall budget must stop the goal: %s", got.Status)
	}
}

func TestSlotStarvedWallFreezesInsteadOfAgingOut(t *testing.T) {
	// Run 46196 (e3-02): the title's only claimed step was a 27-second 409
	// → WAITING_SLOT deferral; the goal then sat in the queue while its 30m
	// wall budget burned as calendar time and the pass died unread. With
	// every container slot busy (StepGate closed) an exhausted wall must
	// re-anchor instead of stopping the goal — queue wait is not attack
	// time. The moment a slot frees, the calendar counts again and the stop
	// lands exactly as before.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.GoalWallBudget = cfg.Duration(time.Minute)
	fake := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return fake }
	g, _ := st.CreateGoal(ctx, "starved", "o", "obj")

	gateOpen := false
	e.StepGate = func(context.Context, string) bool { return gateOpen }
	e.mu.Lock()
	e.firstClaim[g.ID] = fake.Add(-5 * time.Minute) // wall long gone, zero steps ever landed
	e.mu.Unlock()

	if over, why := e.goalOverBudget(ctx, g.ID); over {
		t.Fatalf("slot-starved goal must not age out on queue wait (%s)", why)
	}
	e.mu.Lock()
	anchored := e.firstClaim[g.ID]
	e.mu.Unlock()
	if !anchored.Equal(fake) {
		t.Fatalf("wall clock must re-anchor to now while gate-closed, got %s", anchored)
	}

	fake = fake.Add(2 * time.Minute) // inside the re-anchored window
	if over, _ := e.goalOverBudget(ctx, g.ID); over {
		t.Fatal("re-anchored goal must stay alive inside the fresh window")
	}

	gateOpen = true
	fake = fake.Add(5 * time.Minute) // slot freed — wall spent for real now
	over, why := e.goalOverBudget(ctx, g.ID)
	if !over || !strings.Contains(why, "wall budget exhausted") {
		t.Fatalf("gate-open exhausted wall must stop the goal, got over=%v why=%s", over, why)
	}
}

func TestFirstTouchRequiresRealWork(t *testing.T) {
	// Run 46196 (e3-02): the claim-time touch mark turned one 27-second
	// 409 → WAITING_SLOT deferral into "worked forever" — the title lost the
	// first-touch fairness sort and the endgame never-touched rank and never
	// saw a container again while five already-failed titles got second
	// helpings. A deferral must stay free; only a step that FINISHES with
	// real output marks the title worked.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s1"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"WAITING_SLOT: no challenge container yet"}}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"recon mapped","evidence":"e"}}}`),
	)
	g, _ := st.CreateGoal(ctx, "wait", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID) // deferred: no finding, no touch

	if e.titleTouched("wait") {
		t.Fatal("a WAITING_SLOT deferral must not mark the title worked")
	}

	if _, err := st.ClaimNextStep(ctx, g.ID, "zhulongx"); err != nil {
		t.Fatalf("deferred step must be claimable again: %v", err)
	}
	e.executeStep(ctx, g.ID, steps[0].ID) // real report lands
	if !e.titleTouched("wait") {
		t.Fatal("a finished step with real output must mark the title worked")
	}
}

func TestEndgameBudgetsDeepenInHarvestWindow(t *testing.T) {
	// Run 42838 walls died one or two moves short of the flag with the next
	// move already named in the ledger — 30m/6-step pass caps fit first-touch
	// recon, not deep chains (keystream batteries, locked-suffix write
	// primitives, 30k-entry internal fuzzes). In the harvest window the
	// budgets deepen; mid-run they stay tight so breadth keeps its slots.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.RunDeadline = cfg.Duration(6 * time.Hour)
	e.cfg.Runtime.EndgameAfter = cfg.Duration(5 * time.Hour)
	e.cfg.Runtime.GoalStepBudget = 6
	e.cfg.Runtime.GoalWallBudget = cfg.Duration(30 * time.Minute)
	e.cfg.Runtime.EndgameStepBudget = 10
	e.cfg.Runtime.EndgameWallBudget = cfg.Duration(45 * time.Minute)

	e.startedAt = e.now() // mid-run
	if got := e.stepBudgetFor("bench:b-01"); got != 6 {
		t.Fatalf("mid-run step budget: %d", got)
	}
	if got := e.wallBudgetFor("bench:b-01"); got != 30*time.Minute {
		t.Fatalf("mid-run wall budget: %s", got)
	}

	g, _ := st.CreateGoal(ctx, "deep", "o", "obj")
	e.FlagProgress = func(title string) (int, int, bool) {
		if title == "deep" {
			return 1, 2, true // banked: deep endgame budgets apply
		}
		return 0, 0, false
	}
	e.mu.Lock()
	e.firstClaim[g.ID] = e.now().Add(-40 * time.Minute) // 10m past the mid-run cap
	e.mu.Unlock()
	if over, why := e.goalOverBudget(ctx, g.ID); !over {
		t.Fatalf("mid-run 40m against a 30m cap must be over budget (%s)", why)
	}

	e.startedAt = e.now().Add(-5 * time.Hour) // inside the harvest window
	if got := e.stepBudgetFor("deep"); got != 10 {
		t.Fatalf("endgame step budget: %d", got)
	}
	if got := e.wallBudgetFor("deep"); got != 45*time.Minute {
		t.Fatalf("endgame wall budget: %s", got)
	}
	if over, why := e.goalOverBudget(ctx, g.ID); over {
		t.Fatalf("40m against the 45m harvest cap must keep going (%s)", why)
	}
}

func TestPartialMultiFlagBudgetsDeepenBeforeEndgame(t *testing.T) {
	e, _, _ := newEngine(t)
	e.cfg.Runtime.GoalStepBudget = 6
	e.cfg.Runtime.GoalWallBudget = cfg.Duration(30 * time.Minute)
	e.cfg.Runtime.MultiFlagStepBudget = 12
	e.cfg.Runtime.MultiFlagWallBudget = cfg.Duration(60 * time.Minute)
	e.cfg.Runtime.RunDeadline = cfg.Duration(6 * time.Hour)
	e.cfg.Runtime.EndgameAfter = cfg.Duration(time.Hour)
	e.FlagProgress = func(title string) (int, int, bool) {
		switch title {
		case "bench:partial-multi":
			return 2, 6, true
		case "bench:untouched-multi":
			return 0, 6, true
		case "bench:single":
			return 0, 1, true
		default:
			return 0, 0, false
		}
	}
	e.mu.Lock()
	e.startedAt = time.Now().Add(-time.Hour)
	e.mu.Unlock()

	if got := e.stepBudgetFor("bench:partial-multi"); got != 12 {
		t.Fatalf("partial multi-flag step budget = %d, want 12", got)
	}
	if got := e.wallBudgetFor("bench:partial-multi"); got != 60*time.Minute {
		t.Fatalf("partial multi-flag wall budget = %v, want 60m", got)
	}
	for _, title := range []string{"bench:untouched-multi", "bench:single"} {
		if got := e.stepBudgetFor(title); got != 6 {
			t.Fatalf("%s step budget = %d, want base 6", title, got)
		}
		if got := e.wallBudgetFor(title); got != 30*time.Minute {
			t.Fatalf("%s wall budget = %v, want base 30m", title, got)
		}
	}
	// A smaller endgame override must not erase the deeper partial-multi
	// budget when both policies apply.
	e.cfg.Runtime.EndgameStepBudget = 10
	e.cfg.Runtime.EndgameWallBudget = cfg.Duration(45 * time.Minute)
	e.cfg.Runtime.RunDeadline = cfg.Duration(2 * time.Hour)
	e.cfg.Runtime.EndgameAfter = cfg.Duration(90 * time.Minute)
	e.mu.Lock()
	e.startedAt = time.Now().Add(-40 * time.Minute)
	e.mu.Unlock()
	if got := e.stepBudgetFor("bench:partial-multi"); got != 12 {
		t.Fatalf("endgame must preserve the larger multi-flag step budget, got %d", got)
	}
	if got := e.wallBudgetFor("bench:partial-multi"); got != 60*time.Minute {
		t.Fatalf("endgame must preserve the larger multi-flag wall budget, got %v", got)
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

// deadlineRunner answers the first Prompt (Decide) with a valid steps
// script, then records the deadline its Execute context carries before
// timing out at once — proving the wall-budget cap without waiting it out.
type deadlineRunner struct {
	calls int
	mu    sync.Mutex
	dl    time.Time
	has   bool
}

func (d *deadlineRunner) Prompt(ctx context.Context, _ string) (*pi.PromptResult, error) {
	d.calls++
	if d.calls == 1 {
		return &pi.PromptResult{Text: `{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s1"}]}}`}, nil
	}
	if dl, ok := ctx.Deadline(); ok {
		d.mu.Lock()
		d.dl, d.has = dl, true
		d.mu.Unlock()
	}
	return nil, pi.ErrTimeout
}

func (d *deadlineRunner) Close() error { return nil }

func TestStepTimeoutCappedByWallBudget(t *testing.T) {
	// goalOverBudget never fires while a step runs, so the step's own
	// deadline is the wall budget's only teeth: it must be capped at the
	// budget remaining (plus the terminal-write grace), not left at the
	// full ExecuteTimeout (run 42176: 90m mega-steps pinned three slots
	// 93–110 min against a 45m wall).
	ctx := context.Background()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	c := cfg.Default()
	c.Runtime.TickInterval = cfg.Duration(5 * time.Millisecond)
	c.Runtime.ExecuteTimeout = cfg.Duration(30 * time.Minute)
	c.Runtime.GoalWallBudget = cfg.Duration(10 * time.Minute)
	dr := &deadlineRunner{}
	e := New(st, c, slog.New(slog.NewTextHandler(&strings.Builder{}, nil)),
		func() (Runner, error) { return dr, nil })
	e.now = func() time.Time { return time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC) }

	g, _ := st.CreateGoal(ctx, "cap", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	e.scheduleGoal(ctx, g.ID) // claims at fake T0, spawns the capped step
	e.wg.Wait()

	dr.mu.Lock()
	has, dl := dr.has, dr.dl
	dr.mu.Unlock()
	if !has {
		t.Fatal("execute context must carry a deadline")
	}
	if rem := dl.Sub(time.Now()); rem > 13*time.Minute || rem < 9*time.Minute {
		t.Fatalf("step deadline must be capped at wall budget + grace (~12m), got %s", rem)
	}
}

func TestBudgetStopReleasesContainer(t *testing.T) {
	// Stopping a goal for budget must free its slot at once: the immediate
	// pass-2 requeue keeps the title non-terminal, so the gate's reaper
	// alone would not close it (run 42176: a-05's container idled ~29 min
	// past its stop).
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s1"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"done","evidence":"e"}}}`),
	)
	e.cfg.Runtime.GoalStepBudget = 1
	rel := make(chan string, 1)
	e.ReleaseContainer = func(_ context.Context, goalID string) error { rel <- goalID; return nil }

	g, _ := st.CreateGoal(ctx, "rel", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	e.scheduleGoal(ctx, g.ID) // runs the one budgeted step
	e.wg.Wait()
	e.scheduleGoal(ctx, g.ID) // step budget exhausted → stop → release

	got, _ := st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalStopped {
		t.Fatalf("step budget must stop the goal: %s", got.Status)
	}
	select {
	case gid := <-rel:
		if gid != g.ID {
			t.Fatalf("release must name the stopped goal: %s", gid)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("budget stop must release the challenge container")
	}
}

func TestNoopStopReleasesContainer(t *testing.T) {
	ctx := context.Background()
	e, _, _ := newEngine(t, ok(`{}`), ok(`{}`))
	rel := make(chan string, 1)
	e.ReleaseContainer = func(_ context.Context, goalID string) error { rel <- goalID; return nil }

	g, _ := e.store.CreateGoal(ctx, "nooprel", "o", "obj")
	e.decide(ctx, g.ID, "initial")
	e.decide(ctx, g.ID, "tick")

	select {
	case gid := <-rel:
		if gid != g.ID {
			t.Fatalf("release must name the stopped goal: %s", gid)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("noop stop must release the challenge container")
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

func TestBootstrapDirectAttackSkipsFirstDecide(t *testing.T) {
	// A brand-new goal with bootstrap_step configured gets an engine-declared
	// direct-attack step and NO initial Decide round — the first runner turn
	// is Execute. Decide only enters after the bootstrap finding lands, with
	// real intel instead of a split made at the moment of least information.
	ctx := context.Background()
	e, st, fr := newEngine(t,
		ok(`{"accepted":true,"data":{"finding":{"content":"direct hit: flag captured","evidence":"e"}}}`),
		ok(`{"accepted":true,"data":{"findings":{"promote":["fd_0001"],"discard":[]},"complete":{"from":["f_0001"],"description":"objective met"}}}`),
	)
	e.cfg.Runtime.BootstrapStep = "direct attack"
	g, _ := st.CreateGoal(ctx, "boot", "o", "obj")

	e.scheduleGoal(ctx, g.ID) // declares the bootstrap step, claims it, runs it
	e.wg.Wait()
	steps, _ := st.ListSteps(ctx, g.ID)
	if len(steps) != 1 || steps[0].Producer != "engine:bootstrap" || steps[0].Status != fgs.StepDone {
		t.Fatalf("bootstrap step must be declared by the engine and run first: %+v", steps)
	}

	e.scheduleGoal(ctx, g.ID) // steps drained → Decide reviews the finding and completes
	e.wg.Wait()
	got, _ := st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalCompleted {
		t.Fatalf("goal should complete after bootstrap finding review: %s", got.Status)
	}
	if len(fr.queue) != 0 {
		t.Fatalf("script must be fully consumed (no Decide-first waste), left: %d", len(fr.queue))
	}
}

func TestBootstrapDisabledKeepsDecideFirst(t *testing.T) {
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"classic decomposition"}]}}`),
	)
	g, _ := st.CreateGoal(ctx, "classic", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.scheduleGoal(ctx, g.ID)
	e.wg.Wait()
	steps, _ := st.ListSteps(ctx, g.ID)
	if len(steps) != 1 || steps[0].Producer != fgs.ActorDecide {
		t.Fatalf("without bootstrap_step the first step must come from Decide: %+v", steps)
	}
}

func TestExecuteTimeoutSalvagesFullReport(t *testing.T) {
	// The report streamed out just before the deadline: it must finish the
	// step normally — no failure cycle, no retry attempt burned.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s"}]}}`),
		func(string) (*pi.PromptResult, error) {
			return &pi.PromptResult{
				Text:      `{"accepted":true,"data":{"finding":{"content":"flag captured at the bell","evidence":"e"}}}`,
				ToolCalls: 12,
			}, pi.ErrTimeout
		},
	)
	g, _ := st.CreateGoal(ctx, "salvage", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)

	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepDone || steps[0].Attempts != 1 {
		t.Fatalf("salvaged report must finish the step on attempt 1: %+v", steps[0])
	}
	fds, _ := st.ListFindings(ctx, g.ID, false)
	if len(fds) != 1 || !strings.Contains(fds[0].Content, "flag captured at the bell") {
		t.Fatalf("salvaged finding: %+v", fds)
	}
}

func TestExecuteTimeoutPartialBecomesFinding(t *testing.T) {
	// No parseable report before the deadline: the streamed tail becomes a
	// TIMEOUT_PARTIAL finding and the step is DONE — the partial work enters
	// the graph and no attempt is burned on a from-zero retry.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s"}]}}`),
		func(string) (*pi.PromptResult, error) {
			return &pi.PromptResult{
				Text:   "mid-run narrative: got admin session, exfil in progress",
				Events: []string{"ev1", "ev2"},
			}, pi.ErrTimeout
		},
	)
	g, _ := st.CreateGoal(ctx, "partial", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)

	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepDone || steps[0].Attempts != 1 {
		t.Fatalf("partial salvage must finish (not fail) the step: %+v", steps[0])
	}
	fds, _ := st.ListFindings(ctx, g.ID, false)
	if len(fds) != 1 || !strings.HasPrefix(fds[0].Content, "TIMEOUT_PARTIAL:") || !strings.Contains(fds[0].Content, "admin session") {
		t.Fatalf("partial finding: %+v", fds)
	}
	if !strings.Contains(fds[0].Evidence, "events:") {
		t.Fatalf("partial finding must carry the event trace: %+v", fds[0])
	}
}

func TestExecuteTurnStallSalvagesPartial(t *testing.T) {
	// Run 46631: a wedged tool execution silences the agent (last message
	// streamed, no tool result ever) while the step heartbeat keeps the
	// claim — the slot burned 24m/42m on silence. The stall error must take
	// the SAME salvage path as a deadline: streamed tail → finding, step
	// DONE, one attempt, never a from-zero retry.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s"}]}}`),
		func(string) (*pi.PromptResult, error) {
			return &pi.PromptResult{
				Text:   "attacked the wall; OA admin x 10k miss; password must be findable",
				Events: []string{"ev1"},
			}, pi.ErrTurnStall
		},
	)
	g, _ := st.CreateGoal(ctx, "stall", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	e.executeStep(ctx, g.ID, steps[0].ID)

	steps, _ = st.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepDone || steps[0].Attempts != 1 {
		t.Fatalf("stalled turn must salvage (not fail) the step: %+v", steps[0])
	}
	fds, _ := st.ListFindings(ctx, g.ID, false)
	if len(fds) != 1 || !strings.Contains(fds[0].Content, "findable") {
		t.Fatalf("stall partial finding: %+v", fds)
	}
}

func TestDecideTimeoutSalvagesVerdict(t *testing.T) {
	ctx := context.Background()
	e, st, _ := newEngine(t,
		func(string) (*pi.PromptResult, error) {
			return &pi.PromptResult{Text: `{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"late verdict"}]}}`}, pi.ErrTimeout
		},
	)
	g, _ := st.CreateGoal(ctx, "dsalv", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	steps, _ := st.ListSteps(ctx, g.ID)
	if len(steps) != 1 || steps[0].Description != "late verdict" {
		t.Fatalf("salvaged verdict must be applied to the graph: %+v", steps)
	}
}

func TestRunnerBreakerPausesClaims(t *testing.T) {
	// Three consecutive launch failures open the breaker: further ticks must
	// not claim (attempts stop growing) until the cooldown expires. Without
	// the breaker every tick burns one attempt on a dead runtime.
	ctx := context.Background()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := cfg.Default()
	c.Runtime.TickInterval = cfg.Duration(5 * time.Millisecond)
	c.Runtime.StepMaxAttempts = 99 // let the breaker, not exhaustion, stop it
	e := New(st, c, slog.New(slog.NewTextHandler(&strings.Builder{}, nil)),
		func() (Runner, error) { return nil, errors.New("spawn dead") })
	g, _ := st.CreateGoal(ctx, "brk", "o", "obj")
	if _, err := st.CreateStep(ctx, g.ID, "step", nil, fgs.ActorDecide); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 5; i++ {
		e.scheduleGoal(ctx, g.ID)
		e.wg.Wait()
	}
	steps, _ := st.ListSteps(ctx, g.ID)
	if steps[0].Attempts != breakerThreshold {
		t.Fatalf("breaker must stop claims at %d attempts, got %d", breakerThreshold, steps[0].Attempts)
	}
	if !e.breakerOpen() {
		t.Fatal("breaker should be open after 3 consecutive launch failures")
	}
}

func TestRunnerBreakerResetsOnSuccess(t *testing.T) {
	e, _, _ := newEngine(t)
	e.noteRunnerFailure("test")
	e.noteRunnerFailure("test")
	if e.breakerOpen() {
		t.Fatal("two failures must not open the breaker")
	}
	e.noteRunnerSuccess()
	e.mu.Lock()
	streak := e.failStreak
	e.mu.Unlock()
	if streak != 0 {
		t.Fatalf("streak must reset on success, got %d", streak)
	}
	if e.breakerOpen() {
		t.Fatal("breaker must stay closed after a success reset")
	}
}

func TestFlagRefuelExtendsWallBudget(t *testing.T) {
	// Banking a new flag mid-pass refuels the wall budget: the goal keeps
	// its slot while it is demonstrably converting time into score. Two
	// refuels per goal, then the budget bites.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.GoalWallBudget = cfg.Duration(time.Minute)
	fake := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return fake }
	correct := 0
	e.FlagProgress = func(string) (int, int, bool) { return correct, 4, true }

	g, _ := st.CreateGoal(ctx, "refuel", "o", "obj")
	e.mu.Lock()
	e.firstClaim[g.ID] = fake.Add(-2 * time.Minute)
	e.flagBase[g.ID] = 0
	e.mu.Unlock()

	correct = 1 // flag banked during the pass
	if over, _ := e.goalOverBudget(ctx, g.ID); over {
		t.Fatal("a goal with fresh flag progress must not be budget-stopped")
	}
	e.mu.Lock()
	refills := e.flagRefills[g.ID]
	rewound := e.firstClaim[g.ID].Equal(fake)
	e.mu.Unlock()
	if refills != 1 || !rewound {
		t.Fatalf("refuel must rewind the window once: refills=%d rewound=%v", refills, rewound)
	}

	// No further progress and no fresh finish: the refueled window expires.
	fake = fake.Add(2 * time.Minute)
	if over, _ := e.goalOverBudget(ctx, g.ID); !over {
		t.Fatal("without new progress the refueled budget must bite")
	}
}

func TestCompletedChallengeRetiresAndNeverRequeues(t *testing.T) {
	// Solved titles must leave the fleet: the sweep retires the active
	// goal (freeing the container), and requeuePass2 — the single choke
	// point every resurrection path funnels through (budget stops,
	// endgame top-up) — refuses a completed title. Otherwise a solved
	// challenge re-queues for two more passes and re-eats slots the
	// untouched tail never sees.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.RunDeadline = cfg.Duration(time.Hour)
	e.startedAt = e.now()
	e.FlagProgress = func(string) (int, int, bool) { return 1, 1, true }

	g, _ := st.CreateGoal(ctx, "solved-title", "o", "obj")
	pruned := e.sweepCompleted(ctx, []fgs.Goal{*g})
	if len(pruned) != 0 {
		t.Fatalf("completed goal must be pruned from actives, got %d", len(pruned))
	}
	gg, err := st.GetGoal(ctx, g.ID)
	if err != nil || gg.Status != fgs.GoalStopped {
		t.Fatalf("completed goal must be stopped: err=%v status=%v", err, gg.Status)
	}
	if ng, ok := e.requeuePass2(ctx, gg); ok {
		t.Fatalf("completed challenge must never requeue, minted %v", ng.ID)
	}
	// The pass-2 requeue of a NON-completed sibling still works — the gate
	// must not overreach.
	e.FlagProgress = func(string) (int, int, bool) { return 1, 4, true }
	if _, ok := e.requeuePass2(ctx, gg); !ok {
		t.Fatal("partial-progress challenge must still requeue normally")
	}
}

func TestFlagRefuelGrantsStepBudget(t *testing.T) {
	// Run 43065 anatomy: a multi-flag intranet banked flags mid-pass but the
	// STEP budget (checked before the wall refuel ever helped) still cut the
	// harvest short across seven container restarts. A flag refuel must now
	// grant FlagStepBonus extra steps (code default 3) alongside the wall
	// reset, and the step check must consume them.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.GoalStepBudget = 2
	e.cfg.Runtime.GoalWallBudget = 0 // wall off: isolate the step-budget path
	e.cfg.Runtime.FlagRefillMax = 0  // 0 = code default (4)
	e.cfg.Runtime.FlagStepBonus = 0  // 0 = code default (3)
	correct := 0
	e.FlagProgress = func(string) (int, int, bool) { return correct, 6, true }

	g, _ := st.CreateGoal(ctx, "refuel-steps", "o", "obj")
	done := 0
	for i := 0; i < 2; i++ {
		s, _ := st.CreateStep(ctx, g.ID, fmt.Sprintf("s%d", i), nil, fgs.ActorDecide)
		st.ClaimNextStep(ctx, g.ID, "zhulongx")
		if _, err := st.FinishStepWithFinding(ctx, g.ID, s.ID, "zhulongx", "done", "ev"); err != nil {
			t.Fatalf("finish step: %v", err)
		}
		done++
	}
	e.mu.Lock()
	e.flagBase[g.ID] = 0
	e.mu.Unlock()

	correct = 1 // flag banked during the pass
	if over, _ := e.goalOverBudget(ctx, g.ID); over {
		t.Fatal("a step-drained goal with fresh flag progress must be refueled, not stopped")
	}
	e.mu.Lock()
	bonus := e.stepBonus[g.ID]
	e.mu.Unlock()
	if bonus != 3 {
		t.Fatalf("refuel must grant the default 3-step bonus, got %d", bonus)
	}

	// Steps within the granted headroom (2 base + 3 bonus = 5 allowed):
	// 3 and 4 DONE stay alive.
	for i := 2; i < 4; i++ {
		s, _ := st.CreateStep(ctx, g.ID, fmt.Sprintf("s%d", i), nil, fgs.ActorDecide)
		st.ClaimNextStep(ctx, g.ID, "zhulongx")
		if _, err := st.FinishStepWithFinding(ctx, g.ID, s.ID, "zhulongx", "done", "ev"); err != nil {
			t.Fatalf("finish step: %v", err)
		}
		if over, _ := e.goalOverBudget(ctx, g.ID); over {
			t.Fatalf("step %d within refuel-granted headroom must not stop the goal", i+1)
		}
	}

	// The 5th DONE step exhausts base+bonus; with NO new flag since the
	// refuel the budget bites.
	s, _ := st.CreateStep(ctx, g.ID, "s4", nil, fgs.ActorDecide)
	st.ClaimNextStep(ctx, g.ID, "zhulongx")
	if _, err := st.FinishStepWithFinding(ctx, g.ID, s.ID, "zhulongx", "done", "ev"); err != nil {
		t.Fatalf("finish step: %v", err)
	}
	if over, _ := e.goalOverBudget(ctx, g.ID); !over {
		t.Fatal("without new flag progress the step budget must bite after the bonus is spent")
	}
}

func TestActiveGraceExtendsWallBudgetOnce(t *testing.T) {
	// A step that landed moments before the deadline means the goal is
	// mid-flow, not wedged: one 10-minute extension, never two.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.GoalWallBudget = cfg.Duration(time.Minute)
	fake := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return fake }

	g, _ := st.CreateGoal(ctx, "grace", "o", "obj")
	e.mu.Lock()
	e.firstClaim[g.ID] = fake.Add(-2 * time.Minute)
	e.lastFinish[g.ID] = fake.Add(-1 * time.Minute) // landed 1m before the check
	e.mu.Unlock()

	if over, _ := e.goalOverBudget(ctx, g.ID); over {
		t.Fatal("a step landing inside the grace window must earn the extension")
	}
	e.mu.Lock()
	deadline := e.firstClaim[g.ID]
	used := e.graceUsed[g.ID]
	e.mu.Unlock()
	if !used || !deadline.Equal(fake.Add(8*time.Minute)) {
		t.Fatalf("grace must push the deadline 10m out: used=%v deadline=%v", used, deadline)
	}

	// Second time the same goal is out of luck — grace is one-shot.
	e.mu.Lock()
	e.lastFinish[g.ID] = fake // finished "now", still mid-flow
	e.mu.Unlock()
	fake = fake.Add(12 * time.Minute)
	e.mu.Lock()
	e.lastFinish[g.ID] = fake
	e.mu.Unlock()
	if over, _ := e.goalOverBudget(ctx, g.ID); !over {
		t.Fatal("grace must fire only once per goal")
	}
}

func TestHarvestFlagsSubmitsConcreteCandidates(t *testing.T) {
	// Concrete flag-shaped values in landing text reach the submit hook;
	// brief-style examples (flag{...}, flag{uuid}) must not.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	got := make(chan string, 4)
	e.OnFlagCandidate = func(_ context.Context, _, flag string) { got <- flag }

	g, _ := st.CreateGoal(ctx, "bench:b-01 harvest", "o", "obj")
	e.harvestFlags(ctx, g.ID,
		"cracked it: FLAG{f5m_st4t3_tr4c3_1s_th3_k3y5tr34m} and flag{3f2a9c1d-77b2-4e18-9c0f-6a2b8d4e9f10} — format is flag{...} e.g. flag{uuid}")
	e.wg.Wait()
	close(got)
	var seen []string
	for f := range got {
		seen = append(seen, f)
	}
	if len(seen) != 2 {
		t.Fatalf("exactly the two concrete flags must be harvested: %v", seen)
	}
}

func TestDecideStepDescriptionHarvestsFlag(t *testing.T) {
	// run 42361's f2-01: the computed flag lived in a DECIDE round's step
	// declaration and the submit step never ran. The declaration itself
	// must reach the submit hook.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"submit FLAG{d3c0d3_th3_k3y} via platform API now"}]}}`),
	)
	got := make(chan string, 1)
	e.OnFlagCandidate = func(_ context.Context, _, flag string) { got <- flag }

	g, _ := st.CreateGoal(ctx, "bench:f2-01", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	select {
	case f := <-got:
		if f != "FLAG{d3c0d3_th3_k3y}" {
			t.Fatalf("unexpected candidate: %s", f)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a flag inside a declared step description must be harvested")
	}
}

func TestReleaseContainerRetries(t *testing.T) {
	// The stop-time release is the fast path; a failed POST must retry.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.releaseBackoff = []time.Duration{0, time.Millisecond, time.Millisecond}
	calls := 0
	e.ReleaseContainer = func(context.Context, string) error {
		calls++
		if calls < 3 {
			return errors.New("gateway 502")
		}
		return nil
	}
	g, _ := st.CreateGoal(ctx, "retry", "o", "obj")
	e.releaseStoppedContainer(g.ID)
	e.wg.Wait()
	if calls != 3 {
		t.Fatalf("release must retry until success: calls=%d", calls)
	}
}

func TestEndgameRankBreadthOverDeepPartial(t *testing.T) {
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.RunDeadline = cfg.Duration(350 * time.Minute)
	e.cfg.Runtime.EndgameAfter = cfg.Duration(320 * time.Minute)
	fake := time.Date(2026, 10, 31, 18, 21, 0, 0, time.UTC) // t+331m: endgame
	e.now = func() time.Time { return fake }
	e.startedAt = fake.Add(-331 * time.Minute)
	e.FlagProgress = func(title string) (int, int, bool) {
		switch {
		case strings.Contains(title, "partial"):
			return 2, 4, true
		case strings.Contains(title, "multi"):
			return 0, 6, true
		case strings.Contains(title, "plain"):
			return 0, 1, true
		case strings.Contains(title, "fresh"):
			return 0, 1, true
		case strings.Contains(title, "um"):
			return 0, 4, true
		}
		return 0, 0, false
	}
	partial, _ := st.CreateGoal(ctx, "bench:partial", "o", "obj")
	multi, _ := st.CreateGoal(ctx, "bench:multi", "o", "obj")
	plain, _ := st.CreateGoal(ctx, "bench:plain", "o", "obj")
	fresh, _ := st.CreateGoal(ctx, "bench:fresh", "o", "obj")
	um, _ := st.CreateGoal(ctx, "bench:um", "o", "obj")
	// multi and plain were worked in an earlier pass (zero-flag regrinds);
	// fresh and um (untouched MULTI) never saw a container.
	e.mu.Lock()
	e.firstTouch["bench:multi"] = true
	e.firstTouch["bench:plain"] = true
	e.mu.Unlock()

	if !e.inEndgame() {
		t.Fatal("t+331m of a 350m run with an 80m window is endgame")
	}
	rank := e.endgameRank([]fgs.Goal{{ID: partial.ID, Title: "bench:partial"}, {ID: multi.ID, Title: "bench:multi"}, {ID: plain.ID, Title: "bench:plain"}, {ID: fresh.ID, Title: "bench:fresh"}, {ID: um.ID, Title: "bench:um"}})
	// Untouched breadth stays first. Worked zero-flag singles now share the
	// deep-partial retry tier so regressions can recover in the harvest window.
	if !(rank[fresh.ID] > rank[partial.ID] && rank[partial.ID] == rank[plain.ID] && rank[plain.ID] > rank[multi.ID]) {
		t.Fatalf("untouched single > (deep partial = worked single-zero) > worked multi-zero: %v", rank)
	}
	// v21.1 (run 43759: untouched multi b-03 — a 16-minute 0→4 converter
	// once fed — was swallowed by the zero-multi tier and starved four
	// hours below the deep partials): an untouched MULTI ranks with fresh
	// singles (3), above deep partials and worked zero-multis.
	if !(rank[um.ID] == rank[fresh.ID] && rank[um.ID] > rank[partial.ID] && rank[um.ID] > rank[multi.ID]) {
		t.Fatalf("untouched multi must rank with fresh singles above partials and worked zero-multis: %v", rank)
	}
	_ = ctx
}

func TestNeverStartedGoalsSortAheadOfWorkedGoals(t *testing.T) {
	// Run 42416: refueled sieges (b-01, 147 slot-minutes) starved the
	// queue tail — e3-02 first saw a container past the deadline. Pre-
	// endgame ticks must visit never-claimed titles first so a freed slot
	// reaches the tail before another pass on a worked goal.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	fake := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return fake }

	touched, _ := st.CreateGoal(ctx, "b-01", "o", "obj")
	fresh, _ := st.CreateGoal(ctx, "e3-02", "o", "obj")
	pass2, _ := st.CreateGoal(ctx, "f2-01", "o", "obj") // requeuePass2 minted this ID after f2-01's first pass
	e.mu.Lock()
	e.firstClaim[touched.ID] = fake // b-01 already had its pass
	e.firstTouch[touched.Title] = true
	e.firstTouch[pass2.Title] = true // requeuePass2 marks the title touched at creation
	e.mu.Unlock()

	actives := []fgs.Goal{{ID: touched.ID, Title: touched.Title}, {ID: pass2.ID, Title: pass2.Title}, {ID: fresh.ID, Title: fresh.Title}}
	if !e.inEndgame() {
		sort.SliceStable(actives, func(i, j int) bool {
			ti, tj := e.titleTouched(actives[i].Title), e.titleTouched(actives[j].Title)
			if ti != tj {
				return !ti
			}
			return false
		})
	}
	if actives[0].ID != fresh.ID {
		t.Fatalf("never-started goal must be visited first: got %s", actives[0].ID)
	}
}

func TestRequeuedPassDoesNotFrontRunUntouchedTitles(t *testing.T) {
	// Run 42778: first-touch fairness was keyed by goal ID, and
	// requeuePass2 mints a fresh ID per retry pass — so f2-01's pass-2
	// (relaunched t+59 after 32 fruitless minutes) counted as "never
	// claimed" and outranked ~50 titles that had never seen a container.
	// The fairness signal must be title-keyed, and requeuePass2 must mark
	// the title touched at creation.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	fake := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return fake }
	e.startedAt = fake.Add(-1 * time.Hour)
	e.cfg.Runtime.RunDeadline = cfg.Duration(6 * time.Hour)

	dudPass1, _ := st.CreateGoal(ctx, "f2-01", "o", "obj") // burned its full wall budget, no flag
	dudPass2, _ := st.CreateGoal(ctx, "f2-01", "o", "obj") // requeuePass2's fresh goal
	untouched, _ := st.CreateGoal(ctx, "a-06", "o", "obj")

	// pass-1 claimed steps; pass-2 was just created by requeuePass2, which
	// marks the title touched (the fix under test).
	e.mu.Lock()
	e.firstClaim[dudPass1.ID] = fake.Add(-30 * time.Minute)
	e.mu.Unlock()
	e.requeuePass2(ctx, dudPass1) // creates pass-2 + marks title touched

	e.mu.Lock()
	touched := e.firstTouch["f2-01"]
	e.mu.Unlock()
	if !touched {
		t.Fatal("requeuePass2 must mark the title touched so the retry cannot front-run")
	}

	actives := []fgs.Goal{{ID: dudPass2.ID, Title: dudPass2.Title}, {ID: untouched.ID, Title: untouched.Title}}
	sort.SliceStable(actives, func(i, j int) bool {
		ti, tj := e.titleTouched(actives[i].Title), e.titleTouched(actives[j].Title)
		if ti != tj {
			return !ti
		}
		return false
	})
	if actives[0].ID != untouched.ID {
		t.Fatalf("untouched title must outrank a requeued pass: got %s", actives[0].ID)
	}
}

func TestExecuteNoFootholdRotatesGoal(t *testing.T) {
	// Run 42984: the agent honored the zero-foothold wall by closing its
	// container, but the engine didn't know — the goal stayed active and
	// the next step relaunched the same title 2 seconds later. The wall
	// was container churn, not slot rotation; three grinders pinned every
	// slot for a full wall budget. A step report starting NOFOOTHOLD: must
	// stop the pass and hand the slot back to the untouched queue.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"the step"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"NOFOOTHOLD: 15m zero-foothold wall — no confirmed primitive, ledger written, container closed","evidence":"e"}}}`),
	)
	e.cfg.Runtime.RunDeadline = cfg.Duration(6 * time.Hour)
	e.startedAt = e.now()
	g, _ := st.CreateGoal(ctx, "bench:c-05", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial")
	claimed, err := st.ClaimNextStep(ctx, g.ID, "zhulongx")
	if err != nil {
		t.Fatal(err)
	}
	e.executeStep(ctx, g.ID, claimed.ID)

	goals, _ := st.ListGoals(ctx)
	if len(goals) != 2 {
		t.Fatalf("NOFOOTHOLD must rotate the goal into a requeued pass, got %d goals", len(goals))
	}
	stopped := 0
	active := 0
	for _, gg := range goals {
		switch gg.Status {
		case fgs.GoalStopped:
			stopped++
		case fgs.GoalActive:
			active++
		}
	}
	if stopped != 1 || active != 1 {
		t.Fatalf("want 1 stopped + 1 requeued active, got stopped=%d active=%d", stopped, active)
	}
	// The reporting step itself lands DONE with its ledger finding — the
	// wall costs the goal its slot, never the agent its report.
	after, _ := st.ListSteps(ctx, g.ID)
	if after[0].Status != fgs.StepDone || after[0].FindingID == "" {
		t.Fatalf("the reporting step must land DONE with a finding: %+v", after[0])
	}
}

func TestZeroRequeueYieldsToUntouchedTail(t *testing.T) {
	// Run 43759: f2-01 burned six zero-flag passes and e2-04 five, each
	// stop→remint re-hoarding the container before its release completed,
	// while untouched b-03 — a 16-minute 0→4 converter once fed — starved
	// four hours. A zero-progress title's requeue defers while any OTHER
	// untouched title has an active goal; banked titles never defer (their
	// passes are conversion, not regrind).
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.RunDeadline = cfg.Duration(6 * time.Hour)
	e.startedAt = e.now().Add(-2 * time.Hour)
	e.FlagProgress = func(title string) (int, int, bool) {
		switch title {
		case "bench:f2-01":
			return 0, 1, true
		case "bench:b-01":
			return 1, 4, true
		}
		return 0, 0, false
	}
	dud, err := st.CreateGoal(ctx, "bench:f2-01", "o", "obj")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetGoalStatus(ctx, dud.ID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateGoal(ctx, "bench:b-03", "o", "obj"); err != nil { // untouched, active
		t.Fatal(err)
	}
	e.mu.Lock()
	e.firstTouch["bench:f2-01"] = true
	e.mu.Unlock()

	if _, ok := e.requeuePass2(ctx, dud); ok {
		t.Fatal("zero-progress requeue must yield while an untouched title waits")
	}

	// Banked titles keep converting even with the untouched tail waiting.
	banked, err := st.CreateGoal(ctx, "bench:b-01", "o", "obj")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetGoalStatus(ctx, banked.ID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.firstTouch["bench:b-01"] = true
	e.mu.Unlock()
	if _, ok := e.requeuePass2(ctx, banked); !ok {
		t.Fatal("banked requeue must not yield to the untouched tail")
	}

	// Once the untouched tail is fed (touched), the dud's requeue resumes.
	e.mu.Lock()
	e.firstTouch["bench:b-03"] = true
	e.mu.Unlock()
	if _, ok := e.requeuePass2(ctx, dud); !ok {
		t.Fatal("zero-progress requeue must resume once no untouched title waits")
	}
}

func TestEndgameTopUpCountsLiveWork(t *testing.T) {
	// Run 43759 14:24-15:02: two zombie actives (containers closed, no step
	// in flight) plus two real chains satisfied MinActive=3 on paper while
	// the third slot sat empty for 38 minutes and stopped converters
	// waited. The top-up gate must count goals with a step actually
	// running, not paper-active goals.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.RunDeadline = cfg.Duration(6 * time.Hour)
	e.cfg.Runtime.EndgameAfter = cfg.Duration(5 * time.Hour)
	e.cfg.Runtime.EndgameMinActive = 3
	e.startedAt = e.now().Add(-2 * time.Hour) // inside the harvest window
	e.FlagProgress = func(title string) (int, int, bool) {
		if title == "bench:b-02" {
			return 4, 6, true
		}
		return 0, 1, true
	}
	// Two paper actives: never claimed a step (the 43759 zombies).
	if _, err := st.CreateGoal(ctx, "bench:a-16", "o", "obj"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateGoal(ctx, "bench:f2-01", "o", "obj"); err != nil {
		t.Fatal(err)
	}
	// One live chain: a claimed (running) step.
	live, err := st.CreateGoal(ctx, "bench:e2-04", "o", "obj")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateStep(ctx, live.ID, "work", nil, "engine:bootstrap"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ClaimNextStep(ctx, live.ID, "test"); err != nil {
		t.Fatal(err)
	}
	// A stopped converter that must be re-fed past the paper actives.
	conv, err := st.CreateGoal(ctx, "bench:b-02", "o", "obj")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetGoalStatus(ctx, conv.ID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
		t.Fatal(err)
	}
	e.requeues["bench:b-02"] = 2 // mid-run caps burned; endgame lift is the only path
	e.mu.Lock()
	e.firstTouch["bench:b-02"] = true
	e.mu.Unlock()

	goals, err := st.ListGoals(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var actives []fgs.Goal
	for _, g := range goals {
		if g.Status == fgs.GoalActive {
			actives = append(actives, g)
		}
	}
	if len(actives) < 3 {
		t.Fatalf("setup: need the paper actives counted, got %d", len(actives))
	}
	out := e.endgameTopUp(ctx, goals, actives)
	titles := make(map[string]int)
	for _, g := range out {
		titles[g.Title]++
	}
	if titles["bench:b-02"] != 1 {
		t.Fatalf("the stopped converter must be re-fed despite 3 paper actives; b-02 minted goals = %d", titles["bench:b-02"])
	}
}

func TestEndgameTopUpRefeedsIdleSlots(t *testing.T) {
	// Run 42838: hour-5 utilization collapsed to 1.17/3 slots — every title
	// had burned its requeue cap, the queue emptied, and stopped partials
	// (b-02 at 2/6 flags) watched idle slots from the bench. In the harvest
	// window the fleet must be re-fed past the caps, banked progress first.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.RunDeadline = cfg.Duration(6 * time.Hour)
	e.cfg.Runtime.EndgameAfter = cfg.Duration(5 * time.Hour)
	e.cfg.Runtime.EndgameMinActive = 3
	e.startedAt = e.now().Add(-2 * time.Hour) // inside the harvest window
	e.FlagProgress = func(title string) (int, int, bool) {
		if title == "bench:b-01" {
			return 2, 4, true
		}
		return 0, 1, true
	}

	act, _ := st.CreateGoal(ctx, "bench:a-01", "o", "obj")
	partial, _ := st.CreateGoal(ctx, "bench:b-01", "o", "obj")
	if err := st.SetGoalStatus(ctx, partial.ID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
		t.Fatal(err)
	}
	dud, _ := st.CreateGoal(ctx, "bench:c-02", "o", "obj")
	if err := st.SetGoalStatus(ctx, dud.ID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
		t.Fatal(err)
	}
	// Both stopped titles burned their full mid-run caps — and both were
	// worked to get there (untouched titles cannot have burned caps; without
	// the touch marks the fresh-tier rank would invert this order, which is
	// the v20 breadth change covered by the rank tests above). The active
	// a-01 is touched too: the 42838 shape is an emptied queue, not an
	// untouched tail — with a-01 untouched, v21.1's fresh-meat yield
	// correctly defers the dud's regrind to it instead.
	e.requeues["bench:b-01"] = 2
	e.requeues["bench:c-02"] = 2
	e.mu.Lock()
	e.firstTouch["bench:a-01"] = true
	e.firstTouch["bench:b-01"] = true
	e.firstTouch["bench:c-02"] = true
	e.mu.Unlock()

	goals, err := st.ListGoals(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var actives []fgs.Goal
	for _, g := range goals {
		if g.Status == fgs.GoalActive {
			actives = append(actives, g)
		}
	}
	out := e.endgameTopUp(ctx, goals, actives)
	if len(out) != 3 {
		t.Fatalf("fleet must be fed to 3 actives, got %d", len(out))
	}
	if out[1].Title != "bench:b-01" {
		t.Fatalf("banked-progress partial must be requeued first, got %s", out[1].Title)
	}
	if out[2].Title != "bench:c-02" {
		t.Fatalf("expected the dud as the third slot, got %s", out[2].Title)
	}
	if out[0].ID != act.ID {
		t.Fatalf("the already-active goal must keep its slot, got %s", out[0].ID)
	}

	// Mid-run the caps still hold: the same burned-out dud earns nothing.
	e2, st2, _ := newEngine(t, ok(`{}`))
	e2.cfg.Runtime.RunDeadline = cfg.Duration(6 * time.Hour)
	e2.cfg.Runtime.EndgameMinActive = 0
	e2.startedAt = e2.now()
	e2.FlagProgress = func(string) (int, int, bool) { return 0, 1, true }
	d2, _ := st2.CreateGoal(ctx, "bench:c-02", "o", "obj")
	e2.requeues["bench:c-02"] = 1 // zero-progress cap already used
	if _, ok := e2.requeuePass2(ctx, d2); ok {
		t.Fatal("zero-progress title must not earn a second requeue mid-run")
	}
}

func TestEndgameOrderStarvedFreshPassBeatsIncumbent(t *testing.T) {
	// Run 46418: the tick's endgame sort carried ONLY the rank tier and fell
	// through to creation order — but every budget stop mints a fresh goal
	// with a NEW created_at, so a starved title churns to the back of the
	// queue every 30 minutes while an incumbent stop→requeue→reclaims its
	// just-freed slot. c-09 took five consecutive 30-minute blocks (b-02 and
	// a-14 three each — 305 of ~369 endgame slot-minutes, zero flags) while
	// a-18/c-02/e2-04, one pass spent each, got nothing until the death
	// line. endgameOrder is the shared comparator for BOTH allocation
	// paths; within a rank fewer requeues spent must sort first regardless
	// of goal age.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.FlagProgress = func(string) (int, int, bool) { return 0, 1, true }

	incumbent, _ := st.CreateGoal(ctx, "bench:c-09", "o", "obj") // oldest goal, most helpings
	starved, _ := st.CreateGoal(ctx, "bench:a-18", "o", "obj")   // younger, first retry
	younger, _ := st.CreateGoal(ctx, "bench:c-02", "o", "obj")   // youngest, first retry
	e.requeues["bench:c-09"] = 3
	e.requeues["bench:a-18"] = 1
	e.requeues["bench:c-02"] = 1
	e.mu.Lock()
	e.firstTouch["bench:c-09"] = true // worked zero-singles: all rank 2
	e.firstTouch["bench:a-18"] = true
	e.firstTouch["bench:c-02"] = true
	e.mu.Unlock()

	gs := []fgs.Goal{*incumbent, *starved, *younger}
	rank := e.endgameRank(gs)
	sort.SliceStable(gs, e.endgameOrder(gs, rank))
	want := []string{"bench:a-18", "bench:c-02", "bench:c-09"}
	for i, g := range gs {
		if g.Title != want[i] {
			t.Fatalf("slot %d must go to %s (fewest requeues first, creation order among equals), got %s", i, want[i], g.Title)
		}
	}
	if incumbent.CreatedAt.After(starved.CreatedAt) {
		t.Fatal("test premise broken: incumbent must be the older goal")
	}
}

func TestEndgameMintPrefersFreshRetryOverThirdHelping(t *testing.T) {
	// Run 46196 09:36: the mint gave b-02 a THIRD pass (2/6 banked, walls
	// held for three hours, 31 minutes of runway, zero return) while c-09 —
	// first retry, worked single-flag title with a live admin foothold named
	// in its ledger — waited and got the death-line slot instead. Both sit in
	// rank 2 (deep partial / worked zero-single); within a rank fewer
	// requeues spent now wins before banked progress, so a fresh second look
	// outranks a third helping. At EQUAL requeues the banked converter still
	// beats the dud — 42838's order, covered by
	// TestEndgameTopUpRefeedsIdleSlots.
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.RunDeadline = cfg.Duration(6 * time.Hour)
	e.cfg.Runtime.EndgameAfter = cfg.Duration(5 * time.Hour)
	e.cfg.Runtime.EndgameMinActive = 3
	e.startedAt = e.now().Add(-2 * time.Hour) // inside the harvest window
	e.FlagProgress = func(title string) (int, int, bool) {
		if title == "bench:b-02" {
			return 2, 6, true // banked deep partial
		}
		return 0, 1, true // a-01 active incomplete; c-09 worked zero-single
	}

	act, _ := st.CreateGoal(ctx, "bench:a-01", "o", "obj")
	bank, _ := st.CreateGoal(ctx, "bench:b-02", "o", "obj")
	if err := st.SetGoalStatus(ctx, bank.ID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
		t.Fatal(err)
	}
	fresh, _ := st.CreateGoal(ctx, "bench:c-09", "o", "obj")
	if err := st.SetGoalStatus(ctx, fresh.ID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
		t.Fatal(err)
	}
	e.requeues["bench:b-02"] = 2 // two passes spent: the third-helping shape
	e.requeues["bench:c-09"] = 1
	e.mu.Lock()
	e.firstTouch["bench:a-01"] = true
	e.firstTouch["bench:b-02"] = true
	e.firstTouch["bench:c-09"] = true
	e.mu.Unlock()

	goals, err := st.ListGoals(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var actives []fgs.Goal
	for _, g := range goals {
		if g.Status == fgs.GoalActive {
			actives = append(actives, g)
		}
	}
	out := e.endgameTopUp(ctx, goals, actives)
	if len(out) != 3 {
		t.Fatalf("fleet must be fed to 3 actives, got %d", len(out))
	}
	if out[0].ID != act.ID {
		t.Fatalf("the already-active goal must keep its slot, got %s", out[0].ID)
	}
	if out[1].Title != "bench:c-09" {
		t.Fatalf("the fresh retry must take the first minted slot, got %s", out[1].Title)
	}
	if out[2].Title != "bench:b-02" {
		t.Fatalf("the twice-failed siege waits for the second slot, got %s", out[2].Title)
	}
}

func TestZeroProgressTitleEarnsSingleRequeue(t *testing.T) {
	// Run 42416/42778 economics: a title with zero banked flags re-buys
	// recon its ledger already ruled out — c-03/a-05 burned 60m slots each,
	// f2-01 took a second 36m helping with three wrong submits. Zero
	// progress earns ONE requeue; banked progress keeps both retries
	// (42361: b-01 died at 2/4 with the third flag in reach).
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.RunDeadline = cfg.Duration(6 * time.Hour)
	e.startedAt = e.now()
	correct := 0
	e.FlagProgress = func(string) (int, int, bool) { return correct, 4, true }

	dud, _ := st.CreateGoal(ctx, "bench:c-03", "o", "obj")
	e.requeuePass2(ctx, dud)
	e.requeuePass2(ctx, dud) // zero progress: the second requeue must be refused
	n := 0
	goals, _ := st.ListGoals(ctx)
	for _, g := range goals {
		if g.Title == "bench:c-03" {
			n++
		}
	}
	if n != 2 { // original + ONE requeue
		t.Fatalf("zero-progress title must earn exactly one requeue, got %d goals", n)
	}

	// A title with banked flags keeps the second retry.
	milker, _ := st.CreateGoal(ctx, "bench:b-01", "o", "obj")
	correct = 2
	e.requeuePass2(ctx, milker)
	e.requeuePass2(ctx, milker)
	n = 0
	goals, _ = st.ListGoals(ctx)
	for _, g := range goals {
		if g.Title == "bench:b-01" {
			n++
		}
	}
	if n != 3 { // original + two requeues
		t.Fatalf("banked-progress title must keep both requeues, got %d goals", n)
	}
}

// panicRunner panics inside Prompt — the engine's execute goroutine must
// recover, return the step for retry, and never leak its concurrency slot.
type panicRunner struct{}

func (panicRunner) Prompt(context.Context, string) (*pi.PromptResult, error) {
	panic("boom: streaming layer exploded")
}

func (panicRunner) Close() error { return nil }

func TestExecutePanicRecoveredKeepsConcurrencySlot(t *testing.T) {
	// A panic on the execute path must not kill the engine (the whole run
	// would go silent — the 43263 post-mortem made engine-survivability a
	// hard requirement) and must not wedge e.running: the deferred slot
	// release runs on every exit path.
	ctx := context.Background()
	e, st, _ := newEngine(t) // unused script; factory overridden below
	e.newRunner = func() (Runner, error) { return panicRunner{}, nil }
	e.cfg.Runtime.BootstrapStep = "direct step"
	g, _ := st.CreateGoal(ctx, "panic", "o", "obj")

	e.scheduleGoal(ctx, g.ID) // bootstrap step claimed → goroutine panics
	e.wg.Wait()

	e.mu.Lock()
	running := e.running
	e.mu.Unlock()
	if running != 0 {
		t.Fatalf("panic must release the concurrency slot, running=%d", running)
	}
	steps, _ := st.ListSteps(ctx, g.ID)
	if len(steps) != 1 {
		t.Fatalf("expected the one bootstrap step, got %d", len(steps))
	}
	if steps[0].Status != fgs.StepPending && steps[0].Status != fgs.StepFailed {
		t.Fatalf("panicked step must be returned for retry or failed cleanly: %s", steps[0].Status)
	}
	if steps[0].Attempts != 1 {
		t.Fatalf("the panic counts as exactly one attempt: %d", steps[0].Attempts)
	}

	// The engine keeps scheduling afterwards: a second scheduleGoal round
	// claims again without deadlock.
	e.scheduleGoal(ctx, g.ID)
	e.wg.Wait()
}

func TestRuntimeWatchdogFreezesBudgetsDuringOutage(t *testing.T) {
	// Run 43263 anatomy: the model path died mid-round with steps in
	// flight. The steps hung until their ctx cut unwound them, the wall
	// budgets then stopped and released the goals, and the engine idled
	// silently for the rest of the window with a fleet of unsolved titles.
	// The watchdog must (a) trip once nothing completes and nothing runs,
	// (b) freeze budget stops and step attempts for the outage's duration,
	// (c) close the outage on the first successful turn, shifting the wall
	// clocks by the outage length.
	ctx := context.Background()
	e, st, fr := newEngine(t,
		ok(`{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"s1"},{"from":["f_0001"],"description":"s2"}]}}`),
		ok(`{"accepted":true,"data":{"finding":{"content":"s1 done","evidence":"e"}}}`),
	)
	e.cfg.Runtime.RunnerWatchdog = cfg.Duration(5 * time.Minute)
	e.cfg.Runtime.GoalWallBudget = cfg.Duration(time.Minute)
	fake := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return fake }
	e.startedAt = fake
	e.mu.Lock()
	e.lastRunnerOK = fake
	e.mu.Unlock()

	g, _ := st.CreateGoal(ctx, "outage", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	e.decide(ctx, g.ID, "initial") // declares s1 + s2
	e.scheduleGoal(ctx, g.ID)      // claims s1 at T0 and runs it (success)
	e.wg.Wait()

	// +10m: the 1m wall is long exceeded, nothing is running, nothing has
	// completed for 10m — the outage opens and the budget stop must NOT
	// fire. The dead runtime's step claim (script exhausted) defers at
	// zero attempt cost.
	fake = fake.Add(10 * time.Minute)
	e.tick(ctx)
	e.wg.Wait()
	got, _ := st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalActive {
		t.Fatalf("outage must freeze budget stops: goal=%s", got.Status)
	}
	e.mu.Lock()
	outageOpen := !e.outageStart.IsZero()
	e.mu.Unlock()
	if !outageOpen {
		t.Fatal("the watchdog must have opened the outage")
	}
	var s2 *fgs.Step
	load := func() {
		steps, _ := st.ListSteps(ctx, g.ID)
		s2 = nil
		for i := range steps {
			if steps[i].Description == "s2" {
				s2 = &steps[i]
			}
		}
	}
	load()
	if s2 == nil {
		t.Fatal("s2 missing")
	}
	if s2.Status != fgs.StepPending || s2.Attempts != 0 {
		t.Fatalf("outage failure must defer at zero cost: status=%s attempts=%d", s2.Status, s2.Attempts)
	}

	// +20m more: still dead, still frozen.
	fake = fake.Add(20 * time.Minute)
	e.tick(ctx)
	e.wg.Wait()
	load()
	if s2.Status != fgs.StepPending || s2.Attempts != 0 {
		t.Fatalf("outage must keep deferring at zero cost: status=%s attempts=%d", s2.Status, s2.Attempts)
	}

	// Recovery: the runtime answers again — the tick's probe turn closes
	// the outage and shifts the wall clocks by the outage length (opened at
	// 12:10, closed at 12:32). +2m so the probe's 1m pacing floor passes.
	// The wall budget is deepened first (the 1m wall + 32m of elapsed fake
	// time would otherwise legitimately stop the goal on the shifted
	// clock): what must be demonstrated here is resumption, and steps were
	// not claimed during the outage tick itself.
	fake = fake.Add(2 * time.Minute)
	e.cfg.Runtime.GoalWallBudget = cfg.Duration(40 * time.Minute)
	fr.mu.Lock()
	fr.queue = append(fr.queue,
		ok("OK"), // the runtime probe's reply
		ok(`{"accepted":true,"data":{"finding":{"content":"s2 done","evidence":"e"}}}`),
	)
	fr.mu.Unlock()
	e.tick(ctx)
	e.wg.Wait()
	e.mu.Lock()
	closed := e.outageStart.IsZero()
	first := e.firstClaim[g.ID]
	e.mu.Unlock()
	if !closed {
		t.Fatal("a successful probe turn must close the outage")
	}
	if want := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC).Add(22 * time.Minute); !first.Equal(want) {
		t.Fatalf("wall clock must shift by the outage length: got %s want %s", first, want)
	}
	load()
	if s2.Status != fgs.StepPending {
		t.Fatalf("no step may be claimed while the outage is open: %s", s2.Status)
	}
	// Refresh the decide checkpoint so the recovering tick schedules s2
	// deterministically (s1's finding would otherwise trigger a Decide
	// round racing s2's execute for the scripted replies).
	e.refreshCheckpoint(ctx, g.ID)
	e.tick(ctx) // outage closed: normal scheduling resumes
	e.wg.Wait()
	load()
	if s2.Status != fgs.StepDone {
		t.Fatalf("recovered runtime must complete the deferred step: %s", s2.Status)
	}
}

func TestHintRescueRoundsFiresBeforeGuardEdge(t *testing.T) {
	// Completion-rate runs pull the platform hint early (HintRescueRounds)
	// instead of letting the goal burn empty rounds toward the stop guard.
	ctx := context.Background()
	e, st, _ := newEngine(t,
		ok(`{"accepted":true,"data":{}}`),
		ok(`{"accepted":true,"data":{}}`),
		ok(`{"accepted":true,"data":{}}`),
		ok(`{"accepted":true,"data":{}}`),
	)
	e.cfg.Runtime.DecideNoopLimit = 3
	e.cfg.Runtime.HintRescueRounds = 1
	g, _ := st.CreateGoal(ctx, "early-rescue", "o", "obj")
	calls := 0
	e.NoopRescue = func(_ context.Context, _ string) (string, bool) {
		calls++
		return "aim at the upload endpoint", true
	}
	e.decide(ctx, g.ID, "initial") // noop 1 -> already at rescue threshold
	if calls != 1 {
		t.Fatalf("early rescue must fire at round 1, calls = %d", calls)
	}
	hints, _ := st.ListHints(ctx, g.ID)
	if len(hints) != 1 || !strings.Contains(hints[0].Content, "upload endpoint") {
		t.Fatalf("early rescue hint not written: %+v", hints)
	}
	got, _ := st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalActive {
		t.Fatalf("goal must survive the early rescue, got %s", got.Status)
	}
	// The rescue is spent; three more empty rounds hit the guard edge and
	// stop the goal (no second fetch).
	e.decide(ctx, g.ID, "t")
	e.decide(ctx, g.ID, "t")
	e.decide(ctx, g.ID, "t")
	if calls != 1 {
		t.Fatalf("rescue stays one-shot, calls = %d", calls)
	}
	got, _ = st.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalStopped {
		t.Fatalf("goal must stop at the guard edge, got %s", got.Status)
	}
	if !e.rescuedTitle["early-rescue"] {
		t.Fatal("title-level hint bookkeeping must record the fetch")
	}
}

func TestRequeueSeedsPlatformHintIntoFreshPass(t *testing.T) {
	// A stalled title's fresh pass opens AIMED: requeuePass2 pulls the
	// platform hint for the title (once per title, across passes) so
	// pass-2 starts from the hint's direction instead of re-walking dead
	// ends the ledger already ruled out.
	ctx := context.Background()
	e, st, _ := newEngine(t)
	e.cfg.Runtime.RunDeadline = cfg.Duration(time.Hour)
	e.cfg.Runtime.GoalStepBudget = 0
	e.cfg.Runtime.GoalWallBudget = 0
	e.mu.Lock()
	e.startedAt = time.Now().Add(-30 * time.Minute) // Run() never started: arm the deadline window by hand
	e.mu.Unlock()
	g, _ := st.CreateGoal(ctx, "bench:x-99", "o", "obj")
	st.AddHumanFact(ctx, g.ID, "seed", "t")
	calls := 0
	e.NoopRescue = func(_ context.Context, _ string) (string, bool) {
		calls++
		return "the debug route leaks the config", true
	}
	ng, ok := e.requeuePass2(ctx, g)
	if !ok {
		t.Fatal("requeue must mint the pass-2 goal")
	}
	if calls != 1 {
		t.Fatalf("hint pre-seed must fetch once, calls = %d", calls)
	}
	hints, _ := st.ListHints(ctx, ng.ID)
	if len(hints) != 1 || !strings.Contains(hints[0].Content, "debug route") {
		t.Fatalf("pass-2 goal must carry the seeded hint: %+v", hints)
	}
	// Second requeue: the title's hint was already pulled — no refetch.
	if _, ok := e.requeuePass2(ctx, ng); !ok {
		t.Fatal("second requeue within caps must succeed")
	}
	if calls != 1 {
		t.Fatalf("title-level dedupe broken, calls = %d", calls)
	}
}

func TestEndgameRankOneFromDoneOverUntouchedOverDeepPartial(t *testing.T) {
	// 43574 post-mortem: "banked" is not one tier. A title one flag from
	// completion is the fleet's cheapest conversion; an UNTOUCHED title
	// beats a deep partial (b-01/b-03 sat 2/4 from t+80m and monopolized
	// the top slots for a zero-flag final half hour while 39 untouched
	// titles starved — the pair has ended 2/4 in every run since 42361).
	ctx := context.Background()
	e, st, _ := newEngine(t)
	e.FlagProgress = func(title string) (int, int, bool) {
		switch title {
		case "bench:one-from-done":
			return 2, 3, true
		case "bench:deep-partial":
			return 2, 4, true
		case "bench:zero-multi":
			return 0, 6, true
		case "bench:untouched":
			return 0, 1, true
		}
		return 0, 0, false
	}
	mk := func(title string) *fgs.Goal {
		g, err := st.CreateGoal(ctx, title, "o", "obj")
		if err != nil {
			t.Fatal(err)
		}
		return g
	}
	gDone, gFresh, gDeep, gZero := mk("bench:one-from-done"), mk("bench:untouched"), mk("bench:deep-partial"), mk("bench:zero-multi")
	// zero-multi is a WORKED regrind (run 43759: f2-01 burned six zero-flag
	// passes) — its title has seen a container. An untouched multi now ranks
	// with fresh singles (v21.1), so this mark is what keeps it in the
	// bottom tier where the assertions below expect it.
	e.mu.Lock()
	e.firstTouch["bench:zero-multi"] = true
	e.mu.Unlock()
	rank := e.endgameRank([]fgs.Goal{*gZero, *gDeep, *gFresh, *gDone})
	if !(rank[gDone.ID] > rank[gFresh.ID] && rank[gFresh.ID] > rank[gDeep.ID] && rank[gDeep.ID] > rank[gZero.ID]) {
		t.Fatalf("rank order broken: done=%d fresh=%d deep=%d zero=%d",
			rank[gDone.ID], rank[gFresh.ID], rank[gDeep.ID], rank[gZero.ID])
	}
	// Deep endgame budgets are for proven converters only: the untouched
	// title keeps the base wall even inside the window, the banked ones
	// get the deepened one.
	e.cfg.Runtime.GoalWallBudget = cfg.Duration(30 * time.Minute)
	e.cfg.Runtime.EndgameWallBudget = cfg.Duration(70 * time.Minute)
	e.cfg.Runtime.RunDeadline = cfg.Duration(time.Hour)
	e.cfg.Runtime.EndgameAfter = cfg.Duration(50 * time.Minute)
	e.mu.Lock()
	e.startedAt = time.Now().Add(-40 * time.Minute)
	e.mu.Unlock()
	if !e.inEndgame() {
		t.Fatal("test must sit inside the endgame window")
	}
	if got := e.wallBudgetFor("bench:untouched"); got != 30*time.Minute {
		t.Fatalf("untouched wall = %v, want base 30m", got)
	}
	for _, title := range []string{"bench:one-from-done", "bench:deep-partial"} {
		if got := e.wallBudgetFor(title); got != 70*time.Minute {
			t.Fatalf("%s wall = %v, want deep 70m", title, got)
		}
	}
	if got := e.stepBudgetFor("bench:untouched"); got != e.cfg.Runtime.GoalStepBudget {
		t.Fatalf("untouched step budget must stay base, got %d", got)
	}
}

func TestRequeueSeedsFlagStateFact(t *testing.T) {
	// 43574 session 3757389 (b-01): pass-2 did not know which flags were
	// already banked, re-derived one, and only learned it from the
	// platform's "duplicate" answer. The fresh pass must open carrying
	// the live flag count so its whole wall goes to the MISSING flags.
	ctx := context.Background()
	e, st, _ := newEngine(t)
	e.cfg.Runtime.RunDeadline = cfg.Duration(time.Hour)
	e.cfg.Runtime.GoalStepBudget = 0
	e.cfg.Runtime.GoalWallBudget = 0
	e.mu.Lock()
	e.startedAt = time.Now().Add(-30 * time.Minute)
	e.mu.Unlock()
	g, _ := st.CreateGoal(ctx, "bench:b-01", "o", "obj")
	e.FlagProgress = func(title string) (int, int, bool) {
		if title == "bench:b-01" {
			return 2, 4, true
		}
		return 0, 1, true
	}
	ng, ok := e.requeuePass2(ctx, g)
	if !ok {
		t.Fatal("requeue must mint the pass-2 goal")
	}
	facts, _ := st.ListFacts(ctx, ng.ID)
	state := ""
	for _, f := range facts {
		if strings.Contains(f.Content, "correct_flag_count=2") {
			state = f.Content
		}
	}
	if state == "" {
		t.Fatalf("pass-2 goal must carry the live flag-state fact: %+v", facts)
	}
	if !strings.Contains(state, "缺失的 4 个旗") && !strings.Contains(state, "缺失的 2") {
		// wording may shift; the invariant is: missing count named, duplicate named
		if !strings.Contains(state, "duplicate") || !strings.Contains(state, "2") {
			t.Fatalf("flag-state fact must name the missing count and the duplicate rule: %s", state)
		}
	}
	// Zero-progress titles get no flag-state fact (nothing banked to protect).
	g2, _ := st.CreateGoal(ctx, "bench:c-02", "o", "obj")
	ng2, ok := e.requeuePass2(ctx, g2)
	if !ok {
		t.Fatal("zero-progress requeue must succeed")
	}
	facts2, _ := st.ListFacts(ctx, ng2.ID)
	for _, f := range facts2 {
		if strings.Contains(f.Content, "平台旗情") {
			t.Fatalf("zero-banked title must not get a flag-state fact: %s", f.Content)
		}
	}
}

func TestSterileRequeueRefundsFuse(t *testing.T) {
	// Run 43633: c-04's pass-2/3/4 and c-02's pass-3 burned whole requeue
	// passes on WAITING_SLOT deferrals — the slot race minted goals that
	// never got a container, yet each consumed a fuse slot. A pass that
	// produced NO real agent output (no natural report, no deadline
	// salvage) refunds its fuse slot, once per title; a worked pass keeps
	// its slot. The refund must land before stopGoalForBudget's internal
	// re-mint, so a title at its fuse cap still earns one more real pass.
	ctx := context.Background()
	mockOK := ok(`{}`)
	e, st, _ := newEngine(t, mockOK)
	e.cfg.Runtime.RunDeadline = cfg.Duration(time.Hour)
	e.cfg.Runtime.GoalStepBudget = 0
	e.cfg.Runtime.GoalWallBudget = 0
	e.mu.Lock()
	e.startedAt = time.Now().Add(-30 * time.Minute)
	e.mu.Unlock()
	g, _ := st.CreateGoal(ctx, "bench:c-04", "o", "obj")
	countGoals := func() int {
		goals, _ := st.ListGoals(ctx)
		n := 0
		for _, gg := range goals {
			if gg.Title == "bench:c-04" {
				n++
			}
		}
		return n
	}

	// Burn the mid-run fuse: pass 2 and pass 3 both minted.
	ng, ok := e.requeuePass2(ctx, g)
	if !ok {
		t.Fatal("pass 2 must mint")
	}
	if _, ok := e.requeuePass2(ctx, ng); !ok {
		t.Fatal("pass 3 must mint (mid-run cap 2)")
	}
	if countGoals() != 3 {
		t.Fatalf("setup: want 3 goals (fresh + 2 passes), got %d", countGoals())
	}

	// The newest pass dies STERILE: refund fires, and stopGoalForBudget's
	// internal re-mint becomes legal again — one more goal appears despite
	// the burned cap. The newest minted goal is pass 3; find it by listing.
	goals, _ := st.ListGoals(ctx)
	var ng3 fgs.Goal
	for _, gg := range goals {
		if gg.Title == "bench:c-04" && gg.Status == fgs.GoalActive && gg.ID != g.ID && gg.ID != ng.ID {
			ng3 = gg
		}
	}
	e.stopGoalForBudget(ctx, ng3.ID, "wall")
	e.mu.Lock()
	refunded := e.sterileRefunded["bench:c-04"]
	rq := e.requeues["bench:c-04"]
	e.mu.Unlock()
	if !refunded {
		t.Fatal("sterile death must bank the title's one refund")
	}
	if rq != 2 {
		t.Fatalf("refund must land before the re-mint, requeues = %d", rq)
	}
	if countGoals() != 4 {
		t.Fatalf("refund must buy one more pass at the cap: goals = %d", countGoals())
	}

	// A WORKED pass keeps its fuse slot: fresh engine, mint, finish a step
	// naturally, stop — no refund banked.
	e2, st2, _ := newEngine(t, mockOK)
	e2.cfg.Runtime.RunDeadline = cfg.Duration(time.Hour)
	e2.cfg.Runtime.GoalStepBudget = 0
	e2.cfg.Runtime.GoalWallBudget = 0
	e2.mu.Lock()
	e2.startedAt = time.Now().Add(-30 * time.Minute)
	e2.mu.Unlock()
	g2, _ := st2.CreateGoal(ctx, "bench:c-04", "o", "obj")
	ng2, ok := e2.requeuePass2(ctx, g2)
	if !ok {
		t.Fatal("pass 2 must mint")
	}
	facts, _ := st2.ListFacts(ctx, ng2.ID)
	docs, valve := false, false
	for _, f := range facts {
		if strings.Contains(f.Content, "增量落盘") {
			docs = true
		}
		if strings.Contains(f.Content, "止损阀") {
			valve = true
		}
	}
	if !docs {
		t.Fatal("pass fact must carry the incremental ledger-flush doctrine")
	}
	if !valve {
		t.Fatal("pass fact must carry the switch-strategy escape valve (run 43759: f2-01 burned six passes locked on one stalling derivation)")
	}
	e2.noteStepFinish(ng2.ID)
	e2.stopGoalForBudget(ctx, ng2.ID, "wall")
	e2.mu.Lock()
	refunded2 := e2.sterileRefunded["bench:c-04"]
	rq2 := e2.requeues["bench:c-04"]
	e2.mu.Unlock()
	if refunded2 {
		t.Fatal("a pass with a natural report must not refund")
	}
	if rq2 != 2 {
		t.Fatalf("worked pass keeps its slot then re-mints within caps, requeues = %d", rq2)
	}
}

func TestStalledPartialLosesConverterPrivileges(t *testing.T) {
	// v27 (run 46870): a banked partial that stops converting must lose the
	// converter exemptions after FlagStallPasses zero-delta pass boundaries —
	// the endgame requeue lift (short fuse instead of 8), the rank-2
	// deep-partial tier (demoted to the worked-zero tier), and live-work
	// credit. Any new flag resets the streak, so a converting title never
	// trips it (the same run's OTHER intranet converted twice mid-siege).
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.RunDeadline = cfg.Duration(10 * time.Hour) // mid-run; endgame off
	e.cfg.Runtime.EndgameAfter = 0
	e.startedAt = e.now()
	correct := 3
	e.FlagProgress = func(string) (int, int, bool) { return correct, 6, true }

	g0, _ := st.CreateGoal(ctx, "bench:stall", "o", "obj")

	// Pass 1 ends having banked 3 flags (0→3): a converter, streak reset.
	ng1, okMint := e.requeuePass2(ctx, g0)
	if !okMint {
		t.Fatal("converting pass must requeue normally")
	}
	if e.stalledTitle("bench:stall") {
		t.Fatal("a converting title must never count as stalled")
	}

	// Pass 2 ends with zero new flags: streak 1 — privileges still held.
	ng2, okMint := e.requeuePass2(ctx, ng1)
	if !okMint {
		t.Fatal("first zero-delta pass must not break the fuse (limit is 2)")
	}
	if e.stalledTitle("bench:stall") {
		t.Fatal("streak 1 of 2 must not yet stall the title")
	}

	// Pass 3 ends with zero new flags: streak 2 — stalled. Mid-run the
	// banked exemption is gone (maxFor drops to the dud fuse of 1 and the
	// two already spent requeues block the mint).
	if ng3, okMint := e.requeuePass2(ctx, ng2); okMint {
		t.Fatalf("stalled partial must lose its mid-run requeue exemption, minted %v", ng3.ID)
	}
	if !e.stalledTitle("bench:stall") {
		t.Fatal("two consecutive zero-delta boundaries must stall the title")
	}

	// Rank demotion: a stalled deep partial drops from tier 2 to tier 1 —
	// below every untouched title — but keeps idle-slot eligibility.
	rank := e.endgameRank([]fgs.Goal{*ng2})
	if rank[ng2.ID] != 1 {
		t.Fatalf("stalled partial must rank at the worked-zero tier, got %d", rank[ng2.ID])
	}

	// Endgame: the stalled title still earns the short fuse (idle slots are
	// worth converting), just not the converter lift of 8.
	e.cfg.Runtime.RunDeadline = cfg.Duration(2 * time.Hour)
	e.cfg.Runtime.EndgameAfter = cfg.Duration(90 * time.Minute)
	e.startedAt = e.now().Add(-time.Hour) // elapsed 1h ≥ deadline−window: endgame
	if _, okMint := e.requeuePass2(ctx, ng2); !okMint {
		t.Fatal("stalled partial must still requeue in the endgame (short fuse)")
	}

	// A new flag anywhere resets the streak: the title converts again.
	correct = 4
	e.notePassBoundary(&fgs.Goal{ID: "synthetic", Title: "bench:stall"})
	if e.stalledTitle("bench:stall") {
		t.Fatal("banking a new flag must reset the stall streak")
	}
	rank = e.endgameRank([]fgs.Goal{*ng2})
	if rank[ng2.ID] == 1 {
		t.Fatal("re-converting partial must regain its tier")
	}
}

func TestHintRepeatTextMarksPoolDry(t *testing.T) {
	// The platform charges every hint view; a repeat text means the pool is
	// exhausted. The noop rescue is one-shot per GOAL, so a later pass's goal
	// can fire it again for the same TITLE — the repeat must mark the pool
	// dry, seed nothing, and never pay for another pull on any later path
	// (the requeue pre-seed respects the dry flag too).
	ctx := context.Background()
	e, st, _ := newEngine(t, ok(`{}`))
	e.cfg.Runtime.RunDeadline = cfg.Duration(10 * time.Hour)
	e.startedAt = e.now()
	e.cfg.Runtime.DecideNoopLimit = 2
	e.FlagProgress = func(string) (int, int, bool) { return 1, 4, true }
	pulls := 0
	e.NoopRescue = func(context.Context, string) (string, bool) {
		pulls++
		return "hint: the key sleeps in the config", true
	}

	// Pass-1 goal: two empty rounds fire the rescue once, hint seeded, title
	// marked as pulled.
	g1, _ := st.CreateGoal(ctx, "bench:dry", "o", "obj")
	e.countNoop(ctx, g1.ID, true)
	e.countNoop(ctx, g1.ID, true)
	if pulls != 1 {
		t.Fatalf("rescue must fire once per goal, got %d pulls", pulls)
	}

	// Pass-2 goal of the same title: the rescue fires again (fresh goal),
	// the platform repeats the text — pool dry, nothing seeded.
	g2, _ := st.CreateGoal(ctx, "bench:dry", "o", "obj")
	e.countNoop(ctx, g2.ID, true)
	e.countNoop(ctx, g2.ID, true)
	if pulls != 2 {
		t.Fatalf("second goal must pull once to discover the repeat, got %d", pulls)
	}
	if !e.hintDryTitle("bench:dry") {
		t.Fatal("exact-text repeat must mark the pool dry")
	}
	if gg, err := st.GetGoal(ctx, g2.ID); err != nil || gg.Status != fgs.GoalStopped {
		t.Fatalf("an unseedable rescue must fall through to the noop stop, err=%v status=%v", err, gg.Status)
	}

	// Dry flag holds across every later path: the requeue pre-seed must not
	// pay for another view.
	g3, _ := st.CreateGoal(ctx, "bench:dry", "o", "obj")
	e.requeuePass2(ctx, &fgs.Goal{ID: g3.ID, Title: "bench:dry", Origin: "o", Objective: "obj"})
	if pulls != 2 {
		t.Fatalf("dry pool must never be pulled again, got %d pulls", pulls)
	}
}
