package bench

import (
	"context"
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
// The gate also reaps leaked containers: a challenge whose goal is
// completed or stopped (terminal — it will never run again) but whose
// container still shows running gets closed, so a dead goal cannot hold a
// slot hostage.
type SlotGate struct {
	st      *store.Store
	client  *Client
	log     *slog.Logger
	maxSlot int

	pollTTL    time.Duration // platform-list cache lifetime
	reserveTTL time.Duration // how long an admission reservation holds
	now        func() time.Time
	listOnce   func(ctx context.Context) ([]Challenge, error)
	closeCode  func(ctx context.Context, code string) error

	mu         sync.Mutex
	lastPoll   time.Time
	polledOnce bool
	status     map[string]string // code -> container_status
	completed  map[string]bool   // code -> platform is_completed
	reserved   map[string]time.Time
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
		now:       time.Now,
		listOnce:  c.List,
		closeCode: c.Close,
		reserved:  map[string]time.Time{},
	}
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
	for _, ch := range challenges {
		status[ch.UniqueCode] = ch.ContainerStatus
		completed[ch.UniqueCode] = ch.IsCompleted
	}
	g.status = status
	g.completed = completed

	// Drop reservations that expired or materialized into real containers.
	for code, at := range g.reserved {
		if now.Sub(at) > g.reserveTTL || isRunning(status[code]) {
			delete(g.reserved, code)
		}
	}

	// Terminal goal + running container = a slot held hostage.
	var reap []string
	goals, err := g.st.ListGoals(ctx)
	if err != nil {
		g.log.Warn("bench: slot gate reaper scan failed", "err", err)
		return nil
	}
	for _, gl := range goals {
		if gl.Status != fgs.GoalCompleted && gl.Status != fgs.GoalStopped {
			continue
		}
		code2, ok := CodeOfTitle(gl.Title)
		if !ok || !isRunning(status[code2]) {
			continue
		}
		reap = append(reap, code2)
	}
	return reap
}

// reap closes leaked containers of terminal goals (outside g.mu — Close
// is a network call).
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
		g.log.Info("bench: slot gate reaped container of terminal goal", "code", code)
	}
}

func (g *SlotGate) runningLocked(code string) bool {
	return isRunning(g.status[code])
}

// isRunning treats every non-stopped, non-empty status as occupying a
// platform slot (pending = booting, stop_pending = not yet released).
func isRunning(status string) bool {
	return status != "" && status != "stopped"
}
