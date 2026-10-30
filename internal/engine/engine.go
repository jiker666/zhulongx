// Package engine is zhulongx's scheduler: it drives Goals through the
// FGS graph by alternating two modes.
//
//   - Decide (serial, globally): reviews open findings, judges completion,
//     declares new steps.
//   - Execute (bounded concurrency): pushes one step through the Pi agent
//     loop, validates the result, records a Finding.
//
// Scheduling rules:
//   - Decide runs on the first tick and whenever the graph grew (facts,
//     findings, hints) or all steps drained to zero open.
//   - While steps are open, Execute keeps ClaimNextStep until the
//     concurrency budget is spent.
//   - A completed/stopped goal stops scheduling immediately.
package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"zhulongx/internal/cfg"
	"zhulongx/internal/fgs"
	"zhulongx/internal/pi"
	"zhulongx/internal/store"
)

// Runner is the agent-loop interface the engine depends on. Production
// uses *pi.Adapter; tests inject scripted fakes.
type Runner interface {
	Prompt(ctx context.Context, message string) (*pi.PromptResult, error)
	Close() error
}

// RunnerFactory launches one isolated runner context. Each call must
// produce an independent process/context (spec: isolated call contexts).
type RunnerFactory func() (Runner, error)

// Engine owns the run loop.
type Engine struct {
	store     *store.Store
	cfg       *cfg.Config
	log       *slog.Logger
	newRunner RunnerFactory

	mu       sync.Mutex
	snapshot map[string]store.SnapshotCounts // last Decide checkpoint per goal
	noop     map[string]int                  // consecutive empty Decide rounds
	rescued  map[string]bool                 // goals whose noop rescue already fired (one shot per goal)
	deciding string                          // goalID of the in-flight Decide round ("" = none): Decide is globally serial
	running  int                             // active Execute goroutines

	// Budget bookkeeping (GoalStepBudget / GoalWallBudget / RunDeadline).
	now        func() time.Time    // injectable clock
	startedAt  time.Time           // set in Run; RunDeadline counts from here
	firstClaim map[string]time.Time // goalID → first claimed step time
	requeues   map[string]int       // title → requeues spent (cap 2)

	// Runner breaker: N consecutive infra failures (launch, process exit,
	// protocol) open a cooldown during which no steps are claimed and no
	// Decide rounds run — pending steps wait at zero attempt cost instead of
	// burning attempts on a dead runtime.
	failStreak    int
	cooldownUntil time.Time

	// NoopRescue, when set, fires once per goal at the edge of the noop
	// guard — the moment the agent has exhausted its own ideas across
	// DecideNoopLimit empty rounds. Returning a non-empty hint writes it
	// as a Hint (decideTrigger re-runs Decide on hint growth) and buys one
	// last guided round; returning ok=false proceeds with the stop.
	// Wire it to the benchmark hint endpoint: full score is lost either
	// way, the hint only trades a fraction of it.
	NoopRescue func(ctx context.Context, goalID string) (hint string, ok bool)

	// StepGate, when set, is consulted before claiming each Execute step
	// for a goal. Returning false skips the goal for this tick — its steps
	// stay pending at zero model cost. Wire it to the benchmark slot gate
	// so a goal that cannot get a challenge container never enters the
	// agent loop to burn turns waiting for one.
	StepGate func(ctx context.Context, goalID string) bool

	// ReleaseContainer, when set, is asked to close a stopped goal's
	// challenge container. The immediate pass-2 requeue keeps the title
	// non-terminal, so the slot gate's reaper will not free the slot —
	// without this an idle container pins one of three slots until the
	// pass-2 goal reaches the front of the queue, hours later (run 42176:
	// a-05 held a slot ~29 min past its budget stop this way).
	ReleaseContainer func(ctx context.Context, goalID string)

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// New builds an engine. factory may be nil → default Pi launcher.
func New(st *store.Store, c *cfg.Config, log *slog.Logger, factory RunnerFactory) *Engine {
	if factory == nil {
		factory = func() (Runner, error) {
			// invalid patterns already rejected at config load; ignore the error
			policy, _ := pi.CompileToolPolicy(c.Pi.BlockedTools)
			return pi.Start(pi.LaunchConfig{
				Command: c.Pi.Command,
				Args:    c.Pi.Args,
				Dir:     c.Pi.Dir,
				Policy:  policy,
			})
		}
	}
	return &Engine{
		store:      st,
		cfg:        c,
		log:        log,
		newRunner:  factory,
		snapshot:   map[string]store.SnapshotCounts{},
		noop:       map[string]int{},
		rescued:    map[string]bool{},
		now:        time.Now,
		firstClaim: map[string]time.Time{},
		requeues:   map[string]int{},
	}
}

// Run executes the scheduling loop until ctx is cancelled. On start it
// performs deterministic recovery of orphaned running steps.
func (e *Engine) Run(ctx context.Context) error {
	ctx, e.cancel = context.WithCancel(ctx)
	defer e.cancel()

	if n, err := e.store.RecoverAllRunning(ctx, "startup recovery"); err != nil {
		return fmt.Errorf("engine: recovery: %w", err)
	} else if n > 0 {
		e.log.Info("recovered running steps", "count", n)
	}
	e.startedAt = e.now()

	ticker := time.NewTicker(e.cfg.Runtime.TickInterval.D())
	defer ticker.Stop()
	for {
		e.tick(ctx)
		select {
		case <-ctx.Done():
			e.wg.Wait()
			return nil
		case <-ticker.C:
		}
	}
}

// Stop cancels the loop and waits for in-flight Execute work.
func (e *Engine) Stop() {
	if e.cancel != nil {
		e.cancel()
	}
	e.wg.Wait()
}

// stepWatchdogTTL bounds how long a running step may go without a
// heartbeat before the scheduler reclaims it. Live executors heartbeat
// every TickInterval; several minutes of silence means the goroutine (or
// the whole engine) died mid-flight and its slot is stuck.
const stepWatchdogTTL = 3 * time.Minute

// breakerThreshold / breakerCooldown: three consecutive infra runner
// failures (spawn crash, process exit, protocol refusal) pause all claims
// and Decide rounds briefly — a dead runtime must not eat attempt budgets
// while steps sit pending (run 42298 class deaths burn one attempt per
// tick otherwise). Any successful runner turn resets the streak.
const (
	breakerThreshold = 3
	breakerCooldown  = 3 * time.Minute
)

// noteRunnerFailure counts an infrastructure failure (the runtime is sick,
// not the model being slow — timeouts never count). Crossing the threshold
// opens (or, after expiry, re-arms) the cooldown.
func (e *Engine) noteRunnerFailure(stage string) {
	e.mu.Lock()
	e.failStreak++
	open := e.failStreak >= breakerThreshold && !e.now().Before(e.cooldownUntil)
	if open {
		e.cooldownUntil = e.now().Add(breakerCooldown)
	}
	e.mu.Unlock()
	if open {
		e.log.Warn("engine: runner breaker open — claims paused", "streak", e.failStreak, "cooldown", breakerCooldown.String(), "stage", stage)
	}
}

// noteRunnerSuccess resets the failure streak: any completed runner turn
// proves the runtime is alive.
func (e *Engine) noteRunnerSuccess() {
	e.mu.Lock()
	e.failStreak = 0
	e.mu.Unlock()
}

// breakerOpen reports whether the engine is pausing work because the
// runner infrastructure keeps failing.
func (e *Engine) breakerOpen() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.now().Before(e.cooldownUntil)
}

