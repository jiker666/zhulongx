package engine

import (
	"context"
	"errors"
	"strings"
	"time"

	"zhulongx/internal/contract"
	"zhulongx/internal/pi"
	"zhulongx/internal/prompt"
	"zhulongx/internal/store"
)

// executeStep pushes one claimed step through the agent loop
// (Cairn: run_explore_task). Outcome handling:
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
		e.failStep(fctx, goalID, stepID, err.Error(), false)
		return
	}
	defer func() {
		hbCancel()
		<-hbDone
		runner.Close()
	}()

	rctx, cancel := context.WithTimeout(hbCtx, e.cfg.Runtime.ExecuteTimeout.D())
	defer cancel()
	res, err := runner.Prompt(rctx, p)

	// Terminal writes must survive engine shutdown / claim-loss: the run ctx
	// may already be cancelled by the time we get here (Cairn parallel:
	// best_effort_release runs in the finally block regardless).
	dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dcancel()

	if err != nil {
		retryable := true
		var msg string
		switch {
		case errors.Is(err, pi.ErrTimeout):
			msg = "timeout"
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
		log.Error("execute: runner failed", "err", msg, "retryable", retryable)
		e.failStep(dctx, goalID, stepID, msg, retryable)
		return
	}

	payload, err := contract.ExtractJSONObject(res.Text)
	if err != nil {
		log.Error("execute: no JSON in output", "preview", preview(res.Text))
		e.failStep(dctx, goalID, stepID, "output contained no JSON object", true)
		return
	}
	answer, err := contract.ValidateExecute(payload)
	if err != nil {
		log.Error("execute: invalid payload", "err", err, "preview", preview(res.Text))
		e.failStep(dctx, goalID, stepID, "invalid payload: "+err.Error(), !classifyPermanent(err.Error()))
		return
	}

	evidence := answer.Evidence
	if evidence == "" && len(res.Events) > 0 {
		evidence = "events: " + strings.Join(res.Events[:min(8, len(res.Events))], " ⏎ ")
	}
	fd, err := e.store.FinishStepWithFinding(dctx, goalID, stepID, "zhulongx", answer.Content, evidence)
	if err != nil {
		if errors.Is(err, store.ErrClaimLost) {
			log.Warn("execute: claim lost at finish", "err", err)
			return
		}
		log.Error("execute: finish write failed", "err", err)
		e.failStep(dctx, goalID, stepID, "finish failed: "+err.Error(), true)
		return
	}
	log.Info("execute: step done", "finding", fd.ID, "tools", res.ToolCalls)
}

// failStep records the failure and the retry decision.
func (e *Engine) failStep(ctx context.Context, goalID, stepID, msg string, retryable bool) {
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
