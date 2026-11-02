package bench

import (
	"context"
	"fmt"
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
	failCloses int // when > 0, the next N close POSTs fail
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
		if f.failCloses > 0 {
			f.failCloses--
			f.closed = append(f.closed, code+"!ERR")
			return fmt.Errorf("transient 5xx")
		}
		f.closed = append(f.closed, code)
		// reflect the close in the fake platform list
		for i := range f.challenges {
			if f.challenges[i].UniqueCode == code {
				f.challenges[i].ContainerStatus = "stopped"
			}
		}
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
	// invisible to the reaper; ForceRelease must free the slot anyway.
	f := newFixture(t, 1)
	f.challenges = []Challenge{
		{UniqueCode: "a-01", ContainerStatus: "available"},
		{UniqueCode: "a-02", IsCompleted: true, ContainerStatus: "stopped"},
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
		t.Fatal("the leaked container still occupies the only slot")
	}
	if len(f.closed) != 0 {
		t.Fatalf("a title with a live successor must not be reaped: %v", f.closed)
	}
	f.gate.ForceRelease(ctx, "a-01")
	if len(f.closed) != 1 || f.closed[0] != "a-01" {
		t.Fatalf("force release must close the stopped goal's container: %v", f.closed)
	}
	if !f.gate.Allow(ctx, c) {
		t.Fatal("after force release the slot must be free")
	}
}

func TestSlotGateCompletedContainerReapedOnSight(t *testing.T) {
	// Run 43251's leak: the challenge was fully solved (platform is_completed,
	// correct==total) yet its container stayed OPEN with every guard skipping
	// it — the agent's step had died right after the submit, ForceRelease
	// returned nil for completed codes, and the idle sweep exempted them.
	// A completed challenge's running container is worth zero: reap it on
	// sight, ahead of every other consideration.
	f := newFixture(t, 1)
	f.challenges = []Challenge{
		{UniqueCode: "f1-05", IsCompleted: true, CorrectFlagCount: 1, FlagCount: 1, ContainerStatus: "running"},
	}
	f.goal(t, "f1-05", fgs.GoalActive) // goal may even still be active (stuck step)
	other := f.goal(t, "a-02", fgs.GoalActive)

	ctx := context.Background()
	if f.gate.Allow(ctx, other) {
		t.Fatal("the solved challenge's container still occupies the slot on this call")
	}
	if len(f.closed) != 1 || f.closed[0] != "f1-05" {
		t.Fatalf("completed challenge's running container must be reaped immediately: %v", f.closed)
	}
	if !f.gate.Allow(ctx, other) {
		t.Fatal("after the reap the slot must be free")
	}
}

func TestSlotGateForceReleaseClosesCompletedChallenge(t *testing.T) {
	// Regression: ForceRelease used to return nil for completed codes under
	// the (false) assumption that the platform reaps solved challenges'
	// containers itself. It does not — closing is the hook's whole job.
	f := newFixture(t, 1)
	f.challenges = []Challenge{
		{UniqueCode: "f1-05", IsCompleted: true, CorrectFlagCount: 1, FlagCount: 1, ContainerStatus: "running"},
	}
	if err := f.gate.ForceRelease(context.Background(), "f1-05"); err != nil {
		t.Fatalf("force release of a completed challenge must succeed: %v", err)
	}
	if len(f.closed) != 1 || f.closed[0] != "f1-05" {
		t.Fatalf("completed challenge's container must be closed: %v", f.closed)
	}
}

func TestSlotGateRetriesFailedCloseUntilPlatformConfirms(t *testing.T) {
	// A transient 5xx on the one-shot close POST used to leak the slot for
	// the rest of the run. Now the failure parks the code and every
	// releaseRetryTTL the gate re-posts until the snapshot shows it down.
	f := newFixture(t, 1)
	f.challenges = []Challenge{{UniqueCode: "a-01", ContainerStatus: "running"}}
	f.goal(t, "a-01", fgs.GoalStopped)
	other := f.goal(t, "a-02", fgs.GoalActive)
	f.failCloses = 1 // first close attempt fails

	ctx := context.Background()
	if err := f.gate.ForceRelease(ctx, "a-01"); err == nil {
		t.Fatal("the failed close must surface its error")
	}
	if len(f.closed) != 1 || f.closed[0] != "a-01!ERR" {
		t.Fatalf("first attempt must have failed: %v", f.closed)
	}
	f.now = f.now.Add(31 * time.Second) // past releaseRetryTTL
	if f.gate.Allow(ctx, other) {
		t.Fatal("the unreleased container must still occupy the slot")
	}
	if len(f.closed) != 2 || f.closed[1] != "a-01" {
		t.Fatalf("the parked release must be retried: %v", f.closed)
	}
	if !f.gate.Allow(ctx, other) {
		t.Fatal("after the successful retry the slot must be free")
	}
	f.now = f.now.Add(31 * time.Second)
	f.gate.Allow(ctx, other)
	if len(f.closed) != 2 {
		t.Fatalf("a confirmed release must not be re-posted: %v", f.closed)
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
