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