// tick is one scheduling pass over all goals.
func (e *Engine) tick(ctx context.Context) {
	if n, err := e.store.ReclaimStaleSteps(ctx, stepWatchdogTTL, e.cfg.Runtime.StepMaxAttempts, "heartbeat lease expired"); err != nil {
		e.log.Error("reclaim stale steps", "err", err)
	} else if n > 0 {
		e.log.Warn("reclaimed stale running steps", "count", n)
	}
	goals, err := e.store.ListGoals(ctx)
	if err != nil {
		e.log.Error("list goals", "err", err)
		return
	}
	for _, g := range goals {
		if ctx.Err() != nil {
			return
		}
		if g.Status != "active" {
			continue
		}
		e.scheduleGoal(ctx, g.ID)
	}
}

// requeuePass2 immediately recreates a just-stopped goal for its second
// pass. The pass-2 goal lands at the BACK of the scheduling queue
// (creation order), so untouched first-pass challenges keep priority and
// retries fill the remaining time. Run 41925 proved a drain-gated requeue
// never fires on a 63-challenge queue — the first pass alone outlives the
// run — so the requeue must be immediate. One requeue per title; a goal
// whose second pass also exhausts its budget stays stopped for good.
func (e *Engine) requeuePass2(ctx context.Context, g *fgs.Goal) {
	// Up to two requeues: pass-2 continues the ledger, pass-3 is the last
	// fresh look for challenges that need it (42176: the hardest tier was
	// still mid-derivation when pass-2 died to infra churn).
	const maxRequeues = 2
	if e.cfg.Runtime.RunDeadline <= 0 || ctx.Err() != nil {
		return
	}
	e.mu.Lock()
	done := e.requeues[g.Title]
	e.mu.Unlock()
	if done >= maxRequeues {
		return
	}
	if e.now().Add(10 * time.Minute).After(e.startedAt.Add(e.cfg.Runtime.RunDeadline.D())) {
		return // too late for a meaningful another pass
	}
	ng, err := e.store.CreateGoal(ctx, g.Title, g.Origin, g.Objective)
	if err != nil {
		e.log.Error("requeue: create goal", "title", g.Title, "err", err)
		return
	}
	pass := done + 2
	if _, err := e.store.AddHumanFact(ctx, ng.ID,
		fmt.Sprintf("此题进入第 %d 遍进攻:前面每一遍的完整过程与结论都已写入 attack/ 目录下本题的 work.md 台账。开局第一动作是读台账(及 attack/notes.md),只做台账里标记为【未测】或【差一步】的假设,严禁从零重扫已排除的方向;若台账显示上一遍按 hint 方向也没走通,先拉下一个 hint 再动手。flag 目标与提交方式不变。", pass),
		"engine:pass2"); err != nil {
		e.log.Error("requeue: seed fact", "goal", ng.ID, "err", err)
	}
	e.mu.Lock()
	e.requeues[g.Title] = done + 1
	e.mu.Unlock()
	e.log.Info("requeue: goal requeued for another pass", "title", g.Title, "goal", ng.ID, "pass", pass)
}

