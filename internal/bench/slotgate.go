package bench

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"zhulongx/internal/fgs"
	"zhulongx/internal/store"
)

// SlotGate paces Execute against the platform's concurrent-instance limit
// (default 3 per task). The engine asks Allow(goalID) before claiming a
// step; a goal is admitted only when its challenge container is already
// running, its challenge is already completed (confirmation rounds need no
// container), or a slot — or a short-lived reservation — is free.
//
// Without the gate, every goal enters the agent loop and fights for slots
// with poll loops and sleep waits, each turn a full model round-trip: on
// the hosted benchmark this starved 44 of 63 challenges while burning the
// token budget. With the gate, a slot-less goal's steps simply stay
// pending at zero model cost.
//
// The gate also sweeps leaked containers: a running container whose
// challenge has no in-flight step (and had none within the sweep TTL) gets
// closed, so neither a stopped goal nor a one-shot release failure can
// hold a slot hostage.
type SlotGate struct {
	st      *store.Store
	client  *Client
	log     *slog.Logger
	maxSlot int

	pollTTL    time.Duration // platform-list cache lifetime
	reserveTTL time.Duration // how long an admission reservation holds
	sweepTTL   time.Duration // how long a running container may go without in-flight work
	now        func() time.Time
	listOnce   func(ctx context.Context) ([]Challenge, error)
	closeCode  func(ctx context.Context, code string) error

	mu         sync.Mutex
	lastPoll   time.Time
	polledOnce bool
	status     map[string]string // code -> container_status
	completed  map[string]bool   // code -> platform is_completed
	correct    map[string]int    // code -> correct_flag_count (progress / endgame priority)
	total      map[string]int    // code -> flag_count
	reserved   map[string]time.Time
	lastWork   map[string]time.Time // code -> last time a running step used its container
	// pendingRelease parks codes whose close POST failed: the gate re-asks
	// the platform every releaseRetryTTL until the snapshot shows the
	// container down, so one transient 5xx on a one-shot close cannot leak
	// a slot for the rest of the run.
	pendingRelease map[string]time.Time

	releaseRetryTTL time.Duration // re-close cadence for parked releases

	onSnapshot func(ctx context.Context) // optional: fired after each successful refresh (fast-lane pending flush)
}

// NewSlotGate builds a gate for at most maxSlots concurrent containers.
func NewSlotGate(st *store.Store, c *Client, maxSlots int, log *slog.Logger) *SlotGate {
	return &SlotGate{
		st:              st,
		client:          c,
		log:             log,
		maxSlot:         maxSlots,
		pollTTL:         8 * time.Second,
		reserveTTL:      4 * time.Minute,
		sweepTTL:        5 * time.Minute,
		now:             time.Now,
		listOnce:        c.List,
		closeCode:       c.Close,
		reserved:        map[string]time.Time{},
		lastWork:        map[string]time.Time{},
		pendingRelease:  map[string]time.Time{},
		releaseRetryTTL: 30 * time.Second,
	}
}

// Progress reports the platform's cached flag progress for a challenge:
// correct and total flag counts. ok=false when nothing has been polled for
// the code. The engine uses it to refuel the wall budget of goals whose
// flags are actually being banked, and to order the endgame harvest.
func (g *SlotGate) Progress(code string) (cur, total int, ok bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.correct == nil {
		return 0, 0, false
	}
	cur, total, ok = g.correct[code], g.total[code], g.polledOnce && g.status != nil
	if _, has := g.status[code]; !has {
		ok = false
	}
	return
}

// Submittable reports whether a flag for this challenge is still worth
// submitting right now: the container must be RUNNING and the challenge not
// already completed. The platform judges a submission against the CURRENT
// instance's flag values, so once the container is closed a re-submission of
// a previously banked value scores as WRONG (run 42416: the flag fast lane
// re-submitted the agent's own banked flag 7 seconds after its close), and a
// completed challenge needs nothing.
//
// Submittable reads the cached snapshot and never refreshes — callers about
// to fire a one-shot submit must Refresh first or they may act on a snapshot
// that predates a close (run 42778: c-08's banked value went out 7s after
// its close anyway, straight through this gate, because the cache was 8s
// stale and nothing forced a poll).
func (g *SlotGate) Submittable(code string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.status == nil {
		return false
	}
	if g.completed[code] {
		return false
	}
	return isRunning(g.status[code])
}

// Refresh forces one platform snapshot poll now, bypassing pollTTL, so a
// caller making an irreversible decision (flag submission) judges container
// state as of now instead of as of the last Allow-driven poll.
func (g *SlotGate) Refresh(ctx context.Context) {
	g.mu.Lock()
	g.lastPoll = time.Time{} // zero forces refreshLocked to poll
	reap := g.refreshLocked(ctx)
	g.mu.Unlock()
	g.reap(ctx, reap)
}

