package engine

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"zhulongx/internal/contract"
	"zhulongx/internal/pi"
	"zhulongx/internal/prompt"
	"zhulongx/internal/store"
)

// executeStep pushes one claimed step through the agent loop
// Outcome handling:
//
//   - valid payload  → FinishStepWithFinding (Step done, Finding open)
//   - timeout/crash/protocol garbage → FailStep(retryable)
//   - permission-denied patterns     → FailStep(permanent)
//   - invalid JSON / invalid payload → FailStep(retryable) — the model may
//     produce a valid report on the next attempt
//
// The step's claim is heartbeat-refreshed for as long as we run; if the
// heartbeat is lost (goal stopped / restart raced us), we abort.
func (e *Engine) executeStep(ctx context.Context, goalID, stepID string) {
	log := e.log.With("goal", goalID, "step", stepID)

	graph, err := e.store.LoadGraph(ctx, goalID)
	if err != nil {
		log.Error("execute: load graph", "err", err)
		return
	}
	p := prompt.RenderExecute(graph, stepID)

	// heartbeat lease: refreshed every tick until the run ends
	hbCtx, hbCancel := context.WithCancel(ctx)
	defer hbCancel()
	hbDone := make(chan struct{})
	go func() {
		defer close(hbDone)
		t := time.NewTicker(e.cfg.Runtime.TickInterval.D())
		defer t.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-t.C:
				if err := e.store.HeartbeatStep(hbCtx, goalID, stepID, "zhulongx"); err != nil {
					if errors.Is(err, store.ErrClaimLost) {
						log.Warn("execute: claim lost, aborting", "err", err)
						hbCancel() // signal the prompt below via shared ctx tree
						return
					}
				}
			}
		}
	}()

	runner, err := e.launchRunner()
	if err != nil {
		log.Error("execute: launch runner", "err", err)
		hbCancel()
		<-hbDone
		fctx, fcancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer fcancel()
		if isRunnerCapacityError(err) {
			// Host process/memory exhaustion is infrastructure, not a failed
			// challenge step. Return the claim without consuming an attempt;
			// the breaker below pauses new claims while capacity recovers.
			e.noteRunnerFailure("execute:capacity")
			if uerr := e.store.UnclaimStep(fctx, goalID, stepID, "zhulongx", "runner capacity unavailable — deferred at zero cost: "+err.Error()); uerr != nil && !errors.Is(uerr, store.ErrClaimLost) {
				log.Error("execute: capacity defer failed", "err", uerr)
			}
			return
		}
		// Launch failures are transient infra (spawn crash / dead gateway):
		// retryable, with the runner breaker — not the attempt policy — as
		// the guard against a dead runtime churning through attempts.
		e.noteRunnerFailure("execute:launch")
		e.failStep(fctx, goalID, stepID, err.Error(), true)
		return
	}
	defer func() {
		hbCancel()
		<-hbDone
		runner.Close()
	}()

	// A step must not outlive its goal's wall budget. goalOverBudget only
	// fires between steps (it never races an in-flight step's finish write),
	// so an uncapped mega-step overruns the budget freely while pinning a
	// container slot: with ExecuteTimeout 90m > GoalWallBudget 45m, run 42176
	// saw three goals hold slots 93–110 min. Cap the step at the wall budget
	// still remaining (+2m grace for terminal writes). wallBudgetFor picks
	// the endgame-deepened budget when the harvest window is open.
	timeout := e.cfg.Runtime.ExecuteTimeout.D()
	stepTitle := ""
	if g, gerr := e.store.GetGoal(ctx, goalID); gerr == nil {
		stepTitle = g.Title
	}
	if wb := e.wallBudgetFor(stepTitle); wb > 0 {
		e.mu.Lock()
		first, ok := e.firstClaim[goalID]
		e.mu.Unlock()
		if ok {
			if capped := first.Add(wb).Sub(e.now()) + 2*time.Minute; capped < timeout {
				timeout = capped
			}
		}
	}
	if timeout < time.Minute {
		timeout = time.Minute
	}
	rctx, cancel := context.WithTimeout(hbCtx, timeout)
	defer cancel()
	res, err := runner.Prompt(rctx, p)

	// Terminal writes must survive engine shutdown / claim-loss: the run ctx
	// may already be cancelled by the time we get here
	// best_effort_release runs in the finally block regardless).
	dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dcancel()

	if err != nil {
		// Deadline/stall salvage: the adapter returns the agent's streamed
		// text together with ErrTimeout or ErrTurnStall. A report that
		// landed just before the silence finishes the step normally;
		// anything else becomes a TIMEOUT_PARTIAL finding — the partial
		// work enters the graph, the step is DONE, and no attempt is burned
		// on a from-zero retry. A stalled turn is infra noise, not a model
		// failure: the ledger on disk carries the pass forward.
		if (errors.Is(err, pi.ErrTimeout) || errors.Is(err, pi.ErrTurnStall)) && res != nil {
			if payload, _ := contract.ExtractJSONObject(res.Text); payload != nil {
				if answer, verr := contract.ValidateExecute(payload); verr == nil {
					log.Info("execute: deadline hit after the report — salvaged")
					e.finishAnswer(dctx, log, goalID, stepID, answer, res)
					return
				}
			}
			e.finishPartial(dctx, log, goalID, stepID, res)
			return
		}
		retryable := true
		var msg string
		switch {
		case errors.Is(err, pi.ErrTimeout):
			msg = "timeout"
		case errors.Is(err, pi.ErrTurnStall):
			msg = "turn stalled (no agent events) — runner wedged"
		case errors.Is(err, pi.ErrPolicyViolation):
			// the agent crossed the tool boundary: retrying the same step
			// with the same policy would just abort again
			msg = err.Error()
			retryable = false
		case errors.Is(err, pi.ErrCommandLoop):
			// Replaying an exact command loop would recreate the same dead end
			// and pin the challenge container, so let Decide choose another path.
			msg = err.Error()
			retryable = false
		case errors.Is(err, pi.ErrProcessExit):
			msg = "agent process exited: " + err.Error()
		case errors.Is(err, pi.ErrProtocol):
			msg = "agent protocol error: " + err.Error()
		case errors.Is(err, context.Canceled):
			// heartbeat loss or engine shutdown — release for retry
			msg = "cancelled (claim lost or engine shutdown)"
		default:
			msg = err.Error()
		}
		if classifyPermanent(msg) {
			retryable = false
		}
		if errors.Is(err, pi.ErrProcessExit) || errors.Is(err, pi.ErrProtocol) {
			e.noteRunnerFailure("execute") // infra sick, not model slow
		}
		log.Error("execute: runner failed", "err", msg, "retryable", retryable)
		e.failStep(dctx, goalID, stepID, msg, retryable)
		return
	}

	payload, _ := contract.ExtractJSONObject(res.Text)
	if payload == nil {
		log.Warn("execute: no JSON in output — one repair round", "preview", preview(res.Text))
		payload = e.repairJSON(hbCtx, runner, "contained no parseable JSON object")
		if payload == nil {
			log.Error("execute: no JSON in output", "preview", preview(res.Text))
			e.failStep(dctx, goalID, stepID, "output contained no JSON object", true)
			return
		}
		log.Info("execute: repair round salvaged the report")
	}
	answer, err := contract.ValidateExecute(payload)
	if err != nil {
		log.Warn("execute: invalid payload — one repair round", "err", err)
		if fixed := e.repairJSON(hbCtx, runner, "did not validate ("+err.Error()+")"); fixed != nil {
			if a2, err2 := contract.ValidateExecute(fixed); err2 == nil {
				answer, err = a2, nil
				log.Info("execute: repair round salvaged the report")
			}
		}
		if err != nil {
			log.Error("execute: invalid payload", "err", err, "preview", preview(res.Text))
			e.failStep(dctx, goalID, stepID, "invalid payload: "+err.Error(), !classifyPermanent(err.Error()))
			return
		}
	}

	e.finishAnswer(dctx, log, goalID, stepID, answer, res)
}