func (e *Engine) scheduleGoal(ctx context.Context, goalID string) {
	// Budget first: an exhausted goal must not spend another Decide round
	// declaring "promising" steps it will never get to run.
	if over, why := e.goalOverBudget(ctx, goalID); over {
		e.stopGoalForBudget(ctx, goalID, why)
		return
	}

	// Runner breaker: a runtime that keeps dying must not eat attempt
	// budgets — wait out the cooldown with everything left pending.
	if e.breakerOpen() {
		return
	}

	e.mu.Lock()
	snap, hasSnap := e.snapshot[goalID]
	deciding := e.deciding != ""
	e.mu.Unlock()

	// Bootstrap: a brand-new goal with no steps skips its first Decide
	// round — the engine itself declares the configured direct-attack step.
	// Easy objectives then cost one Execute pass instead of the full
	// Decide→decompose→Execute cycle, and when the direct attack fails its
	// finding is exactly the intel Decide needs for a good first split.
	// Requeued pass-2/3 goals are brand-new goals too: their bootstrap step
	// is a one-shot "read the ledger, attack the flagged hypothesis" pass.
	if bs := e.cfg.Runtime.BootstrapStep; bs != "" && !hasSnap {
		if steps, err := e.store.ListSteps(ctx, goalID); err == nil && len(steps) == 0 {
			if _, err := e.store.CreateStep(ctx, goalID, bs, nil, "engine:bootstrap"); err != nil {
				e.log.Error("bootstrap: create step", "goal", goalID, "err", err)
			} else {
				e.log.Info("bootstrap: direct-attack step declared", "goal", goalID)
			}
		}
	}

	// Decide trigger: first round, graph growth, or drained steps. Decide
	// is globally serial — one round across all goals at a time.
	if !deciding {
		if trigger, why := e.decideTrigger(ctx, goalID, snap, hasSnap); trigger {
			e.startDecide(ctx, goalID, why)
		}
	}

	// Execute: keep claiming while budget remains.
	for {
		e.mu.Lock()
		if e.running >= e.cfg.Runtime.MaxConcurrentSteps {
			e.mu.Unlock()
			return
		}
		e.mu.Unlock()
		if e.StepGate != nil && !e.StepGate(ctx, goalID) {
			return // no slot for this goal's challenge; steps stay pending
		}
		step, err := e.store.ClaimNextStep(ctx, goalID, "zhulongx")
		if err != nil {
			if !errors.Is(err, store.ErrNothingToClaim) && !errors.Is(err, store.ErrGoalNotActive) {
				e.log.Error("claim step", "goal", goalID, "err", err)
			}
			return
		}
		e.mu.Lock()
		e.running++
		if _, ok := e.firstClaim[goalID]; !ok {
			e.firstClaim[goalID] = e.now()
		}
		e.mu.Unlock()
		e.wg.Add(1)
		go func(st *stepRef) {
			defer e.wg.Done()
			e.executeStep(ctx, goalID, st.id)
			e.mu.Lock()
			e.running--
			e.mu.Unlock()
		}(&stepRef{step.ID})
	}
}