// OnSnapshot registers a callback fired after each successful platform
// snapshot refresh (after reap, outside g.mu). The fast lane uses it to
// flush deferred flags the moment their containers come back live.
func (g *SlotGate) OnSnapshot(cb func(ctx context.Context)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.onSnapshot = cb
}

// Allow reports whether the goal may claim an Execute step right now.
// Non-benchmark goals are always allowed (no container to manage).
func (g *SlotGate) Allow(ctx context.Context, goalID string) bool {
	goal, err := g.st.GetGoal(ctx, goalID)
	if err != nil {
		return true // unknown goal: never block the engine on it
	}
	code, ok := CodeOfTitle(goal.Title)
	if !ok {
		return true
	}

	g.mu.Lock()
	reap := g.refreshLocked(ctx)
	if g.completed[code] {
		// Platform already credits this challenge: its remaining steps are
		// cheap confirm/complete rounds that need no container.
		g.mu.Unlock()
		g.reap(ctx, reap)
		return true
	}
	if g.runningLocked(code) {
		// This goal owns a running container — keep working it.
		g.mu.Unlock()
		g.reap(ctx, reap)
		return true
	}
	occupied := 0
	for _, s := range g.status {
		if isRunning(s) {
			occupied++
		}
	}
	now := g.now()
	for c2, at := range g.reserved {
		if c2 != code && now.Sub(at) <= g.reserveTTL {
			occupied++
		}
	}
	allow := occupied < g.maxSlot
	if allow {
		g.reserved[code] = now
	}
	g.mu.Unlock()
	g.reap(ctx, reap)
	return allow
}

// refreshLocked refreshes the platform snapshot when stale and reports
// which terminal-goal containers should be reaped. Callers hold g.mu; the
// reaping itself happens outside the lock in reap.
func (g *SlotGate) refreshLocked(ctx context.Context) []string {
	now := g.now()
	if g.polledOnce && now.Sub(g.lastPoll) < g.pollTTL {
		return nil
	}
	g.lastPoll = now
	challenges, err := g.listOnce(ctx)
	if err != nil {
		// Keep the last snapshot on error; before the first successful
		// poll stay permissive so an API hiccup cannot deadlock the run.
		if !g.polledOnce {
			return nil
		}
		g.log.Warn("bench: slot gate poll failed, reusing snapshot", "err", err)
		return nil
	}
	g.polledOnce = true
	status := make(map[string]string, len(challenges))
	completed := make(map[string]bool, len(challenges))
	correct := make(map[string]int, len(challenges))
	total := make(map[string]int, len(challenges))
	for _, ch := range challenges {
		status[ch.UniqueCode] = ch.ContainerStatus
		completed[ch.UniqueCode] = ch.IsCompleted
		correct[ch.UniqueCode] = ch.CorrectFlagCount
		total[ch.UniqueCode] = ch.FlagCount
	}
	g.status = status
	g.completed = completed
	g.correct = correct
	g.total = total

	// Drop reservations that expired or materialized into real containers.
	for code, at := range g.reserved {
		if now.Sub(at) > g.reserveTTL || isRunning(status[code]) {
			delete(g.reserved, code)
		}
	}

	// Idle sweep: a running container is justified only by in-flight work.
	// The historical leak (run 42361: a-16 held a slot 2h10m, c-08 1h54m
	// after their goals were budget-stopped) came from the stop-time
	// ReleaseContainer hook being one-shot — when its single POST failed,
	// the successor pass-2 goal made the old terminal-goal reaper skip the
	// title forever. The sweep judges the container, not the goal: keep it
	// while a running step works this challenge (or did within sweepTTL —
	// covers the gap between two execute steps of one pass), reap it
	// otherwise, whatever the goal table says.
	goals, err := g.st.ListGoals(ctx)
	if err != nil {
		g.log.Warn("bench: slot gate sweep scan failed", "err", err)
		return nil
	}
	runningGoals, err := g.st.RunningGoalIDs(ctx)
	if err != nil {
		g.log.Warn("bench: slot gate running-step scan failed", "err", err)
		return nil
	}
	working := make(map[string]bool)
	for _, gl := range goals {
		if !runningGoals[gl.ID] {
			continue
		}
		if code2, ok := CodeOfTitle(gl.Title); ok {
			working[code2] = true
		}
	}
	for code2 := range working {
		g.lastWork[code2] = now
	}
	hasActive := make(map[string]bool)
	for _, gl := range goals {
		if gl.Status == fgs.GoalActive {
			if code2, ok := CodeOfTitle(gl.Title); ok {
				hasActive[code2] = true
			}
		}
	}
	var reap []string
	for code2 := range status {
		if !isRunning(status[code2]) {
			continue // already gone
		}
		// A COMPLETED challenge's running container is the first thing to
		// reap, not something to skip: the platform does NOT auto-close
		// solved challenges (run 43251: f1-05 banked its last flag at
		// t+12.7 and the container sat open 15+ minutes — the step died on
		// a transport error at that exact seam, the stop-time
		// ReleaseContainer treated "completed" as nothing-to-release, and
		// this sweep exempted completed codes). Nothing legitimate still
		// needs a fully solved challenge's container, not even an
		// in-flight step writing its ledger: the ledger lives agent-side.
		if completed[code2] {
			reap = append(reap, code2)
			continue
		}
		if working[code2] {
			continue // a running step is using this container right now
		}
		if now.Sub(g.reserved[code2]) <= g.reserveTTL {
			continue // admission in progress
		}
		// An active-but-queued pass-2 goal does NOT protect its container
		// forever: the goal may sit behind the whole queue for hours (42361:
		// a-16 2h10m, c-08 1h54m). The container stays only while in-flight
		// work used it recently.
		if last, ok := g.lastWork[code2]; ok && now.Sub(last) <= g.sweepTTL {
			continue // step finished moments ago; the pass is between steps
		}
		if _, ok := g.lastWork[code2]; !ok && hasActive[code2] {
			// First sight of a running container that an active goal may
			// still claim (engine restart mid-run): start the idle clock
			// instead of killing on arrival.
			g.lastWork[code2] = now
			continue
		}
		reap = append(reap, code2)
	}

	// Parked releases: retry the close POST every releaseRetryTTL until the
	// snapshot shows the container down (cleared the moment it does). A
	// code already reaped above is skipped so the POST fires once per cycle.
	inReap := make(map[string]bool, len(reap))
	for _, c := range reap {
		inReap[c] = true
	}
	for code2, at := range g.pendingRelease {
		if !isRunning(status[code2]) {
			delete(g.pendingRelease, code2)
			continue
		}
		if inReap[code2] || now.Sub(at) < g.releaseRetryTTL {
			continue
		}
		g.pendingRelease[code2] = now
		reap = append(reap, code2)
	}
	return reap
}

