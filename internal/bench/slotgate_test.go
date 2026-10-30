package bench

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"zhulongx/internal/fgs"
	"zhulongx/internal/store"
)

type gateFixture struct {
	gate       *SlotGate
	st         *store.Store
	closed     []string
	now        time.Time
	challenges []Challenge
}

func newFixture(t *testing.T, maxSlots int) *gateFixture {
	t.Helper()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f := &gateFixture{st: st, now: time.Date(2026, 10, 27, 15, 0, 0, 0, time.UTC)}
	g := NewSlotGate(st, nil, maxSlots, slog.New(slog.NewTextHandler(io.Discard, nil)))
	g.now = func() time.Time { return f.now }
	g.listOnce = func(context.Context) ([]Challenge, error) {
		out := make([]Challenge, len(f.challenges))
		copy(out, f.challenges)
		return out, nil
	}
	g.closeCode = func(_ context.Context, code string) error {
		f.closed = append(f.closed, code)
		return nil
	}
	f.gate = g
	return f
}

func (f *gateFixture) goal(t *testing.T, code string, status fgs.GoalStatus) string {
	t.Helper()
	g, err := f.st.CreateGoal(context.Background(), goalTitle(code), "o", "obj")
	if err != nil {
		t.Fatal(err)
	}
	if status != fgs.GoalActive {
		if err := f.st.SetGoalStatus(context.Background(), g.ID, fgs.GoalStatus(status), fgs.ActorEngine); err != nil {
			t.Fatal(err)
		}
	}
	return g.ID
}

func TestSlotGateAdmitsWithinBudget(t *testing.T) {
	f := newFixture(t, 1)
	a := f.goal(t, "a-01", fgs.GoalActive)
	b := f.goal(t, "a-02", fgs.GoalActive)

	if !f.gate.Allow(context.Background(), a) {
		t.Fatal("first goal must be admitted into an empty task")
	}
	if f.gate.Allow(context.Background(), b) {
		t.Fatal("second goal must be blocked while the reservation holds the only slot")
	}
}

func TestSlotGateRunningContainerOwnsSlot(t *testing.T) {
	f := newFixture(t, 1)
	f.challenges = []Challenge{{UniqueCode: "a-01", ContainerStatus: "available"}}
	a := f.goal(t, "a-01", fgs.GoalActive)
	b := f.goal(t, "a-02", fgs.GoalActive)

	if !f.gate.Allow(context.Background(), a) {
		t.Fatal("owner of the running container must be admitted")
	}
	if f.gate.Allow(context.Background(), b) {
		t.Fatal("a running container must occupy the slot")
	}
}

func TestSlotGateReservationExpires(t *testing.T) {
	f := newFixture(t, 1)
	a := f.goal(t, "a-01", fgs.GoalActive)
	b := f.goal(t, "a-02", fgs.GoalActive)

	if !f.gate.Allow(context.Background(), a) {
		t.Fatal("first goal must be admitted")
	}
	// The admission never materialized into a container (the step crashed
	// before start): after the reservation TTL the slot frees for others.
	f.now = f.now.Add(5 * time.Minute)
	if !f.gate.Allow(context.Background(), b) {
		t.Fatal("expired reservation must release the slot")
	}
}

func TestSlotGateCompletedChallengeAlwaysAdmitted(t *testing.T) {
	f := newFixture(t, 1)
	f.challenges = []Challenge{
		{UniqueCode: "a-01", ContainerStatus: "available"},
		{UniqueCode: "a-02", IsCompleted: true, ContainerStatus: "stopped"},
	}
	b := f.goal(t, "a-02", fgs.GoalActive)

	if !f.gate.Allow(context.Background(), b) {
		t.Fatal("a platform-completed challenge needs no slot: its steps are cheap confirmations")
	}
}

func TestSlotGateReapsTerminalGoalContainer(t *testing.T) {
	f := newFixture(t, 1)
	f.challenges = []Challenge{{UniqueCode: "a-01", ContainerStatus: "available"}}
	f.goal(t, "a-01", fgs.GoalStopped)
	b := f.goal(t, "a-02", fgs.GoalActive)

	ctx := context.Background()
	if f.gate.Allow(ctx, b) {
		t.Fatal("the leaked container still occupies the slot on this call")
	}
	if len(f.closed) != 1 || f.closed[0] != "a-01" {
		t.Fatalf("terminal goal's container must be reaped: %v", f.closed)
	}
	if !f.gate.Allow(ctx, b) {
		t.Fatal("after the reap the slot must be free")
	}
}

func TestSlotGateForceReleaseBypassesTerminalScan(t *testing.T) {
	// A stopped goal whose pass-2 requeue keeps the title non-terminal is
	// invisible to the reaper; ForceRelease must free the slot anyway —
	// and skip challenges the platform already credits (no container needed).
	f := newFixture(t, 2)
	f.challenges = []Challenge{
		{UniqueCode: "a-01", ContainerStatus: "available"},
		{UniqueCode: "a-02", IsCompleted: true, ContainerStatus: "available"},
	}
	f.goal(t, "a-01", fgs.GoalStopped)
	f.goal(t, "a-01", fgs.GoalActive) // pass-2 successor: title is live
	b := f.goal(t, "a-02", fgs.GoalActive)
	c := f.goal(t, "a-03", fgs.GoalActive)

	ctx := context.Background()
	if !f.gate.Allow(ctx, b) {
		t.Fatal("completed challenge needs no slot")
	}
	if f.gate.Allow(ctx, c) {
		t.Fatal("two running containers saturate the task")
	}
	if len(f.closed) != 0 {
		t.Fatalf("a title with a live successor must not be reaped: %v", f.closed)
	}
	f.gate.ForceRelease(ctx, "a-01")
	if len(f.closed) != 1 || f.closed[0] != "a-01" {
		t.Fatalf("force release must close the stopped goal's container: %v", f.closed)
	}
	f.gate.ForceRelease(ctx, "a-02") // completed → no close
	if len(f.closed) != 1 {
		t.Fatalf("completed challenges need no container: %v", f.closed)
	}
	if !f.gate.Allow(ctx, c) {
		t.Fatal("after force release the slot must be free")
	}
}

func TestSlotGatePermissiveBeforeFirstPoll(t *testing.T) {
	f := newFixture(t, 1)
	f.gate.listOnce = func(context.Context) ([]Challenge, error) {
		return nil, io.ErrUnexpectedEOF
	}
	a := f.goal(t, "a-01", fgs.GoalActive)
	if !f.gate.Allow(context.Background(), a) {
		t.Fatal("before the first successful poll the gate must stay permissive")
	}
}
