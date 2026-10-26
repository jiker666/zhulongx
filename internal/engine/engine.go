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

	// NoopRescue, when set, fires once per goal at the edge of the noop
	// guard — the moment the agent has exhausted its own ideas across
	// DecideNoopLimit empty rounds. Returning a non-empty hint writes it
	// as a Hint (decideTrigger re-runs Decide on hint growth) and buys one
	// last guided round; returning ok=false proceeds with the stop.
	// Wire it to the benchmark hint endpoint: full score is lost either
	// way, the hint only trades a fraction of it.
	NoopRescue func(ctx context.Context, goalID string) (hint string, ok bool)

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
		store:     st,
		cfg:       c,
		log:       log,
		newRunner: factory,
		snapshot:  map[string]store.SnapshotCounts{},
		noop:      map[string]int{},
		rescued:   map[string]bool{},
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

// tick is one scheduling pass over all goals.
func (e *Engine) tick(ctx context.Context) {
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

func (e *Engine) scheduleGoal(ctx context.Context, goalID string) {
	e.mu.Lock()
	snap, hasSnap := e.snapshot[goalID]
	deciding := e.deciding != ""
	e.mu.Unlock()

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
		step, err := e.store.ClaimNextStep(ctx, goalID, "zhulongx")
		if err != nil {
			if !errors.Is(err, store.ErrNothingToClaim) && !errors.Is(err, store.ErrGoalNotActive) {
				e.log.Error("claim step", "goal", goalID, "err", err)
			}
			return
		}
		e.mu.Lock()
		e.running++
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

// decideTrigger: run Decide on first sight,
// when the graph grew since the last Decide, or when no steps remain open.
func (e *Engine) decideTrigger(ctx context.Context, goalID string, prev store.SnapshotCounts, hasPrev bool) (bool, string) {
	cur, err := e.store.Snapshot(ctx, goalID)
	if err != nil {
		e.log.Error("snapshot", "goal", goalID, "err", err)
		return false, ""
	}
	if !hasPrev {
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