type stepRef struct{ id string }

// goalOverBudget reports whether the goal has exhausted GoalStepBudget or
// GoalWallBudget. A goal with a step still in flight is never over budget
// here: the stop must not race the executor's finish write.
func (e *Engine) goalOverBudget(ctx context.Context, goalID string) (bool, string) {
	sb, wb := e.cfg.Runtime.GoalStepBudget, e.cfg.Runtime.GoalWallBudget.D()
	if sb <= 0 && wb <= 0 {
		return false, ""
	}
	_, running, err := e.store.OpenStepCount(ctx, goalID)
	if err != nil || running > 0 {
		return false, "" // checked again next tick
	}
	if sb > 0 {
		steps, err := e.store.ListSteps(ctx, goalID)
		if err == nil {
			done := 0
			for _, s := range steps {
				if s.Status == fgs.StepDone {
					done++
				}
			}
			if done >= sb {
				return true, fmt.Sprintf("step budget exhausted (%d done steps)", done)
			}
		}
	}
	if wb > 0 {
		e.mu.Lock()
		first, ok := e.firstClaim[goalID]
		e.mu.Unlock()
		if ok && e.now().Sub(first) > wb {
			return true, fmt.Sprintf("wall budget exhausted (%s in flight)", e.now().Sub(first).Round(time.Second))
		}
	}
	return false, ""
}

// stopGoalForBudget stops a zombie goal and requeues it for the second
// pass immediately. Findings stay in the graph; the agent-maintained attack
// ledger on disk is what carries knowledge across the requeue.
func (e *Engine) stopGoalForBudget(ctx context.Context, goalID string, why string) {
	g, err := e.store.GetGoal(ctx, goalID)
	if err != nil {
		return
	}
	if err := e.store.SetGoalStatus(ctx, goalID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
		e.log.Error("budget stop: set status", "goal", goalID, "err", err)
		return
	}
	e.releaseStoppedContainer(goalID)
	e.requeuePass2(ctx, g)
	e.log.Warn("budget: goal stopped, slot released", "goal", goalID, "title", g.Title, "reason", why)
}

// releaseStoppedContainer closes the stopped goal's challenge container off
// the tick path. The requeued pass-2 goal sits at the back of the queue and
// will not reuse the container for hours; an idle one must not hold a slot.
func (e *Engine) releaseStoppedContainer(goalID string) {
	if e.ReleaseContainer == nil {
		return
	}
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		e.ReleaseContainer(cctx, goalID)
	}()
}

// decideTrigger: run Decide on first sight,
// when the graph grew since the last Decide, or when no steps remain open.
func (e *Engine) decideTrigger(ctx context.Context, goalID string, prev store.SnapshotCounts, hasPrev bool) (bool, string) {
	cur, err := e.store.Snapshot(ctx, goalID)
	if err != nil {
		e.log.Error("snapshot", "goal", goalID, "err", err)
		return false, ""
	}
	if !hasPrev {
		// A goal that already has steps (engine bootstrap or externally
		// declared) needs no initial round: Decide enters when those steps
		// drain, with real intel instead of a split made at the moment of
		// least information.
		if steps, err := e.store.ListSteps(ctx, goalID); err == nil && len(steps) > 0 {
			if cur.OpenSteps == 0 {
				return true, "steps drained"
			}
			return false, ""
		}
		return true, "initial"
	}
	if cur.Facts > prev.Facts {
		return true, "facts grew"
	}
	if cur.Findings > prev.Findings {
		return true, "findings grew"
	}
	if cur.Hints > prev.Hints {
		return true, "hints grew"
	}
	if cur.OpenSteps == 0 {
		return true, "steps drained"
	}
	return false, ""
}

// startDecide launches the globally serial Decide round in the background.
func (e *Engine) startDecide(ctx context.Context, goalID, why string) {
	e.mu.Lock()
	if e.deciding != "" {
		e.mu.Unlock()
		return
	}
	e.deciding = goalID
	e.mu.Unlock()
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		e.decide(ctx, goalID, why)
		e.mu.Lock()
		e.deciding = ""
		e.mu.Unlock()
	}()
}

// refreshCheckpoint stores the post-Decide snapshot for the next trigger.
func (e *Engine) refreshCheckpoint(ctx context.Context, goalID string) {
	snap, err := e.store.Snapshot(ctx, goalID)
	if err == nil {
		e.mu.Lock()
		e.snapshot[goalID] = snap
		e.mu.Unlock()
	}
}
