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

func TestSlotGateSweepReapsIdleContainerOfQueuedPass2(t *testing.T) {
	// run 42361's leak class: the goal was budget-stopped, its pass-2
	// successor is active but queued behind hours of work, and the stop-time
	// release failed. The active successor must NOT keep the idle container
	// alive past the sweep TTL.
	f := newFixture(t, 1)
	f.challenges = []Challenge{{UniqueCode: "a-16", ContainerStatus: "available"}}
	f.goal(t, "a-16", fgs.GoalStopped)
	f.goal(t, "a-16", fgs.GoalActive) // queued pass-2 successor
	other := f.goal(t, "a-02", fgs.GoalActive)

	ctx := context.Background()
	if f.gate.Allow(ctx, other) {
		t.Fatal("the running container must still occupy the slot on first sight")
	}
	if len(f.closed) != 0 {
		t.Fatalf("first sight must start the idle clock, not reap: %v", f.closed)
	}
	f.now = f.now.Add(6 * time.Minute) // past sweepTTL, no work ever arrived
	if f.gate.Allow(ctx, other) {
		t.Fatal("the slot must still be occupied by the leaked container on this call")
	}
	if len(f.closed) != 1 || f.closed[0] != "a-16" {
		t.Fatalf("the idle container must be swept: %v", f.closed)
	}
	if !f.gate.Allow(ctx, other) {
		t.Fatal("after the sweep the slot must be free")
	}
}

func TestSlotGateSubmittable(t *testing.T) {
	f := newFixture(t, 1)
	f.challenges = []Challenge{
		{UniqueCode: "a-01", ContainerStatus: "running", FlagCount: 1},
		{UniqueCode: "a-02", ContainerStatus: "stopped", FlagCount: 1},
		{UniqueCode: "a-03", ContainerStatus: "running", FlagCount: 4, CorrectFlagCount: 4, IsCompleted: true},
	}
	a := f.goal(t, "a-01", fgs.GoalActive)
	f.gate.Allow(context.Background(), a) // forces the first poll
	if !f.gate.Submittable("a-01") {
		t.Fatal("a live container of an unfinished challenge is submittable")
	}
	if f.gate.Submittable("a-02") {
		t.Fatal("a closed container is never submittable — the platform re-judges against it and a banked value comes back wrong")
	}
	if f.gate.Submittable("a-03") {
		t.Fatal("a completed challenge needs no submission")
	}
	if f.gate.Submittable("zz-99") {
		t.Fatal("an unknown challenge is not submittable")
	}
}

func TestSlotGateProgressReportsFlagCounts(t *testing.T) {
	f := newFixture(t, 1)
	f.challenges = []Challenge{{UniqueCode: "b-01", ContainerStatus: "stopped", FlagCount: 4, CorrectFlagCount: 2}}
	a := f.goal(t, "a-01", fgs.GoalActive)

	f.gate.Allow(context.Background(), a) // forces the first poll
	cur, total, ok := f.gate.Progress("b-01")
	if !ok || cur != 2 || total != 4 {
		t.Fatalf("progress must come from the platform snapshot: cur=%d total=%d ok=%v", cur, total, ok)
	}
	if _, _, ok := f.gate.Progress("zz-99"); ok {
		t.Fatal("unknown codes must report ok=false")
	}
}

func TestSlotGateRefreshSeesCloseDespiteStaleCache(t *testing.T) {
	// Run 42778: c-08's banked value went out 7s after its container close
	// because Submittable read a snapshot from before the close. A forced
	// Refresh must observe the close even when pollTTL has not elapsed.
	f := newFixture(t, 1)
	f.challenges = []Challenge{{UniqueCode: "a-01", ContainerStatus: "running", FlagCount: 1}}
	a := f.goal(t, "a-01", fgs.GoalActive)
	f.gate.Allow(context.Background(), a) // first poll: running

	f.now = f.now.Add(2 * time.Second) // inside pollTTL: a plain poll would reuse the cache
	f.challenges = []Challenge{{UniqueCode: "a-01", ContainerStatus: "stopped", FlagCount: 1}}
	f.gate.Refresh(context.Background())
	if f.gate.Submittable("a-01") {
		t.Fatal("Refresh must bypass pollTTL and observe the close before a one-shot submit fires")
	}
}

func TestSlotGateOnSnapshotFiresAfterRefresh(t *testing.T) {
	f := newFixture(t, 1)
	f.challenges = []Challenge{{UniqueCode: "a-01", ContainerStatus: "running", FlagCount: 1}}
	a := f.goal(t, "a-01", fgs.GoalActive)

	fired := 0
	f.gate.OnSnapshot(func(context.Context) { fired++ })
	f.gate.Allow(context.Background(), a) // first poll
	if fired < 1 {
		t.Fatal("a successful refresh must fire the on-snapshot callback (fast-lane pending pump)")
	}
	before := fired
	f.now = f.now.Add(9 * time.Second) // past pollTTL
	f.gate.Allow(context.Background(), a)
	if fired <= before {
		t.Fatal("each stale-expired Allow must re-poll and re-fire the callback")
	}
}