// reap closes containers the sweep found idle (outside g.mu — Close is a
// network call), then fires the on-snapshot callback so dependents on the
// fresh platform state (the fast lane's deferred flags) can act. A failed
// close parks the code for retry instead of leaking the slot silently.
func (g *SlotGate) reap(ctx context.Context, codes []string) {
	for _, code := range codes {
		if err := g.closeNow(ctx, code); err != nil {
			g.mu.Lock()
			g.pendingRelease[code] = g.now()
			g.mu.Unlock()
			g.log.Warn("bench: container close failed, will retry", "code", code, "err", err)
			continue
		}
		g.mu.Lock()
		if g.status != nil {
			g.status[code] = "stopped"
		}
		delete(g.pendingRelease, code)
		g.mu.Unlock()
		g.log.Info("bench: slot gate swept idle container", "code", code)
	}
	g.mu.Lock()
	cb := g.onSnapshot
	g.mu.Unlock()
	if cb != nil {
		cb(ctx)
	}
}

// ForceRelease closes a challenge container now, bypassing the idle sweep.
// The engine asks for this the moment it stops a goal: the pass-2 requeue
// keeps a live goal on the title, but nothing is working the challenge
// anymore, and the sweep would only catch it sweepTTL later. Completed
// challenges are the MOST important thing to close, not the least: the
// platform does not auto-close solved challenges (run 43251: a 1/1-flag
// challenge's container sat open 15+ minutes because this hook returned nil
// for completed codes). Closing is idempotent — invalid_state (already
// stopped) counts as success. A failed POST parks the code for retry.
func (g *SlotGate) ForceRelease(ctx context.Context, code string) error {
	if code == "" {
		return nil
	}
	if err := g.closeNow(ctx, code); err != nil {
		g.mu.Lock()
		g.pendingRelease[code] = g.now()
		g.mu.Unlock()
		return fmt.Errorf("close %s: %w", code, err)
	}
	g.mu.Lock()
	if g.status != nil {
		g.status[code] = "stopped"
	}
	delete(g.pendingRelease, code)
	g.mu.Unlock()
	g.log.Info("bench: slot gate released container of stopped goal", "code", code)
	return nil
}

// closeNow posts one Close, treating invalid_state (the container is
// already stopped or the task is over) as success: the goal of the call is
// a non-running container, and that state already holds.
func (g *SlotGate) closeNow(ctx context.Context, code string) error {
	if err := g.closeCode(ctx, code); err != nil {
		var ae *APIError
		if errors.As(err, &ae) && ae.Code == CodeInvalidState {
			return nil
		}
		return err
	}
	return nil
}

func (g *SlotGate) runningLocked(code string) bool {
	return isRunning(g.status[code])
}

// isRunning treats every non-stopped, non-empty status as occupying a
// platform slot (pending = booting, stop_pending = not yet released).
func isRunning(status string) bool {
	return status != "" && status != "stopped"
}
