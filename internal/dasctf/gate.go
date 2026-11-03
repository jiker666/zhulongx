package dasctf

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"zhulongx/internal/store"
)

// Gate paces Execute against the platform's env lifecycle. DASCTF differs
// from TSecBench in three ways that shape this gate:
//
//  1. Flags are judged globally by the answer panel, not against the
//     current container instance — so submission never depends on env
//     liveness and there is no deferred-flag machinery.
//  2. Envs are per-exercise ("monopoly"), async-built (build POST then
//     poll isNeedCheck), and expire on their own (expireTime ms).
//  3. Offline exercises (endpointType none) have no env at all; their
//     steps are always admissible.
//
// The gate builds env-backed exercises operator-side (the agent never
// burns a model turn on build/poll), re-builds expired ones, recovers the
// envs of solved/stopped goals, and feeds flag progress to the engine.
type Gate struct {
	st     *store.Store
	client *Client
	log    *slog.Logger
	now    func() time.Time

	pollTTL       time.Duration // snapshot cache lifetime
	buildCooldown time.Duration // min spacing between build POSTs per exercise
	expireMargin  time.Duration // treat envs expiring within this as not live
	recoverRetry  time.Duration // re-recover cadence for parked recoveries
	rateLimitWait time.Duration // backoff after a platform 429

	mu             sync.Mutex
	lastPoll       time.Time
	polledOnce     bool
	backoffUntil   time.Time    // platform said 429: poll nothing before this
	seen           map[int]bool // exercises present in the last list snapshot
	classified     map[int]bool // exercises whose detail poll ever succeeded
	solved         map[int]bool
	envBacked      map[int]bool
	envLive        map[int]bool
	lastBuild      map[int]time.Time
	pendingRecover map[int]time.Time
	submitted      map[string]bool // "id|flag" — one shot per value
	onSnapshot     func(ctx context.Context)
}

// NewGate builds a gate for one match.
func NewGate(st *store.Store, c *Client, log *slog.Logger) *Gate {
	return &Gate{
		st:             st,
		client:         c,
		log:            log,
		now:            time.Now,
		pollTTL:        30 * time.Second,
		buildCooldown:  60 * time.Second,
		expireMargin:   2 * time.Minute,
		recoverRetry:   30 * time.Second,
		rateLimitWait:  60 * time.Second,
		seen:           map[int]bool{},
		classified:     map[int]bool{},
		solved:         map[int]bool{},
		envBacked:      map[int]bool{},
		envLive:        map[int]bool{},
		lastBuild:      map[int]time.Time{},
		pendingRecover: map[int]time.Time{},
		submitted:      map[string]bool{},
	}
}

// OnSnapshot registers a callback fired after each successful platform
// snapshot refresh (outside g.mu).
func (g *Gate) OnSnapshot(cb func(ctx context.Context)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.onSnapshot = cb
}

// Progress reports the platform's cached flag progress for an exercise:
// one flag per exercise, so (1,1) once solved. ok=false when nothing has
// been polled for the ID. The engine uses it to refuel budgets and order
// the endgame harvest.
func (g *Gate) Progress(exerciseID int) (cur, total int, ok bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.polledOnce || !g.seen[exerciseID] {
		return 0, 0, false
	}
	if g.solved[exerciseID] {
		return 1, 1, true
	}
	return 0, 1, true
}

// Allow reports whether the goal may claim an Execute step right now.
// Non-DASCTF goals are always allowed. Offline exercises are always
// allowed. Env-backed exercises are admitted once their env is live; the
// gate kicks off (and spaces out) env builds itself.
func (g *Gate) Allow(ctx context.Context, goalID string) bool {
	goal, err := g.st.GetGoal(ctx, goalID)
	if err != nil {
		return true // unknown goal: never block the engine on it
	}
	id, ok := CodeOfTitle(goal.Title)
	if !ok {
		return true
	}

	g.mu.Lock()
	g.refreshLocked(ctx)
	if g.solved[id] {
		g.mu.Unlock() // confirmation rounds need no env
		return true
	}
	if !g.envBacked[id] {
		g.mu.Unlock() // offline exercise: nothing to wait for
		return true
	}
	if g.envLive[id] {
		g.mu.Unlock()
		return true
	}
	// Env-backed but env not live: maybe (re)build, then wait.
	build := false
	if g.now().Sub(g.lastBuild[id]) >= g.buildCooldown {
		g.lastBuild[id] = g.now()
		build = true
	}
	g.mu.Unlock()
	if build {
		if err := g.client.BuildEnv(ctx, id); err != nil {
			g.log.Warn("dasctf: env build failed, will retry after cooldown", "exercise", id, "err", err)
		} else {
			g.log.Info("dasctf: env build requested", "exercise", id)
		}
	}
	return false
}