// isRunnerCapacityError identifies local process/memory exhaustion. These
// failures are retryable without charging the challenge step; executable-not-
// found and protocol errors retain the normal failure path.
func isRunnerCapacityError(err error) bool {
	m := strings.ToLower(err.Error())
	for _, marker := range []string{
		"paging file is too small",
		"cannot allocate memory",
		"out of memory",
		"resource temporarily unavailable",
		"errno=12",
		"eagain",
		"enomem",
	} {
		if strings.Contains(m, marker) {
			return true
		}
	}
	return false
}

// finishAnswer is the shared tail of both execute paths (live report and
// deadline-salvaged report): WAITING_SLOT deferral, evidence fallback, and
// the finding write.
func (e *Engine) finishAnswer(ctx context.Context, log *slog.Logger, goalID, stepID string, answer *contract.ExecuteAnswer, res *pi.PromptResult) {
	// A WAITING_SLOT report is scheduling state, not work output: return
	// the step to pending at zero attempt cost — no finding, no Decide
	// round, no re-declared steps. The gate re-admits the goal when a
	// container slot actually frees (run 41925: d-02 burned model rounds
	// narrating waits and never re-entered).
	if strings.HasPrefix(strings.TrimSpace(answer.Content), "WAITING_SLOT:") {
		if err := e.store.UnclaimStep(ctx, goalID, stepID, "zhulongx", "waiting for container slot"); err != nil {
			if !errors.Is(err, store.ErrClaimLost) {
				e.log.Error("execute: unclaim write failed", "err", err)
				e.failStep(ctx, goalID, stepID, "unclaim failed: "+err.Error(), true)
			}
			return
		}
		e.log.Info("execute: step deferred — no slot yet", "goal", goalID, "step", stepID)
		e.noteRunnerSuccess()
		return
	}

	evidence := answer.Evidence
	if evidence == "" && len(res.Events) > 0 {
		evidence = "events: " + strings.Join(res.Events[:min(8, len(res.Events))], " ⏎ ")
	}
	fd, err := e.store.FinishStepWithFinding(ctx, goalID, stepID, "zhulongx", answer.Content, evidence)
	if err != nil {
		if errors.Is(err, store.ErrClaimLost) {
			log.Warn("execute: claim lost at finish", "err", err)
			return
		}
		log.Error("execute: finish write failed", "err", err)
		e.failStep(ctx, goalID, stepID, "finish failed: "+err.Error(), true)
		return
	}
	e.noteStepFinish(goalID)
	e.markTitleWorked(ctx, goalID)
	e.harvestFlags(ctx, goalID, answer.Content)
	log.Info("execute: step done", "finding", fd.ID, "tools", res.ToolCalls)
	e.noteRunnerSuccess()
	// Zero-foothold rotation (run 42984): the wall doctrine lives in the
	// prompt, but an agent-side wall only churned containers — the goal
	// stayed active and the next step relaunched the SAME title seconds
	// later, pinning all three slots on head-of-queue grinders for a full
	// wall budget while zero new titles flowed (32 minutes, 4 titles seen,
	// t+16.8 onward nothing new). The marker makes the wall real: the
	// engine stops the pass, the slot rotates to an untouched title, and
	// the challenge requeues into the fairness tail with its ledger.
	if strings.HasPrefix(strings.TrimSpace(answer.Content), "NOFOOTHOLD:") {
		e.stopGoalForBudget(ctx, goalID, "zero-foothold wall: step reported NOFOOTHOLD — rotating slot")
	}
}

