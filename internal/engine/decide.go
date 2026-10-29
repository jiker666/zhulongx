package engine

import (
	"context"
	"fmt"
	"strings"

	"zhulongx/internal/contract"
	"zhulongx/internal/fgs"
	"zhulongx/internal/prompt"
)

// decide runs one Decide round for a goal.
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

	payload, _ := contract.ExtractJSONObject(res.Text)
	if payload == nil {
		e.log.Warn("decide: no JSON in output — one repair round", "goal", goalID, "preview", preview(res.Text))
		if fixed := e.repairJSON(ctx, runner, "contained no parseable JSON object"); fixed != nil {
			payload = fixed
			e.log.Info("decide: repair round salvaged the verdict", "goal", goalID)
		}
	}
	if payload == nil {
		e.log.Error("decide: no JSON in output", "goal", goalID, "preview", preview(res.Text))
		return
	}
	answer, err := contract.ValidateDecide(payload, openStepsEmpty, e.cfg.Runtime.MaxStepsPerDecide)
	if err != nil {
		e.log.Warn("decide: invalid payload — one repair round", "goal", goalID, "err", err)
		if fixed := e.repairJSON(ctx, runner, "did not validate ("+err.Error()+")"); fixed != nil {
			if a2, err2 := contract.ValidateDecide(fixed, openStepsEmpty, e.cfg.Runtime.MaxStepsPerDecide); err2 == nil {
				answer, err = a2, nil
				e.log.Info("decide: repair round salvaged the verdict", "goal", goalID)
			}
		}
		if err != nil {
			e.log.Error("decide: invalid payload", "goal", goalID, "err", err, "preview", preview(res.Text))
			return
		}
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
		e.countNoop(ctx, goalID, openStepsEmpty)
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
				// Per-step create failures are tolerated (lost races/inactive goals) and
				// continues; mirror that.
				e.log.Warn("decide: step create skipped", "goal", goalID, "err", err)
				continue
			}
			created++
		}
		e.log.Info("decide: declared steps", "goal", goalID, "created", created, "asked", len(answer.Steps), "trigger", why)
		if created == 0 {
			e.countNoop(ctx, goalID, openStepsEmpty)
			return
		}
		e.resetNoop(goalID)
	default: // noop
		e.log.Info("decide: no graph change", "goal", goalID, "trigger", why)
		e.countNoop(ctx, goalID, openStepsEmpty)
	}
}

// countNoop tracks consecutive unproductive rounds; when no steps are open
// past the configured limit the goal is auto-stopped so a looping model
// cannot burn budget forever. One last chance first: if NoopRescue is wired
// and has not fired for this goal, it may fetch a hint (at the edge the
// agent has demonstrably run out of its own ideas) and buy a guided round.
func (e *Engine) countNoop(ctx context.Context, goalID string, openStepsEmpty bool) {
	if !openStepsEmpty {
		return // waiting on in-flight steps is normal, not a no-op streak
	}
	e.mu.Lock()
	e.noop[goalID]++
	n := e.noop[goalID]
	alreadyRescued := e.rescued[goalID]
	e.mu.Unlock()
	if n >= e.cfg.Runtime.DecideNoopLimit {
		if e.NoopRescue != nil && !alreadyRescued {
			e.mu.Lock()
			e.rescued[goalID] = true
			e.mu.Unlock()
			if hint, ok := e.NoopRescue(ctx, goalID); ok && strings.TrimSpace(hint) != "" {
				if _, err := e.store.AddHint(ctx, goalID, hint, fgs.ActorEngine); err != nil {
					e.log.Error("decide: noop rescue hint write failed", "goal", goalID, "err", err)
				} else {
					e.resetNoop(goalID)
					e.log.Warn("decide: noop guard rescued by hint", "goal", goalID, "rounds", n)
					return
				}
			}
		}
		if err := e.store.SetGoalStatus(context.Background(), goalID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
			e.log.Error("decide: noop guard stop failed", "goal", goalID, "err", err)
			return
		}
		if e.cfg.Runtime.RunDeadline > 0 {
			// Idealess goals also earn a second pass: with a fresh attack
			// surface instruction and the on-disk ledger they sometimes crack.
			if g, err := e.store.GetGoal(ctx, goalID); err == nil {
				e.requeuePass2(ctx, g)
			}
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

// repairJSON salvages a contract miss (final text with no parseable JSON
// object, or a JSON object violating the schema) with ONE cheap follow-up
// on the same runner. The runner process still holds the conversation —
// the work the agent did is not lost — so re-asking for the report costs a
// single round-trip instead of a full step re-execution with all its tool
// calls. Returns nil when the repair fails too; the caller then falls
// back to the ordinary failure path.
func (e *Engine) repairJSON(ctx context.Context, runner Runner, problem string) map[string]any {
	rctx, cancel := context.WithTimeout(ctx, e.cfg.Runtime.RepairTimeout.D())
	defer cancel()
	res, err := runner.Prompt(rctx,
		"Your previous reply "+problem+". Reply now with ONLY the raw JSON object required by the task contract — same schema, filled in from the work you already did in this conversation. No prose, no markdown fences, no tool calls.")
	if err != nil {
		return nil
	}
	payload, _ := contract.ExtractJSONObject(res.Text)
	return payload
}

func preview(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}
