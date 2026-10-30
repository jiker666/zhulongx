package bench

import (
	"context"
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
}

// NewSlotGate builds a gate for at most maxSlots concurrent containers.
func NewSlotGate(st *store.Store, c *Client, maxSlots int, log *slog.Logger) *SlotGate {
	return &SlotGate{
		st:        st,
		client:    c,
		log:       log,
		maxSlot:   maxSlots,
		pollTTL:   8 * time.Second,
		reserveTTL: 4 * time.Minute,
		sweepTTL:  5 * time.Minute,
		now:       time.Now,
		listOnce:  c.List,
		closeCode: c.Close,
		reserved:  map[string]time.Time{},
		lastWork:  map[string]time.Time{},
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
		if !isRunning(status[code2]) || completed[code2] {
			continue // already gone, or platform credits the challenge in full
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
	return reap
}

// reap closes containers the sweep found idle (outside g.mu — Close is a
// network call).
func (g *SlotGate) reap(ctx context.Context, codes []string) {
	for _, code := range codes {
		if err := g.closeCode(ctx, code); err != nil {
			g.log.Warn("bench: slot gate reap close failed", "code", code, "err", err)
			continue
		}
		g.mu.Lock()
		if g.status != nil {
			g.status[code] = "stopped"
		}
		g.mu.Unlock()
		g.log.Info("bench: slot gate swept idle container", "code", code)
	}
}

// ForceRelease closes a challenge container now, bypassing the idle sweep.
// The engine asks for this the moment it stops a goal: the pass-2 requeue
// keeps a live goal on the title, but nothing is working the challenge
// anymore, and the sweep would only catch it sweepTTL later. A challenge
// the platform already credits needs no container, so it is skipped. The
// error return lets the engine's release retry tell failure from success.
func (g *SlotGate) ForceRelease(ctx context.Context, code string) error {
	if code == "" {
		return nil
	}
	g.mu.Lock()
	completed := g.completed[code]
	g.mu.Unlock()
	if completed {
		return nil
	}
	if err := g.closeCode(ctx, code); err != nil {
		return fmt.Errorf("close %s: %w", code, err)
	}
	g.mu.Lock()
	if g.status != nil {
		g.status[code] = "stopped"
	}
	g.mu.Unlock()
	g.log.Info("bench: slot gate released container of stopped goal", "code", code)
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