// finishPartial converts a deadline-killed run into a TIMEOUT_PARTIAL
// finding: the agent demonstrably worked (its streamed tail and event trace
// enter the graph for the next Decide round to build on), so the step is
// DONE — no attempt is burned on a from-zero retry.
func (e *Engine) finishPartial(ctx context.Context, log *slog.Logger, goalID, stepID string, res *pi.PromptResult) {
	r := []rune(strings.TrimSpace(res.Text))
	if len(r) > 400 {
		r = r[len(r)-400:] // keep the tail — the most recent reasoning
	}
	evidence := ""
	if len(res.Events) > 0 {
		evidence = "events: " + strings.Join(res.Events[:min(8, len(res.Events))], " ⏎ ")
	}
	fd, err := e.store.FinishStepWithFinding(ctx, goalID, stepID, "zhulongx", "TIMEOUT_PARTIAL: "+string(r), evidence)
	if err != nil {
		if !errors.Is(err, store.ErrClaimLost) {
			log.Error("execute: partial write failed", "err", err)
		}
		return
	}
	// No noteStepFinish here, deliberately: a deadline-killed step lands
	// seconds before the wall by construction, so counting it as "the goal
	// is mid-flow" would arm the active grace on EVERY budget-stopped goal
	// (run 42407: three flagless goals each burned the +10m grace this way).
	// The pass still counts as WORKED though — real streamed attack output
	// entered the graph, so it must not be refunded as a sterile pass.
	e.mu.Lock()
	e.passWorked[goalID] = true
	e.mu.Unlock()
	e.markTitleWorked(ctx, goalID)
	e.harvestFlags(ctx, goalID, res.Text) // the kill can land mid-report, flag and all
	log.Info("execute: step done with partial finding (deadline salvage)", "finding", fd.ID, "tools", res.ToolCalls)
	e.noteRunnerSuccess()
}