// Refresh forces one platform snapshot poll now, bypassing pollTTL, so a
// caller making an irreversible decision (flag submission) judges solved
// state as of now.
func (g *Gate) Refresh(ctx context.Context) {
	g.mu.Lock()
	g.lastPoll = time.Time{}
	recoverIDs := g.refreshLocked(ctx)
	g.mu.Unlock()
	g.recoverAll(ctx, recoverIDs)
}

// refreshLocked refreshes the snapshot when stale and reports which
// exercise envs should be recovered (solved, or parked from a failed
// recover). Callers hold g.mu; the recovers themselves happen outside.
func (g *Gate) refreshLocked(ctx context.Context) []int {
	now := g.now()
	if g.polledOnce && now.Sub(g.lastPoll) < g.pollTTL {
		return nil
	}
	// Platform rate limit (429/40001): the gate polls nothing during the
	// backoff window — one burst of List+Detail through a strict limiter
	// otherwise poisons every subsequent cycle (first live run: three
	// offline details 429'd on every refresh for minutes).
	if now.Before(g.backoffUntil) {
		return nil
	}
	g.lastPoll = now
	exercises, err := g.client.List(ctx)
	if err != nil {
		if isRateLimited(err) {
			g.backoffUntil = now.Add(g.rateLimitWait)
			g.log.Warn("dasctf: list rate-limited, backing off", "wait", g.rateLimitWait)
			return nil
		}
		// Keep the last snapshot on error; before the first successful
		// poll stay permissive so an API hiccup cannot deadlock the run.
		if !g.polledOnce {
			return nil
		}
		g.log.Warn("dasctf: gate poll failed, reusing snapshot", "err", err)
		return nil
	}
	firstPoll := !g.polledOnce
	g.polledOnce = true
	seen := map[int]bool{}
	classified := map[int]bool{}
	solved := map[int]bool{}
	envBacked := map[int]bool{}
	envLive := map[int]bool{}
	rateLimited := false
	for _, ex := range exercises {
		seen[ex.ID] = true
		solved[ex.ID] = ex.HasSolved
		// Carry the previous classification forward: a failed detail must
		// not demote an env-backed exercise to "offline" (that would
		// admit steps against a dead env) or forget a live one.
		envBacked[ex.ID] = g.envBacked[ex.ID]
		envLive[ex.ID] = g.envLive[ex.ID]
		// Offline exercises never change shape — skip their detail poll
		// entirely (hasSolved from the list is all the gate needs). Solved
		// exercises with no known env need no detail either. An exercise
		// whose detail never SUCCEEDED (first poll rate-limited mid-burst)
		// is retried every cycle until it classifies once.
		if !firstPoll && g.classified[ex.ID] && !g.envBacked[ex.ID] && !g.solved[ex.ID] {
			continue
		}
		if ex.HasSolved && !g.envLive[ex.ID] {
			continue
		}
		d, err := g.client.Detail(ctx, ex.ID)
		if err != nil {
			if isRateLimited(err) {
				rateLimited = true
				continue
			}
			g.log.Warn("dasctf: gate detail poll failed", "exercise", ex.ID, "err", err)
			continue
		}
		envBacked[ex.ID] = EnvBacked(d)
		envLive[ex.ID] = envUsable(d, now, g.expireMargin)
		classified[ex.ID] = true
	}
	if rateLimited {
		g.backoffUntil = now.Add(g.rateLimitWait)
		g.log.Warn("dasctf: detail polls rate-limited, backing off", "wait", g.rateLimitWait)
	}
	g.seen, g.solved, g.envBacked, g.envLive, g.classified = seen, solved, envBacked, envLive, classified

	// Solved exercises hold nothing worth keeping: recover their envs.
	var recoverIDs []int
	for id, s := range solved {
		if s && envLive[id] {
			recoverIDs = append(recoverIDs, id)
		}
		delete(g.pendingRecover, id) // solved: no further retries needed
	}
	// Parked recoveries: retry until the snapshot shows no env.
	for id, at := range g.pendingRecover {
		if envLive[id] && now.Sub(at) >= g.recoverRetry {
			g.pendingRecover[id] = now
			recoverIDs = append(recoverIDs, id)
		}
	}
	return recoverIDs
}

