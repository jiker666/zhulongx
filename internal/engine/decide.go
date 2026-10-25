package engine

import (
	"context"
	"fmt"
	"strings"

	"zhulongx/internal/contract"
	"zhulongx/internal/fgs"
	"zhulongx/internal/prompt"
)

// decide runs one Decide round for a goal (Cairn: run_reason_task).
// The verdict only becomes graph state after contract validation — a model
// saying "complete" without valid from-facts changes nothing.
func (e *Engine) decide(ctx context.Context, goalID, why string) {
	defer e.refreshCheckpoint(ctx, goalID)

	graph, err := e.store.LoadGraph(ctx, goalID)
	if err != nil {
		e.log.Error("decide: load graph", "goal", goalID, "err", err)
		return
	}
	if graph.Goal.Status != fgs.GoalActive {
		return // completed/stopped between trigger and run
	}

	openStepsEmpty := true
	for _, st := range graph.Steps {
		if st.Status == fgs.StepPending || st.Status == fgs.StepRunning {
			openStepsEmpty = false
			break
		}
	}
	var factIDs []string
	for _, f := range graph.Facts {
		factIDs = append(factIDs, f.ID)
	}

	p := prompt.RenderDecide(graph, factIDs, e.cfg.Runtime.MaxStepsPerDecide)

	runner, err := e.launchRunner()
	if err != nil {
		e.log.Error("decide: launch runner", "goal", goalID, "err", err)
		return
	}
	defer runner.Close()

	rctx, cancel := context.WithTimeout(ctx, e.cfg.Runtime.DecideTimeout.D())
	defer cancel()
	res, err := runner.Prompt(rctx, p)
	if err != nil {
		e.log.Error("decide: runner failed", "goal", goalID, "err", err)
		return
	}

	payload, err := contract.ExtractJSONObject(res.Text)
	if err != nil {
		e.log.Error("decide: no JSON in output", "goal", goalID, "preview", preview(res.Text))
		return
	}
	answer, err := contract.ValidateDecide(payload, openStepsEmpty, e.cfg.Runtime.MaxStepsPerDecide)
	if err != nil {
		e.log.Error("decide: invalid payload", "goal", goalID, "err", err, "preview", preview(res.Text))
		return
	}

	// Finding review is applied FIRST: a complete/steps verdict may
	// reference facts that only exist after promotion (e.g. complete.from
	// names the fact produced by promoting a finding this round), and
	// completing the goal would make the store reject the review.
	if len(answer.Promote) > 0 || len(answer.Discard) > 0 {
		if _, err := e.store.ReviewFindings(ctx, goalID, answer.Promote, answer.Discard, fgs.ActorDecide); err != nil {
			e.log.Error("decide: finding review failed", "goal", goalID, "err", err)
			return
		}
		e.log.Info("decide: reviewed findings", "goal", goalID, "promoted", len(answer.Promote), "discarded", len(answer.Discard))
	}

	switch answer.Kind {
	case contract.KindRejected:
		e.log.Warn("decide: rejected by agent", "goal", goalID, "reason", answer.RejectMsg)
		e.countNoop(goalID, openStepsEmpty)
	case contract.KindComplete:
		if err := e.store.CompleteGoal(ctx, goalID, answer.Complete.From, answer.Complete.Description, fgs.ActorDecide); err != nil {
			e.log.Error("decide: complete write failed", "goal", goalID, "err", err)
			return
		}
		e.log.Info("decide: goal completed", "goal", goalID, "from", strings.Join(answer.Complete.From, ","), "trigger", why)
	case contract.KindSteps:
		created := 0
		for _, spec := range answer.Steps {
			if _, err := e.store.CreateStep(ctx, goalID, spec.Description, spec.From, fgs.ActorDecide); err != nil {
				// Cairn tolerates per-intent create failures (403/404) and
				// continues; mirror that.
				e.log.Warn("decide: step create skipped", "goal", goalID, "err", err)
				continue
			}
			created++
		}
		e.log.Info("decide: declared steps", "goal", goalID, "created", created, "asked", len(answer.Steps), "trigger", why)
		if created == 0 {
			e.countNoop(goalID, openStepsEmpty)
			return
		}
		e.resetNoop(goalID)
	default: // noop
		e.log.Info("decide: no graph change", "goal", goalID, "trigger", why)
		e.countNoop(goalID, openStepsEmpty)
	}
}

// countNoop tracks consecutive unproductive rounds; when no steps are open
// past the configured limit the goal is auto-stopped so a looping model
// cannot burn budget forever (Cairn deviation, documented).
func (e *Engine) countNoop(goalID string, openStepsEmpty bool) {
	if !openStepsEmpty {
		return // waiting on in-flight steps is normal, not a no-op streak
	}
	e.mu.Lock()
	e.noop[goalID]++
	n := e.noop[goalID]
	e.mu.Unlock()
	if n >= e.cfg.Runtime.DecideNoopLimit {
		if err := e.store.SetGoalStatus(context.Background(), goalID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
			e.log.Error("decide: noop guard stop failed", "goal", goalID, "err", err)
			return
		}
		e.log.Warn("decide: goal auto-stopped after repeated empty rounds", "goal", goalID, "rounds", n)
	}
}

func (e *Engine) resetNoop(goalID string) {
	e.mu.Lock()
	e.noop[goalID] = 0
	e.mu.Unlock()
}

// launchRunner spawns a runner with bounded retries on startup crash.
func (e *Engine) launchRunner() (Runner, error) {
	var lastErr error
	for attempt := 0; attempt <= e.cfg.Pi.SpawnRetries; attempt++ {
		r, err := e.newRunner()
		if err == nil {
			return r, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("runner launch failed after %d attempt(s): %w", e.cfg.Pi.SpawnRetries+1, lastErr)
}

func preview(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}
