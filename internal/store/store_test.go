package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"zhulongx/internal/fgs"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := OpenMemory()
	if err != nil {
		t.Fatalf("open memory store: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func mustGoal(t *testing.T, s *Store) *fgs.Goal {
	t.Helper()
	g, err := s.CreateGoal(context.Background(), "pen-test report", "assess example.com", "produce verified findings report")
	if err != nil {
		t.Fatalf("create goal: %v", err)
	}
	return g
}

func TestGoalLifecycle(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	g := mustGoal(t, s)

	if g.Status != fgs.GoalActive {
		t.Fatalf("new goal status = %s, want active", g.Status)
	}
	// complete requires existing source facts
	if err := s.CompleteGoal(ctx, g.ID, []string{"f_9999"}, "nope", fgs.ActorDecide); !errors.Is(err, ErrFactNotFound) {
		t.Fatalf("complete with missing fact: got %v, want ErrFactNotFound", err)
	}
	if err := s.SetGoalStatus(ctx, g.ID, fgs.GoalCompleted, fgs.ActorHuman); !errors.Is(err, ErrIllegalTrans) {
		t.Fatalf("stop→completed directly should be illegal, got %v", err)
	}
	if err := s.SetGoalStatus(ctx, g.ID, fgs.GoalStopped, fgs.ActorHuman); err != nil {
		t.Fatalf("stop: %v", err)
	}
	// stopped goal rejects step creation
	if _, err := s.CreateStep(ctx, g.ID, "s", nil, fgs.ActorDecide); !errors.Is(err, ErrGoalNotActive) {
		t.Fatalf("create step on stopped goal: got %v, want ErrGoalNotActive", err)
	}
	if err := s.SetGoalStatus(ctx, g.ID, fgs.GoalActive, fgs.ActorHuman); err != nil {
		t.Fatalf("resume: %v", err)
	}
	// complete then reopen with feedback fact
	if _, err := s.AddHumanFact(ctx, g.ID, "scope confirmed", "tester"); err != nil {
		t.Fatalf("add fact: %v", err)
	}
	if err := s.CompleteGoal(ctx, g.ID, []string{"f_0001"}, "objective met", fgs.ActorDecide); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if err := s.ReopenGoal(ctx, g.ID, "new requirement arrived", "tester"); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got, _ := s.GetGoal(ctx, g.ID)
	if got.Status != fgs.GoalActive || got.CompletedAt != nil {
		t.Fatalf("after reopen: %+v", got)
	}
}

func TestStepClaimCAS(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	g := mustGoal(t, s)
	st, err := s.CreateStep(ctx, g.ID, "recon dns", nil, fgs.ActorDecide)
	if err != nil {
		t.Fatalf("create step: %v", err)
	}
	// second step to prove oldest-first ordering
	if _, err := s.CreateStep(ctx, g.ID, "port scan", nil, fgs.ActorDecide); err != nil {
		t.Fatal(err)
	}
	a, err := s.ClaimNextStep(ctx, g.ID, "engine-1")
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if a.ID != st.ID {
		t.Fatalf("claimed %s, want oldest %s", a.ID, st.ID)
	}
	if a.Attempts != 1 {
		t.Fatalf("attempts after first claim = %d, want 1", a.Attempts)
	}
	// CAS: only the claimer may finish
	if _, err := s.FinishStepWithFinding(ctx, g.ID, st.ID, "engine-2", "result", "ev"); !errors.Is(err, ErrClaimLost) {
		t.Fatalf("finish by stranger: got %v, want ErrClaimLost", err)
	}
	// heartbeat by stranger must fail
	if err := s.HeartbeatStep(ctx, g.ID, st.ID, "engine-2"); !errors.Is(err, ErrClaimLost) {
		t.Fatalf("heartbeat by stranger: got %v, want ErrClaimLost", err)
	}
	if err := s.HeartbeatStep(ctx, g.ID, st.ID, "engine-1"); err != nil {
		t.Fatalf("heartbeat by owner: %v", err)
	}
	fd, err := s.FinishStepWithFinding(ctx, g.ID, st.ID, "engine-1", "dns resolves to 1.2.3.4", "session abc")
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	if fd.Status != fgs.FindingOpen {
		t.Fatalf("finding status = %s, want open", fd.Status)
	}
	steps, _ := s.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepDone || steps[0].FindingID != fd.ID {
		t.Fatalf("step after finish: %+v", steps[0])
	}
}

func TestStepDepsValidation(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	g := mustGoal(t, s)
	if _, err := s.CreateStep(ctx, g.ID, "s", []string{"f_0001"}, fgs.ActorDecide); !errors.Is(err, ErrFactNotFound) {
		t.Fatalf("dep on missing fact: got %v, want ErrFactNotFound", err)
	}
}

func TestFailStepRetryAndExhaustion(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	g := mustGoal(t, s)
	st, _ := s.CreateStep(ctx, g.ID, "fuzz", nil, fgs.ActorDecide)
	claimed, _ := s.ClaimNextStep(ctx, g.ID, "engine-1")
	if claimed.ID != st.ID {
		t.Fatal("claim mismatch")
	}
	// retryable: back to pending (attempt 1 of 3)
	target, err := s.FailStep(ctx, g.ID, st.ID, "engine-1", "rpc timeout", true, 3)
	if err != nil || target != fgs.StepPending {
		t.Fatalf("retryable fail: target=%s err=%v", target, err)
	}
	// attempt 2
	c2, _ := s.ClaimNextStep(ctx, g.ID, "engine-1")
	if c2.Attempts != 2 {
		t.Fatalf("attempts = %d, want 2", c2.Attempts)
	}
	target, _ = s.FailStep(ctx, g.ID, st.ID, "engine-1", "rpc timeout again", true, 3)
	if target != fgs.StepPending {
		t.Fatalf("second retryable fail: %s", target)
	}
	// attempt 3 — exhausted
	s.ClaimNextStep(ctx, g.ID, "engine-1")
	target, err = s.FailStep(ctx, g.ID, st.ID, "engine-1", "rpc timeout third", true, 3)
	if err != nil || target != fgs.StepFailed {
		t.Fatalf("exhausted: target=%s err=%v", target, err)
	}
	// permanent error fails immediately without consuming retries
	st2, _ := s.CreateStep(ctx, g.ID, "another", nil, fgs.ActorDecide)
	s.ClaimNextStep(ctx, g.ID, "engine-1")
	target, err = s.FailStep(ctx, g.ID, st2.ID, "engine-1", "permission denied: workspace", false, 3)
	if err != nil || target != fgs.StepFailed {
		t.Fatalf("permanent fail: target=%s err=%v", target, err)
	}
}

func TestHeartbeatReclaim(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	g := mustGoal(t, s)
	st, _ := s.CreateStep(ctx, g.ID, "x", nil, fgs.ActorDecide)
	claimed, _ := s.ClaimNextStep(ctx, g.ID, "engine-1")
	if claimed.ID != st.ID {
		t.Fatal("claim mismatch")
	}
	// heartbeat older than ttl → reclaimed to pending.
	// The stale timestamp is injected directly because Windows wall-clock
	// quanta (~0.5ms) make "just claim, then compare at ttl=1ns" flaky.
	stale := time.Now().UTC().Add(-2 * time.Hour).Format(time.RFC3339Nano)
	if _, err := s.db.Exec(`UPDATE steps SET heartbeat_at = ? WHERE goal_id = ?`, stale, g.ID); err != nil {
		t.Fatal(err)
	}
	n, err := s.ReclaimStaleSteps(ctx, time.Hour, "startup recovery")
	if err != nil || n != 1 {
		t.Fatalf("reclaim: n=%d err=%v", n, err)
	}
	steps, _ := s.ListSteps(ctx, g.ID)
	if steps[0].Status != fgs.StepPending || steps[0].ClaimedBy != "" {
		t.Fatalf("after reclaim: %+v", steps[0])
	}
	// fresh heartbeat survives
	s.ClaimNextStep(ctx, g.ID, "engine-1")
	s.HeartbeatStep(ctx, g.ID, st.ID, "engine-1")
	n, err = s.ReclaimStaleSteps(ctx, time.Hour, "startup recovery")
	if err != nil || n != 0 {
		t.Fatalf("fresh heartbeat reclaimed: n=%d err=%v", n, err)
	}
}

func TestFindingReviewPromotesAndDiscards(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	g := mustGoal(t, s)
	st, _ := s.CreateStep(ctx, g.ID, "x", nil, fgs.ActorDecide)
	s.ClaimNextStep(ctx, g.ID, "engine-1")
	fd1, _ := s.FinishStepWithFinding(ctx, g.ID, st.ID, "engine-1", "finding one", "ev1")

	st2, _ := s.CreateStep(ctx, g.ID, "y", nil, fgs.ActorDecide)
	s.ClaimNextStep(ctx, g.ID, "engine-1")
	fd2, _ := s.FinishStepWithFinding(ctx, g.ID, st2.ID, "engine-1", "finding two", "ev2")

	// promote one, discard the other
	facts, err := s.ReviewFindings(ctx, g.ID, []string{fd1.ID}, []string{fd2.ID}, fgs.ActorDecide)
	if err != nil {
		t.Fatalf("review: %v", err)
	}
	if len(facts) != 1 || facts[0].Content != "finding one" {
		t.Fatalf("promoted facts: %+v", facts)
	}
	if facts[0].Source != "decide:promote:"+fd1.ID {
		t.Fatalf("fact source chain: %s", facts[0].Source)
	}
	// double promote rejected
	if _, err := s.ReviewFindings(ctx, g.ID, []string{fd1.ID}, nil, fgs.ActorDecide); !errors.Is(err, ErrFindingNotOpen) {
		t.Fatalf("re-promote: got %v, want ErrFindingNotOpen", err)
	}
	// promoted finding links to fact
	fds, _ := s.ListFindings(ctx, g.ID, false)
	if len(fds) != 2 || fds[0].Status != fgs.FindingPromoted || fds[0].FactID == "" {
		t.Fatalf("findings after review: %+v", fds)
	}
	// steps can now depend on the promoted fact
	if _, err := s.CreateStep(ctx, g.ID, "z", []string{facts[0].ID}, fgs.ActorDecide); err != nil {
		t.Fatalf("dep on promoted fact: %v", err)
	}
}

func TestAuditTrail(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	g := mustGoal(t, s)
	s.CreateStep(ctx, g.ID, "x", nil, fgs.ActorDecide)
	s.ClaimNextStep(ctx, g.ID, "engine-1")
	entries, err := s.ListAudit(ctx, g.ID, 50)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	// expect at least: goal.created, step.created, step.claimed — newest first
	var sawGoal, sawStep, sawClaim bool
	for _, e := range entries {
		switch e.Action {
		case "goal.created":
			sawGoal = true
		case "step.created":
			sawStep = true
		case "step.claimed":
			sawClaim = true
		}
	}
	if !sawGoal || !sawStep || !sawClaim {
		t.Fatalf("audit missing entries: goal=%v step=%v claim=%v", sawGoal, sawStep, sawClaim)
	}
}

func TestSnapshotCounts(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	g := mustGoal(t, s)
	sc, err := s.Snapshot(ctx, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	if sc.Facts != 0 || sc.OpenSteps != 0 {
		t.Fatalf("initial snapshot: %+v", sc)
	}
	s.CreateStep(ctx, g.ID, "x", nil, fgs.ActorDecide)
	sc, _ = s.Snapshot(ctx, g.ID)
	if sc.OpenSteps != 1 {
		t.Fatalf("after step: %+v", sc)
	}
}

func TestExportYAML(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	g := mustGoal(t, s)
	st, _ := s.CreateStep(ctx, g.ID, "recon", nil, fgs.ActorDecide)
	s.ClaimNextStep(ctx, g.ID, "engine-1")
	fd, _ := s.FinishStepWithFinding(ctx, g.ID, st.ID, "engine-1", "found c=42", "ev")
	s.ReviewFindings(ctx, g.ID, []string{fd.ID}, nil, fgs.ActorDecide)
	out, err := s.ExportYAML(ctx, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"objective:", "steps:", "findings:", "facts:", "found c=42"} {
		if !strings.Contains(out, want) {
			t.Fatalf("export missing %q:\n%s", want, out)
		}
	}
	_ = g
}