// isRateLimited reports whether the platform answered with its 429 code.
func isRateLimited(err error) bool {
	var ae *APIError
	if !errors.As(err, &ae) {
		return false
	}
	return ae.StatusCode == http.StatusTooManyRequests || ae.Code == "40001"
}

// envUsable reports whether the detail shows a ready env: not still
// building, endpoints present, and not about to expire.
func envUsable(d *Detail, now time.Time, margin time.Duration) bool {
	if d == nil || d.IsNeedCheck || len(d.Endpoints) == 0 {
		return false
	}
	latest := int64(0)
	for _, ep := range d.Endpoints {
		if ep.ExpireTime > latest {
			latest = ep.ExpireTime
		}
	}
	if latest == 0 {
		return true // no expiry advertised
	}
	return time.UnixMilli(latest).After(now.Add(margin))
}

// recoverAll recovers envs outside g.mu (network calls), parking failures.
func (g *Gate) recoverAll(ctx context.Context, ids []int) {
	for _, id := range ids {
		if err := g.client.RecoverEnv(ctx, id); err != nil {
			g.mu.Lock()
			g.pendingRecover[id] = g.now()
			g.mu.Unlock()
			g.log.Warn("dasctf: env recover failed, will retry", "exercise", id, "err", err)
			continue
		}
		g.mu.Lock()
		g.envLive[id] = false
		g.mu.Unlock()
		g.log.Info("dasctf: env recovered", "exercise", id)
	}
	g.mu.Lock()
	cb := g.onSnapshot
	g.mu.Unlock()
	if cb != nil {
		cb(ctx)
	}
}

// ForceRelease recovers the env of a goal the engine just stopped. The
// exercise may get a successor pass later; recovering frees the platform
// env (a stopped goal has no in-flight work for it).
func (g *Gate) ForceRelease(ctx context.Context, goalID string) error {
	goal, err := g.st.GetGoal(ctx, goalID)
	if err != nil {
		return fmt.Errorf("dasctf: release: load goal: %w", err)
	}
	id, ok := CodeOfTitle(goal.Title)
	if !ok {
		return nil // not a DASCTF goal: nothing to release
	}
	g.mu.Lock()
	backed := g.envBacked[id]
	g.mu.Unlock()
	if !backed {
		return nil
	}
	if err := g.client.RecoverEnv(ctx, id); err != nil {
		g.mu.Lock()
		g.pendingRecover[id] = g.now()
		g.mu.Unlock()
		return fmt.Errorf("dasctf: recover %d: %w", id, err)
	}
	g.mu.Lock()
	g.envLive[id] = false
	g.mu.Unlock()
	g.log.Info("dasctf: env released for stopped goal", "exercise", id)
	return nil
}

// Submit fires one flag submission for the exercise behind title. It
// dedupes per (exercise, value) and skips values that are not DASCTF
// flag-shaped — the engine's harvest regex also matches bare flag{...}
// strings, which on this platform are not answers.
func (g *Gate) Submit(ctx context.Context, title, flag string) {
	id, ok := CodeOfTitle(title)
	if !ok {
		return
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(flag)), "dasctf{") {
		return
	}
	g.Refresh(ctx) // judge solved state as of now
	g.mu.Lock()
	if g.solved[id] {
		g.mu.Unlock()
		return // already banked; nothing to ask
	}
	key := fmt.Sprintf("%d|%s", id, flag)
	if g.submitted[key] {
		g.mu.Unlock()
		return
	}
	g.submitted[key] = true
	g.mu.Unlock()

	res, err := g.client.Answer(ctx, id, flag)
	switch {
	case err != nil:
		g.log.Info("dasctf: submit rejected", "exercise", id, "err", err)
	case res.IsCorrect:
		g.log.Info("dasctf: FLAG BANKED", "exercise", id, "flag", flag)
	default:
		g.log.Info("dasctf: submit not correct", "exercise", id)
	}
}
