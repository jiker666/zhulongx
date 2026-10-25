package store

import (
	"context"
	"errors"
	"testing"

	"zhulongx/internal/fgs"
)

// One running step per goal: a second claim on the same goal must look
// like an empty queue (ErrNothingToClaim) so the engine moves on to
// another goal instead of double-booking this one.
func TestClaimNextStepOneRunningPerGoal(t *testing.T) {
	s := newTestStore(t)
	g := mustGoal(t, s)
	ctx := context.Background()
	if _, err := s.CreateStep(ctx, g.ID, "first", nil, fgs.ActorDecide); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateStep(ctx, g.ID, "second", nil, fgs.ActorDecide); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimNextStep(ctx, g.ID, "w1"); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if _, err := s.ClaimNextStep(ctx, g.ID, "w2"); !errors.Is(err, ErrNothingToClaim) {
		t.Fatalf("second claim: want ErrNothingToClaim, got %v", err)
	}
}