// noteStepFinish records when a step last landed NATURALLY (the agent chose
// to wrap up and report), feeding the wall-budget active grace: a goal whose
// steps keep landing on their own is mid-flow, not wedged. It also marks the
// pass as worked — a real report landed, so the goal's requeue fuse slot was
// honestly spent (see refundSterilePass).
func (e *Engine) noteStepFinish(goalID string) {
	e.mu.Lock()
	e.lastFinish[goalID] = e.now()
	e.passWorked[goalID] = true
	e.mu.Unlock()
}

// markTitleWorked flips the first-touch fairness signal for the goal's title.
// "Touched" means a step finished with real output — an attack attempt, not a
// slot race. Run 46196: e3-02's only claimed step in its whole life was a
// 27-second 409 → WAITING_SLOT deferral; with the claim-time mark that title
// read "worked" forever, lost the untouched-first sort AND the endgame
// never-touched rank, and never saw a container while five already-failed
// titles got second helpings. The mark lives at the two real-finish tails
// (natural report and deadline salvage) so deferrals stay free.
func (e *Engine) markTitleWorked(ctx context.Context, goalID string) {
	if g, err := e.store.GetGoal(ctx, goalID); err == nil {
		e.mu.Lock()
		e.firstTouch[g.Title] = true
		e.mu.Unlock()
	}
}

// failStep records the failure and the retry decision.
func (e *Engine) failStep(ctx context.Context, goalID, stepID, msg string, retryable bool) {
	// Outage freeze: while the runtime is under a declared outage the
	// failure is infrastructure, not the step's — return it to pending at
	// zero attempt cost instead of burning StepMaxAttempts against a dead
	// gateway (run 43263: every remaining attempt in the fleet evaporated
	// into a dead model path).
	if e.runtimeDead() {
		if err := e.store.UnclaimStep(ctx, goalID, stepID, "zhulongx", "runtime outage — deferred at zero cost: "+msg); err != nil && !errors.Is(err, store.ErrClaimLost) {
			e.log.Error("execute: outage defer write failed", "goal", goalID, "step", stepID, "err", err)
		}
		return
	}
	target, err := e.store.FailStep(ctx, goalID, stepID, "zhulongx", msg, retryable, e.cfg.Runtime.StepMaxAttempts)
	if err != nil {
		if errors.Is(err, store.ErrClaimLost) {
			return // someone else owns the claim now
		}
		e.log.Error("execute: fail write error", "goal", goalID, "step", stepID, "err", err)
		return
	}
	if target == "pending" {
		e.log.Warn("execute: step scheduled for retry", "goal", goalID, "step", stepID, "error", preview(msg))
	}
}

// classifyPermanent decides whether an error can never succeed on retry.
// Permission/refusal errors are permanent; everything else (timeouts,
// crashes, protocol noise, malformed output) gets another chance.
func classifyPermanent(msg string) bool {
	m := strings.ToLower(msg)
	for _, pat := range []string{
		"permission denied",
		"access denied",
		"eacces",
		"eperm",
		"unauthorized",
		"quota exceeded",
	} {
		if strings.Contains(m, pat) {
			return true
		}
	}
	return false
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
