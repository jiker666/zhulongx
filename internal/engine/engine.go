// Package engine is zhulongx's scheduler: it drives Goals through the
// FGS graph by alternating two modes.
//
//   - Decide (serial, globally): reviews open findings, judges completion,
//     declares new steps.
//   - Execute (bounded concurrency): pushes one step through the Pi agent
//     loop, validates the result, records a Finding.
//
// Scheduling rules:
//   - Decide runs on the first tick and whenever the graph grew (facts,
//     findings, hints) or all steps drained to zero open.
//   - While steps are open, Execute keeps ClaimNextStep until the
//     concurrency budget is spent.
//   - A completed/stopped goal stops scheduling immediately.
package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"zhulongx/internal/cfg"
	"zhulongx/internal/fgs"
	"zhulongx/internal/pi"
	"zhulongx/internal/store"
)

// Runner is the agent-loop interface the engine depends on. Production
// uses *pi.Adapter; tests inject scripted fakes.
type Runner interface {
	Prompt(ctx context.Context, message string) (*pi.PromptResult, error)
	Close() error
}

// RunnerFactory launches one isolated runner context. Each call must
// produce an independent process/context (spec: isolated call contexts).
type RunnerFactory func() (Runner, error)

// Engine owns the run loop.
type Engine struct {
	store     *store.Store
	cfg       *cfg.Config
	log       *slog.Logger
	newRunner RunnerFactory

	mu           sync.Mutex
	snapshot     map[string]store.SnapshotCounts // last Decide checkpoint per goal
	noop         map[string]int                  // consecutive empty Decide rounds
	rescued      map[string]bool                 // goals whose noop rescue already fired (one shot per goal)
	rescuedTitle map[string]bool                 // titles whose platform hint was already pulled (any pass)
	deciding     string                          // goalID of the in-flight Decide round ("" = none): Decide is globally serial
	running      int                             // active Execute goroutines

	// Budget bookkeeping (GoalStepBudget / GoalWallBudget / RunDeadline).
	now        func() time.Time     // injectable clock
	startedAt  time.Time            // set in Run; RunDeadline counts from here
	firstClaim map[string]time.Time // goalID → first claimed step time
	firstTouch map[string]bool      // title → any goal with this title has claimed a step (first-touch fairness signal)
	requeues   map[string]int       // title → requeues spent (cap 2)

	// Sterile-pass refund: a requeued pass that never landed ANY real
	// agent output (every step deferred WAITING_SLOT — the slot race of
	// run 43633 burned c-04's pass-2/3/4 with zero attack minutes) must
	// not consume the requeue fuse. One refund per title bounds the loop;
	// passWorked is set by any natural report or deadline salvage, so a
	// pass killed mid-attack keeps its count.
	requeuedGoal    map[string]bool // goalIDs minted by requeuePass2
	passWorked      map[string]bool // goalIDs that produced a real finding
	sterileRefunded map[string]bool // titles that already banked their one refund

	// Zero-delta stall accounting (FlagStallPasses): a banked partial that
	// stops converting keeps its converter privileges only for so long.
	// passBase is the platform correct count at the last counted pass
	// boundary; zeroStreak counts consecutive boundaries with no new flags.
	// passCounted makes each boundary count exactly once — endgameTopUp
	// re-offers the same stopped goal every tick, and the pass ended once.
	passBase    map[string]int  // title → correct count at last pass boundary
	zeroStreak  map[string]int  // title → consecutive zero-delta boundaries
	passCounted map[string]bool // goalID → its stop already counted as a boundary

	// Hint-pool bookkeeping: hintSeen holds the text of every platform hint
	// pulled for a title; a repeat text means the pool is dry (the platform
	// charges each view), so hintDry marks the title off limits for further
	// pulls — engine-side prefetch and the noop rescue both respect it.
	hintSeen map[string]map[string]bool
	hintDry  map[string]bool

	// Flag-progress budget refuel: a goal whose challenge banked flags
	// during the current pass is demonstrably converting slot time into
	// score — its wall budget refuels instead of expiring (run 42361:
	// b-01 was killed at 2/4 flags with the third in reach). The step
	// budget must refuel with it: run 43065's six-flag intranet had its
	// clock refueled twice but was still step-capped mid-harvest, burning
	// 31% of the run's slot capacity across seven container restarts.
	// Capped at FlagRefillMax refuels per goal; the baseline correct-count
	// is captured at first claim so the refuel only pays on NEW progress.
	flagBase    map[string]int
	flagRefills map[string]int
	// stepBonus is the extra Execute-step headroom granted by flag refuels
	// (FlagStepBonus each, on top of the base GoalStepBudget).
	stepBonus map[string]int
	// Active grace: a goal whose last step finished within graceWindow of
	// the wall deadline is mid-flow, not wedged — one +10m extension per
	// goal (run 42361: c-07's IAC breakthrough died exactly at the bell).
	graceUsed  map[string]bool
	lastFinish map[string]time.Time

	// Runner breaker: N consecutive infra failures (launch, process exit,
	// protocol) open a cooldown during which no steps are claimed and no
	// Decide rounds run — pending steps wait at zero attempt cost instead of
	// burning attempts on a dead runtime.
	failStreak    int
	cooldownUntil time.Time

	// Runtime watchdog: lastRunnerOK is the last completed runner turn
	// (either mode); when it is older than RunnerWatchdog with no step in
	// flight, the model path is declared dead and outageStart opens. During
	// an outage the budget clocks freeze (goalOverBudget returns never,
	// failStep defers at zero attempt cost, endgame top-up mints nothing,
	// scheduleGoal claims nothing) and a cheap runtime probe re-tests the
	// model path once a minute. The first successful turn closes the outage
	// and shifts every goal's wall clock by the outage length (run 43263:
	// the model path died at t+247, three in-flight steps hung until their
	// 35m ctx cut unwound them, the walls then stopped and released all
	// three goals, and the engine idled silently for the remaining 5+ hours
	// with 24 unsolved titles).
	lastRunnerOK time.Time
	outageStart  time.Time // zero = runtime considered alive
	lastProbe    time.Time // probe pacing while the outage is open

	// releaseBackoff paces the container-release retries; tests shorten it.
	releaseBackoff []time.Duration

	// NoopRescue, when set, fires once per goal at the edge of the noop
	// guard — the moment the agent has exhausted its own ideas across
	// DecideNoopLimit empty rounds. Returning a non-empty hint writes it
	// as a Hint (decideTrigger re-runs Decide on hint growth) and buys one
	// last guided round; returning ok=false proceeds with the stop.
	// Wire it to the benchmark hint endpoint: full score is lost either
	// way, the hint only trades a fraction of it.
	NoopRescue func(ctx context.Context, goalID string) (hint string, ok bool)

	// StepGate, when set, is consulted before claiming each Execute step
	// for a goal. Returning false skips the goal for this tick — its steps
	// stay pending at zero model cost. Wire it to the benchmark slot gate
	// so a goal that cannot get a challenge container never enters the
	// agent loop to burn turns waiting for one.
	StepGate func(ctx context.Context, goalID string) bool

	// ReleaseContainer, when set, is asked to close a stopped goal's
	// challenge container; a nil return means the platform confirmed the
	// close (or nothing needed closing). The immediate pass-2 requeue keeps
	// the title non-terminal, so the slot gate's idle sweep is the backstop
	// — but the stop-time release is still the fast path, and it retries: a
	// single failed POST used to pin one of three slots for hours (run
	// 42361: a-16 2h10m, c-08 1h54m).
	ReleaseContainer func(ctx context.Context, goalID string) error

	// FlagProgress, when set, reports the platform's cached flag progress
	// for a goal's title (correct, total). It feeds the wall-budget refuel
	// and the endgame harvest ordering. ok=false for non-benchmark goals.
	FlagProgress func(title string) (cur, total int, ok bool)

	// OnFlagCandidate, when set, receives every flag-shaped string the
	// engine sees land in the graph (execute reports, timeout partials,
	// decide step declarations). Wire it to the benchmark submit API: a
	// derived flag must not wait for a future step to carry it — run
	// 42361's f2-01 had the fully computed flag in a decide round and its
	// submit step was never scheduled in the 54 remaining minutes.
	OnFlagCandidate func(ctx context.Context, title, flag string)

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// New builds an engine. factory may be nil → default Pi launcher.
func New(st *store.Store, c *cfg.Config, log *slog.Logger, factory RunnerFactory) *Engine {
	if factory == nil {
		factory = func() (Runner, error) {
			// invalid patterns already rejected at config load; ignore the error
			policy, _ := pi.CompileToolPolicy(c.Pi.BlockedTools)
			return pi.Start(pi.LaunchConfig{
				Command:      c.Pi.Command,
				Args:         c.Pi.Args,
				Dir:          c.Pi.Dir,
				Policy:       policy,
				StallTimeout: c.Runtime.RunnerStallTimeout.D(),
			})
		}
	}
	return &Engine{
		store:        st,
		cfg:          c,
		log:          log,
		newRunner:    factory,
		snapshot:     map[string]store.SnapshotCounts{},
		noop:         map[string]int{},
		rescued:      map[string]bool{},
		rescuedTitle: map[string]bool{},
		now:          time.Now,
		firstClaim:   map[string]time.Time{},
		firstTouch:   map[string]bool{},
		requeues:     map[string]int{},

		requeuedGoal:    map[string]bool{},
		passWorked:      map[string]bool{},
		sterileRefunded: map[string]bool{},

		passBase:    map[string]int{},
		zeroStreak:  map[string]int{},
		passCounted: map[string]bool{},
		hintSeen:    map[string]map[string]bool{},
		hintDry:     map[string]bool{},

		flagBase:    map[string]int{},
		flagRefills: map[string]int{},
		stepBonus:   map[string]int{},
		graceUsed:   map[string]bool{},
		lastFinish:  map[string]time.Time{},

		releaseBackoff: []time.Duration{0, 5 * time.Second, 15 * time.Second, 30 * time.Second},
	}
}

// Run executes the scheduling loop until ctx is cancelled. On start it
// performs deterministic recovery of orphaned running steps.
func (e *Engine) Run(ctx context.Context) error {
	ctx, e.cancel = context.WithCancel(ctx)
	defer e.cancel()

	if n, err := e.store.RecoverAllRunning(ctx, "startup recovery"); err != nil {
		return fmt.Errorf("engine: recovery: %w", err)
	} else if n > 0 {
		e.log.Info("recovered running steps", "count", n)
	}
	e.startedAt = e.now()
	e.mu.Lock()
	e.lastRunnerOK = e.startedAt
	e.mu.Unlock()

	ticker := time.NewTicker(e.cfg.Runtime.TickInterval.D())
	defer ticker.Stop()
	for {
		e.tick(ctx)
		select {
		case <-ctx.Done():
			e.wg.Wait()
			return nil
		case <-ticker.C:
		}
	}
}

// Stop cancels the loop and waits for in-flight Execute work.
func (e *Engine) Stop() {
	if e.cancel != nil {
		e.cancel()
	}
	e.wg.Wait()
}

// stepWatchdogTTL bounds how long a running step may go without a
// heartbeat before the scheduler reclaims it. Live executors heartbeat
// every TickInterval; several minutes of silence means the goroutine (or
// the whole engine) died mid-flight and its slot is stuck.
const stepWatchdogTTL = 3 * time.Minute

// breakerThreshold / breakerCooldown: three consecutive infra runner
// failures (spawn crash, process exit, protocol refusal) pause all claims
// and Decide rounds briefly — a dead runtime must not eat attempt budgets
// while steps sit pending (run 42298 class deaths burn one attempt per
// tick otherwise). Any successful runner turn resets the streak.
const (
	breakerThreshold = 3
	breakerCooldown  = 3 * time.Minute
)

// noteRunnerFailure counts an infrastructure failure (the runtime is sick,
// not the model being slow — timeouts never count). Crossing the threshold
// opens (or, after expiry, re-arms) the cooldown.
func (e *Engine) noteRunnerFailure(stage string) {
	e.mu.Lock()
	e.failStreak++
	open := e.failStreak >= breakerThreshold && !e.now().Before(e.cooldownUntil)
	if open {
		e.cooldownUntil = e.now().Add(breakerCooldown)
	}
	e.mu.Unlock()
	if open {
		e.log.Warn("engine: runner breaker open — claims paused", "streak", e.failStreak, "cooldown", breakerCooldown.String(), "stage", stage)
	}
}

// noteRunnerSuccess resets the failure streak: any completed runner turn
// proves the runtime is alive. It also closes an open outage and, on close,
// shifts every goal's wall clock by the outage length — the outage must not
// count against budgets the goals could not spend.
func (e *Engine) noteRunnerSuccess() {
	e.mu.Lock()
	e.failStreak = 0
	now := e.now()
	e.lastRunnerOK = now
	shifted, dur := 0, time.Duration(0)
	if !e.outageStart.IsZero() {
		dur = now.Sub(e.outageStart)
		e.outageStart = time.Time{}
		for gid, first := range e.firstClaim {
			e.firstClaim[gid] = first.Add(dur)
			shifted++
		}
	}
	e.mu.Unlock()
	if shifted > 0 {
		e.log.Warn("engine: runtime recovered — outage closed, goal wall clocks shifted",
			"outage", dur.Round(time.Second), "goals_shifted", shifted)
	}
}

// runtimeDead reports whether the model path is under a declared outage:
// either one is already open, or the liveness floor is crossed (no runner
// turn completed for RunnerWatchdog AND no Execute goroutine is in flight —
// a running step may just be a long, healthy one, so in-flight work
// suppresses the trip). Tripping is a tick-path decision; once open, the
// state holds until a runner turn succeeds.
func (e *Engine) runtimeDead() bool {
	w := e.cfg.Runtime.RunnerWatchdog.D()
	if w <= 0 || e.startedAt.IsZero() {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.outageStart.IsZero() {
		return true
	}
	return e.running == 0 && e.now().Sub(e.lastRunnerOK) > w
}

// noteOutage opens (once) the outage window and alarms.
func (e *Engine) noteOutage() {
	e.mu.Lock()
	if !e.outageStart.IsZero() {
		e.mu.Unlock()
		return
	}
	sinceOK := e.now().Sub(e.lastRunnerOK)
	e.outageStart = e.now()
	e.mu.Unlock()
	e.log.Error("engine: RUNTIME OUTAGE — no completed runner turn for the watchdog window and no step in flight; budget clocks frozen, probing the model path",
		"since_last_success", sinceOK.Round(time.Second), "watchdog", e.cfg.Runtime.RunnerWatchdog.D().String())
}

// probeRuntime re-tests the model path during an outage with one cheap
// runner turn, paced at probeMinInterval. A success closes the outage (via
// noteRunnerSuccess); a failure is logged only when it is infra-shaped —
// a hanging probe is cut by its own deadline. Steps are never spent on
// probes: ClaimNextStep burns an attempt, so the probe uses a bare prompt.
const probeTimeout = 3 * time.Minute

func (e *Engine) probeRuntime(ctx context.Context) {
	e.mu.Lock()
	if e.now().Sub(e.lastProbe) < time.Minute {
		e.mu.Unlock()
		return
	}
	e.lastProbe = e.now()
	e.mu.Unlock()
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		pctx, cancel := context.WithTimeout(ctx, probeTimeout)
		defer cancel()
		runner, err := e.launchRunner()
		if err != nil {
			e.noteRunnerFailure("probe:launch")
			return
		}
		defer runner.Close()
		if _, err := runner.Prompt(pctx, "Runtime health probe. Reply with the single word OK and nothing else."); err != nil {
			if errors.Is(err, pi.ErrProcessExit) || errors.Is(err, pi.ErrProtocol) {
				e.noteRunnerFailure("probe")
			}
			return
		}
		e.noteRunnerSuccess()
	}()
}

// breakerOpen reports whether the engine is pausing work because the
// runner infrastructure keeps failing.
func (e *Engine) breakerOpen() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.now().Before(e.cooldownUntil)
}

// tick is one scheduling pass over all goals.
func (e *Engine) tick(ctx context.Context) {
	if n, err := e.store.ReclaimStaleSteps(ctx, stepWatchdogTTL, e.cfg.Runtime.StepMaxAttempts, "heartbeat lease expired"); err != nil {
		e.log.Error("reclaim stale steps", "err", err)
	} else if n > 0 {
		e.log.Warn("reclaimed stale running steps", "count", n)
	}
	goals, err := e.store.ListGoals(ctx)
	if err != nil {
		e.log.Error("list goals", "err", err)
		return
	}
	actives := make([]fgs.Goal, 0, len(goals))
	for _, g := range goals {
		if g.Status == fgs.GoalActive {
			actives = append(actives, g)
		}
	}
	// Completion sweep: a challenge whose platform progress reads full has
	// nothing left to earn. Without this, solved titles sat active until
	// budget death — burning Decide rounds on a done challenge — and then
	// requeued for two more passes, re-eating slots the untouched queue
	// tail never saw. The in-flight step lands naturally (ledger flush,
	// container close); the engine simply schedules nothing further, and
	// every resurrection path refuses completed titles.
	actives = e.sweepCompleted(ctx, actives)
	// Runtime outage: the model path is dead. Freeze the bookkeeping that
	// would otherwise burn against a corpse — fairness ranking, harvest
	// ranking, endgame minting, and step claiming are all skipped;
	// goalOverBudget and failStep carry their own outage guards. The tick's
	// runtime probe is the only thing that touches the model path until a
	// turn succeeds, then everything reopens with the clocks shifted.
	dead := e.runtimeDead()
	if dead {
		e.noteOutage()
		e.probeRuntime(ctx)
	}
	// First-touch fairness (pre-endgame): a goal whose TITLE the run has
	// never claimed a step for is visited ahead of every title already
	// worked, so a refueled siege cannot starve the queue tail (run 42416:
	// b-01 held slots across three passes for 147 minutes while e3-02 —
	// created at t+0 — first saw a container at t+358, past the deadline,
	// for a 30-second window). The signal is TITLE-keyed, not ID-keyged:
	// requeuePass2 mints a fresh goal ID per retry pass, so an ID-keyed
	// lookup let every requeued dud (run 42778: f2-01 pass-2 relaunched at
	// t+59 while ~50 titles had never seen a container) front-run the
	// untouched tail the sort exists to protect. Creation order stays the
	// tiebreaker.
	if !dead && !e.inEndgame() {
		sort.SliceStable(actives, func(i, j int) bool {
			ti, tj := e.titleTouched(actives[i].Title), e.titleTouched(actives[j].Title)
			if ti != tj {
				return !ti
			}
			return false
		})
	}
	// Endgame harvest: in the final window the scheduler stops being fair.
	// A goal holding banked-but-unfinished flag progress converts a free
	// slot into completion far cheaper than a fresh first pass (run 42361:
	// b-01 died at 2/4 flags while untouched queue-tail goals burned the
	// last hour). The full tiebreak ladder lives in endgameOrder — see the
	// 46418 note there for why rank-tier-only sorting with creation order
	// underneath starved single-pass titles behind fifth helpings.
	if !dead && e.inEndgame() {
		rank := e.endgameRank(actives)
		sort.SliceStable(actives, e.endgameOrder(actives, rank))
		actives = e.endgameTopUp(ctx, goals, actives)
	}
	for _, g := range actives {
		if ctx.Err() != nil {
			return
		}
		e.scheduleGoal(ctx, g.ID)
	}
}

// challengeComplete reports whether the challenge behind a title has all
// its flags banked (platform is_completed). Unknown progress = false.
func (e *Engine) challengeComplete(title string) bool {
	if e.FlagProgress == nil {
		return false
	}
	cur, total, ok := e.FlagProgress(title)
	return ok && total > 0 && cur >= total
}

// sweepCompleted retires goals whose challenges read fully solved and
// returns the pruned active list.
func (e *Engine) sweepCompleted(ctx context.Context, actives []fgs.Goal) []fgs.Goal {
	out := actives[:0:0]
	for _, g := range actives {
		if ctx.Err() != nil {
			return actives
		}
		if !e.challengeComplete(g.Title) {
			out = append(out, g)
			continue
		}
		if err := e.store.SetGoalStatus(ctx, g.ID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
			e.log.Error("complete sweep: set status", "goal", g.ID, "err", err)
			out = append(out, g)
			continue
		}
		e.releaseStoppedContainer(g.ID)
		e.log.Info("challenge complete: goal retired, slot freed", "goal", g.ID, "title", g.Title)
	}
	return out
}

// endgameTopUp feeds the harvest window. The requeue caps that keep mid-run
// fairness drain the queue in the final hour (run 42838: hour 5 ran at 1.17
// of 3 slots with every cap burned while stopped partials waited on the
// bench). If the fleet is under EndgameMinActive, the best stopped titles
// are requeued past the normal cap — banked progress first, creation order
// as tiebreak, never a title that already has an active goal. An idle
// endgame slot is worth exactly zero.
//
// The gate counts LIVE WORK — active goals with a step actually in flight —
// not paper-active goals. Run 43759 14:24-15:02: two zombie actives (their
// containers closed, their passes winding down) plus two real chains
// satisfied MinActive=3 on paper while the third container slot sat EMPTY
// for 38 minutes and stopped converters waited. A goal whose step is
// WAITING_SLOT-unclaimed or between passes is idle by definition: minting
// past it is exactly what the top-up exists for. Mints are bounded per
// round (liveWork + minted >= MinActive) so one round cannot flood the
// fleet with requeues; the next round re-checks whether the minted passes
// actually started working.
func (e *Engine) endgameTopUp(ctx context.Context, goals []fgs.Goal, actives []fgs.Goal) []fgs.Goal {
	if e.cfg.Runtime.EndgameMinActive <= 0 {
		return actives
	}
	// Runway floor: a minted pass needs a viable window. Run 46196 minted
	// c-08/c-09 retries with 6 minutes of runway left (their sessions read
	// ledgers, found live footholds, and died mid-harvest at the bell) —
	// those slots were pure noise. Below the floor an idle slot is worth
	// exactly as much and says nothing misleading in the log.
	const minMintRunway = 15 * time.Minute
	if d := e.cfg.Runtime.RunDeadline.D(); d > 0 && !e.startedAt.IsZero() {
		if e.startedAt.Add(d).Sub(e.now()) < minMintRunway {
			return actives
		}
	}
	liveWork := 0
	for _, a := range actives {
		// A stalled partial winding down is not live work in the top-up's
		// ledger: counting it satisfied MinActive on paper while a slot sat
		// empty — the exact shape the liveWork check exists to kill (run
		// 43759's zombie actives). Stalled titles still hold their containers
		// until their passes end naturally; the fleet simply mints around
		// them instead of waiting.
		if e.stalledTitle(a.Title) {
			continue
		}
		if _, running, err := e.store.OpenStepCount(ctx, a.ID); err == nil && running > 0 {
			liveWork++
		}
	}
	if liveWork >= e.cfg.Runtime.EndgameMinActive {
		return actives
	}
	activeTitles := make(map[string]bool, len(actives))
	for _, a := range actives {
		activeTitles[a.Title] = true
	}
	stopped := make([]fgs.Goal, 0, len(goals))
	for _, g := range goals {
		if g.Status == fgs.GoalStopped && !activeTitles[g.Title] {
			stopped = append(stopped, g)
		}
	}
	srank := e.endgameRank(stopped)
	sort.SliceStable(stopped, e.endgameOrder(stopped, srank))
	minted := 0
	for _, g := range stopped {
		if liveWork+minted >= e.cfg.Runtime.EndgameMinActive {
			break
		}
		if ctx.Err() != nil {
			break
		}
		if ng, ok := e.requeuePass2(ctx, &g); ok {
			actives = append(actives, *ng)
			minted++
		}
	}
	return actives
}

// titleTouched reports whether any goal with this title — this pass or a
// requeued earlier one — has ever claimed a step. Keyed by title, not goal
// ID: requeuePass2 mints a fresh ID per pass, so an ID-keyed lookup would
// let every retry pass front-run the untouched tail it exists to defer
// (run 42778: f2-01 pass-2 outranked ~50 never-started titles).
func (e *Engine) titleTouched(title string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.firstTouch[title]
}

// untouchedWaiting reports whether some OTHER title has an active goal that
// has never claimed a step — fresh first-pass work waiting on the fleet's
// slots. Used by requeuePass2's fresh-meat yield: a zero-progress regrind
// defers to such a title instead of re-hoarding the container it is about
// to release. Fails OPEN on store errors — a listing hiccup must not
// strand a legitimately stopped title.
func (e *Engine) untouchedWaiting(ctx context.Context, exclude string) bool {
	goals, err := e.store.ListGoals(ctx)
	if err != nil {
		return false
	}
	for _, g := range goals {
		if g.Title == exclude || g.Status != fgs.GoalActive {
			continue
		}
		if e.challengeComplete(g.Title) {
			continue
		}
		if !e.titleTouched(g.Title) {
			return true
		}
	}
	return false
}

// inEndgame reports whether the run is inside its final harvest window.
func (e *Engine) inEndgame() bool {
	d, w := e.cfg.Runtime.RunDeadline.D(), e.cfg.Runtime.EndgameAfter.D()
	if d <= 0 || w <= 0 || e.startedAt.IsZero() {
		return false
	}
	return e.now().Sub(e.startedAt) >= d-w
}

// stepBudgetFor / wallBudgetFor return the effective per-goal budgets,
// deepened inside the harvest window when Endgame overrides are set — but
// only for titles with banked flag progress. Run 42838's walls died one
// or two moves short with the next move already named (depth pays there);
// run 43574 inverted that lesson: deep walls on unbanked goals let two
// deep partials and three regrind passes hold the whole fleet for the
// final half hour while 39 untouched titles starved and the run scored
// zero. Depth is for proven converters; breadth for everything else.
func (e *Engine) stepBudgetFor(title string) int {
	budget := e.cfg.Runtime.GoalStepBudget
	if e.cfg.Runtime.MultiFlagStepBudget > budget && e.partialMultiFlag(title) {
		budget = e.cfg.Runtime.MultiFlagStepBudget
	}
	if e.inEndgame() && e.cfg.Runtime.EndgameStepBudget > 0 && e.bankedTitle(title) {
		if e.cfg.Runtime.EndgameStepBudget > budget {
			budget = e.cfg.Runtime.EndgameStepBudget
		}
	}
	return budget
}

func (e *Engine) wallBudgetFor(title string) time.Duration {
	budget := e.cfg.Runtime.GoalWallBudget.D()
	if multi := e.cfg.Runtime.MultiFlagWallBudget.D(); multi > budget && e.partialMultiFlag(title) {
		budget = multi
	}
	if e.inEndgame() && e.cfg.Runtime.EndgameWallBudget > 0 && e.bankedTitle(title) {
		if endgame := e.cfg.Runtime.EndgameWallBudget.D(); endgame > budget {
			budget = endgame
		}
	}
	return budget
}

func (e *Engine) partialMultiFlag(title string) bool {
	if e.FlagProgress == nil {
		return false
	}
	cur, total, ok := e.FlagProgress(title)
	return ok && total > 1 && cur > 0 && cur < total
}

// bankedTitle reports whether the title has banked flag progress — a
// proven converter, not a promise.
func (e *Engine) bankedTitle(title string) bool {
	if e.FlagProgress == nil {
		return false
	}
	cur, _, ok := e.FlagProgress(title)
	return ok && cur > 0
}

// flagStallPasses returns the configured zero-delta boundary limit (code
// default 2 when unset).
func (e *Engine) flagStallPasses() int {
	if n := e.cfg.Runtime.FlagStallPasses; n > 0 {
		return n
	}
	return 2
}

// stalledTitle reports whether the title has burned through FlagStallPasses
// consecutive pass boundaries without banking a new flag. Such a title keeps
// its stopped-partial RIGHT to an idle slot but loses every converter
// privilege: the endgame requeue lift, the rank-2 deep-partial tier, and
// live-work credit in the endgame top-up (run 46870: a 2/4 title held one of
// three slots for five hours across ~19 rounds on zero conversion while four
// untouched titles starved to zero flags; a genuinely converting title — the
// same run's other intranet — never trips this fuse because every banked
// flag resets the streak).
func (e *Engine) stalledTitle(title string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.zeroStreak[title] >= e.flagStallPasses()
}

// notePassBoundary records one pass boundary (a goal stopped, a requeue
// offered) and updates the zero-delta streak. Idempotent per stopped goal:
// endgameTopUp re-offers the same goal every tick, but the pass ended once.
// Returns the platform's current correct count for the title.
func (e *Engine) notePassBoundary(g *fgs.Goal) int {
	cur := 0
	if e.FlagProgress != nil {
		if c, _, ok := e.FlagProgress(g.Title); ok {
			cur = c
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.passCounted[g.ID] {
		return cur
	}
	e.passCounted[g.ID] = true
	if cur > e.passBase[g.Title] {
		e.zeroStreak[g.Title] = 0 // new flags: still a converter
	} else {
		e.zeroStreak[g.Title]++
		if e.zeroStreak[g.Title] >= e.flagStallPasses() {
			e.log.Info("requeue: banked partial stalled — converter privileges suspended",
				"title", g.Title, "zero_delta_passes", e.zeroStreak[g.Title], "banked", cur)
		}
	}
	e.passBase[g.Title] = cur
	return cur
}

// hintTextSeen records a hint text for a title and reports whether the exact
// same text was already seen — the platform's pool-exhausted signature. Each
// view costs score, so a dry pool must stop both the engine's prefetch and
// the noop rescue from paying for repeats.
func (e *Engine) hintTextSeen(title, text string) bool {
	key := strings.TrimSpace(text)
	if len(key) > 256 {
		key = key[:256]
	}
	if key == "" {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.hintSeen[title] == nil {
		e.hintSeen[title] = map[string]bool{}
	}
	if e.hintSeen[title][key] {
		return true
	}
	e.hintSeen[title][key] = true
	return false
}

// hintDryTitle reports whether the title's hint pool is exhausted (a repeat
// text was already pulled).
func (e *Engine) hintDryTitle(title string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.hintDry[title]
}

// endgameRank scores goals for the harvest window on title-completion
// economics: one-flag-from-done (4) > untouched titles of ANY flag count
// (3) > worked zero-flag singles and deep partials (2) > worked zero-flag multis
// (1) > everything else (0). Run 43574: ranking every banked partial
// top-tier let the stuck 2/4 pair hold the fleet's slots through a
// zero-flag final half hour while ~39 untouched titles waited. Run 43759:
// an untouched MULTI was swallowed by the zero-multi case — a proven
// converter sat at rank 1 below the regrinds it outranked in value; the
// untouched check now precedes the zero-multi case so fresh first passes
// (the cheapest unknown in the fleet) outrank worked regrinds regardless
// of flag count.
func (e *Engine) endgameRank(goals []fgs.Goal) map[string]int {
	rank := make(map[string]int, len(goals))
	if e.FlagProgress == nil {
		return rank
	}
	for _, g := range goals {
		cur, total, ok := e.FlagProgress(g.Title)
		if !ok {
			continue
		}
		switch {
		case cur > 0 && total-cur == 1:
			// One flag from title completion — the cheapest conversion in
			// the fleet, worth a slot before anything else. Stalled or not:
			// a single remaining flag is one bounded attempt away, and the
			// stall fuse still caps its requeue count.
			rank[g.ID] = 4
		case cur > 0 && cur < total && e.stalledTitle(g.Title):
			// STALLED deep partial: FlagStallPasses boundaries without a new
			// flag. It keeps the right to idle slots but no longer outranks
			// fresh unknowns — run 46870's 2/4 siege outlasted four untouched
			// titles that all died flagless with hints delivered mid-derivation.
			rank[g.ID] = 1
		case cur > 0 && cur < total:
			rank[g.ID] = 2 // deep partial: ≥2 flags still missing — full siege work per flag
		case !e.titleTouched(g.Title):
			// Never-worked title of ANY flag count: a fresh first pass is
			// the cheapest unknown in the fleet — it beats sieging a deep
			// partial and beats regrinding a worked zero-multi (run 43574:
			// b-01/b-03 at 2/4 monopolized the top slots through a
			// zero-flag final half hour while 39 untouched titles waited;
			// run 43759: untouched b-03 — a 16-minute 0→4 converter once
			// fed at t+246m — was swallowed by the zero-multi case below
			// and ranked UNDER the deep partials, so it never saw a
			// container for four hours while slower conversions rotated).
			// Flag state is checked first on purpose: a banked title has
			// been worked even if firstTouch memory was lost to an engine
			// restart.
			rank[g.ID] = 3
		case total == 1 && cur == 0:
			// A previously attempted single-flag title that produced no flag
			// still gets a bounded endgame retry. Runs 44913→45035 regressed
			// several single-flag titles, so leaving worked singles at rank 0
			// meant they could never recover after first-pass breadth was done.
			rank[g.ID] = 2
		case total > 1 && cur == 0:
			// WORKED multi-flag title with nothing banked — the title only
			// completes when ALL flags land, so endgame slots go to it only
			// after fresh first passes (run 43065: zero-flag regrinds held
			// slots while single-flag titles converted the moment they
			// were fed; untouched multis now rank 3 above).
			rank[g.ID] = 1
		}
	}
	return rank
}

// endgameOrder is the shared comparator for EVERY endgame allocation path —
// both the tick's active-goal schedule order and endgameTopUp's mint queue.
// Rank tier first, then fewer requeues already spent (a fresh second look
// beats an nth helping of a repeatedly-failed siege), then banked progress
// (a proven converter still outranks a zero-flag dud among equals — run
// 42838), then creation order via the stable sort.
//
// Run 46418: the tick's endgame sort carried ONLY the rank tier, falling
// back to creation order — and every budget stop mints a fresh goal with a
// NEW created_at, so a starving title loses its queue position each time it
// churns while an incumbent reclaiming its just-freed slot stays first. The
// endgame window then fed c-09 FIVE consecutive 30-minute blocks and b-02/
// a-14 three each (305 of ~369 slot-minutes, zero flags) while a-18, c-02
// and e2-04 — one pass spent each — got nothing until the death line.
// requeuesSpent is churn-invariant (it only grows), which is exactly the
// property the creation-order tiebreak lacked.
func (e *Engine) endgameOrder(goals []fgs.Goal, rank map[string]int) func(i, j int) bool {
	banked := func(g fgs.Goal) int {
		if e.FlagProgress == nil {
			return 0
		}
		cur, _, ok := e.FlagProgress(g.Title)
		if ok && cur > 0 {
			return 0 // proven converter
		}
		return 1 // zero-flag dud
	}
	e.mu.Lock()
	requeuesSpent := make(map[string]int, len(goals))
	for _, g := range goals {
		requeuesSpent[g.Title] = e.requeues[g.Title]
	}
	e.mu.Unlock()
	return func(i, j int) bool {
		a, b := goals[i], goals[j]
		if rank[a.ID] != rank[b.ID] {
			return rank[a.ID] > rank[b.ID]
		}
		if requeuesSpent[a.Title] != requeuesSpent[b.Title] {
			return requeuesSpent[a.Title] < requeuesSpent[b.Title]
		}
		return banked(a) < banked(b)
	}
}

// requeuePass2 immediately recreates a just-stopped goal for its second
// pass. The pass-2 goal must yield to untouched first-pass challenges in
// the pre-endgame first-touch sort — it gets that by marking its title
// touched at creation (an ID-keyed fairness signal would see a fresh ID and
// front-run the tail; run 42778 did exactly that). Run 41925 proved a
// drain-gated requeue never fires on a 63-challenge queue — the first pass
// alone outlives the run — so the requeue must be immediate. One requeue
// per title; a goal whose second pass also exhausts its budget stays
// stopped for good.
func (e *Engine) requeuePass2(ctx context.Context, g *fgs.Goal) (*fgs.Goal, bool) {
	// Up to two requeues: pass-2 continues the ledger, pass-3 is the last
	// fresh look for challenges that need it (42176: the hardest tier was
	// still mid-derivation when pass-2 died to infra churn).
	//
	// Zero-progress titles earn ONE requeue, not two: a dud's pass-2/3
	// re-buys recon the ledger already ruled out, and run 42416 burned
	// whole slots on it (c-03/a-05 60m each in hour one; 42778's f2-01
	// took a second 36m helping with three wrong submits). A title with
	// banked flags keeps both retries — its pass-2 is conversion, not
	// exploration (42361: b-01 killed at 2/4 with the third in reach).
	const maxRequeues = 2
	const endgameMaxRequeues = 8
	// Zero-progress titles stay fuse-limited even in the harvest window:
	// the endgame lift exists for converters (42838), but an unbanked dud
	// re-minted to 8 passes is the 43574 shape — three regrind passes
	// held half the fleet for the final half hour with zero return. Five,
	// not three, since v20's rank demotes zero-flag multis below every
	// untouched single (43633: c-08's ID brute stood at 2000/10000 with
	// the winning primitive in hand when the 3-fuse blew — the extra
	// passes can no longer starve breadth, they only fill idle slots).
	const endgameZeroMaxRequeues = 5
	// Solved challenges never re-enter the queue — not via budget stops,
	// not via the endgame top-up. A completed title that requeues burns a
	// container cycle and a pass on work the platform has already paid
	// for, exactly the slot-starvation shape the fairness sort exists to
	// prevent.
	if e.challengeComplete(g.Title) {
		return nil, false
	}
	// Zero-delta stall bookkeeping happens at every pass boundary, declined
	// or not — the pass is over either way. It must precede the maxFor logic
	// below: a stalled banked partial loses its converter exemptions here.
	cur := e.notePassBoundary(g)
	stalled := cur > 0 && e.stalledTitle(g.Title)
	// Fresh-meat yield: a zero-progress title's regrind pass must never
	// re-hoard a slot while an untouched title is still waiting for its
	// first container. Run 43759: f2-01 burned SIX zero-flag passes and
	// e2-04 five, each stop→remint inheriting the still-warm container
	// before the release completed, while untouched b-03 — a 16-minute
	// 0→4 converter once actually fed — waited four hours. The fuse is
	// not consumed by declining: when the untouched tail drains (or is
	// itself fed), the next stop re-mints normally and the endgame
	// top-up re-feeds what this guard deferred.
	if e.FlagProgress != nil {
		if cur, _, ok := e.FlagProgress(g.Title); ok && cur == 0 && e.untouchedWaiting(ctx, g.Title) {
			e.log.Info("requeue: zero-flag pass yields its slot to the untouched tail", "title", g.Title)
			return nil, false
		}
	}
	maxFor := maxRequeues
	banked := e.bankedTitle(g.Title)
	if e.FlagProgress != nil {
		if cur, _, ok := e.FlagProgress(g.Title); ok && cur == 0 {
			maxFor = 1
		}
	}
	if e.inEndgame() {
		// Harvest-window lift (run 42838: hour-5 slot utilization collapsed
		// to 1.17/3 because every title had burned its requeue cap — the
		// queue emptied while partials sat stopped). An idle endgame slot is
		// worth exactly zero — but the lift is for converters: banked
		// titles get the full fuse, unbanked ones a short one — and a
		// STALLED banked partial (FlagStallPasses zero-delta boundaries)
		// is no longer a converter: it gets the short fuse too, and the
		// rank demotion below puts fresh unknowns ahead of it in the mint
		// queue (run 46870: b-01's eleventh hour of zero-conversion siege
		// outranked four never-touched titles that all died at the bell
		// with hints delivered and derivations mid-flight).
		if banked && !stalled {
			maxFor = endgameMaxRequeues
		} else {
			maxFor = endgameZeroMaxRequeues
		}
	} else if stalled && banked {
		// Mid-run a stalled partial behaves like an unbanked dud: its
		// re-buys are exploration now, not conversion, and exploration is
		// fuse-limited to one.
		maxFor = 1
	}
	if e.cfg.Runtime.RunDeadline <= 0 || ctx.Err() != nil {
		return nil, false
	}
	e.mu.Lock()
	done := e.requeues[g.Title]
	e.mu.Unlock()
	if done >= maxFor {
		return nil, false
	}
	if e.now().Add(10 * time.Minute).After(e.startedAt.Add(e.cfg.Runtime.RunDeadline.D())) {
		return nil, false // too late for a meaningful another pass
	}
	ng, err := e.store.CreateGoal(ctx, g.Title, g.Origin, g.Objective)
	if err != nil {
		e.log.Error("requeue: create goal", "title", g.Title, "err", err)
		return nil, false
	}
	e.mu.Lock()
	e.requeuedGoal[ng.ID] = true
	e.mu.Unlock()
	pass := done + 2
	if _, err := e.store.AddHumanFact(ctx, ng.ID,
		fmt.Sprintf("此题进入第 %d 遍进攻:前面每一遍的完整过程与结论都已写入 attack/ 目录下本题的 work.md 台账。开局第一动作是读台账(及 attack/notes.md),只做台账里标记为【未测】或【差一步】的假设,严禁从零重扫已排除的方向。止损阀:若台账的主攻方向已经连续两遍零新旗(平台 correct_flag_count 未涨),本遍必须换一条全新解法路线——重新侦察攻击面、换工具链(如静态反汇编推导↔小解空间约束枚举↔动态调试互换)、换数学框架;换路线不是重复劳动而是止损,严禁把下一遍继续押在连续零产出的主攻线上,原方向只保留台账结论不投入新墙钟。台账增量落盘:每完成一个里程碑或每约 5 分钟,立即把新结论/新原语/下一步计划写进 work.md,绝不留到收尾——墙钟随时会杀掉本步,被杀时断点必须已经在台账里,下一遍直接从断点续打。完成率优先于分值:上一遍没有新 flag 进账(平台 correct_flag_count 未增长)且台账主攻面已穷尽时,本遍开局拉下一个 hint 按其定向进攻;此后每条 hint 必须隔≥20 分钟且上一条 hint 指向的方向已打到有结论——没打完上一条 hint 就不许拉下一条,hint 是弹药不是侦察。多 flag 题拿到任何一个 flag 立即提交,然后继续下一个攻击面,完成标准是平台 is_completed=true(correct_flag_count=flag_count),拿到一个 flag 绝不等于解完。flag 候选一旦在手,当轮立即提交,不要留到下一轮。", pass),
		"engine:pass2"); err != nil {
		e.log.Error("requeue: seed fact", "goal", ng.ID, "err", err)
	}
	// Flag-state fact: scheduling knows the banked count — the agent must
	// too. Run 43574 (b-01, 4 flags): pass-2 re-derived an already-banked
	// flag and only learned it from the platform's "duplicate" answer, so
	// wall clock went to re-finding what was already paid for.
	if e.FlagProgress != nil {
		if cur, total, ok := e.FlagProgress(g.Title); ok && cur > 0 && cur < total {
			if _, err := e.store.AddHumanFact(ctx, ng.ID,
				fmt.Sprintf("平台旗情(以此为准):本题 correct_flag_count=%d / flag_count=%d——这 %d 个 flag 已入库计分,重复提交已入库的旗平台只回 duplicate、零收益,严禁重推已入库的攻击面。本遍的全部墙钟只打缺失的 %d 个旗;已入库旗的具体旗面若台账有记录以台账为准,台账缺失时以平台 duplicate 回执为准。", cur, total, cur, total-cur),
				"engine:flagstate"); err != nil {
				e.log.Error("requeue: flag-state fact write failed", "goal", ng.ID, "err", err)
			}
		}
	}
	// Hint pre-seed: this title earns a fresh pass precisely because the
	// last one stalled. If the platform hint was never pulled for the
	// TITLE (rescue is one-shot per goal and passes mint fresh goal IDs),
	// fetch it now so the pass opens aimed at the hint's direction
	// instead of rediscovering the same dead ends — the hint's cost is
	// score, not completion, and the run's target is completion rate.
	// A dry pool changes the arithmetic: a repeat text costs score and
	// carries zero information, so the pull is skipped and the fact says
	// so — the pass must not burn its own hint budget either.
	if e.NoopRescue != nil {
		e.mu.Lock()
		seen := e.rescuedTitle[g.Title]
		dry := e.hintDry[g.Title]
		e.rescuedTitle[g.Title] = true
		e.mu.Unlock()
		if !seen && !dry {
			if hint, ok := e.NoopRescue(ctx, g.ID); ok && strings.TrimSpace(hint) != "" {
				if e.hintTextSeen(g.Title, hint) {
					e.mu.Lock()
					e.hintDry[g.Title] = true
					e.mu.Unlock()
					if _, err := e.store.AddHumanFact(ctx, ng.ID,
						"平台 hint 池已尽:最新一发 hint 与此前完全同文(平台对重复拉取照常扣分、零新信息)。本遍及后续遍严禁再对本题拉任何 hint;把池尽结论写进台账,火力全部走自有推导。",
						"engine:hintdry"); err != nil {
						e.log.Error("requeue: hint-dry fact write failed", "goal", ng.ID, "err", err)
					}
					e.log.Warn("requeue: hint pool exhausted (repeat text) — pulls disabled for title", "title", g.Title, "pass", pass)
				} else if _, err := e.store.AddHint(ctx, ng.ID, hint, fgs.ActorEngine); err != nil {
					e.log.Error("requeue: hint seed write failed", "goal", ng.ID, "err", err)
				} else {
					e.log.Info("requeue: platform hint seeded into fresh pass", "title", g.Title, "pass", pass)
				}
			}
		}
	}
	e.mu.Lock()
	e.requeues[g.Title] = done + 1
	// A retry pass is not a first touch: the title has already had its
	// turn, so the fresh goal ID must not front-run untouched titles in
	// the first-touch sort (run 42778: f2-01 pass-2 did exactly that).
	e.firstTouch[g.Title] = true
	e.mu.Unlock()
	e.log.Info("requeue: goal requeued for another pass", "title", g.Title, "goal", ng.ID, "pass", pass)
	return ng, true
}

func (e *Engine) scheduleGoal(ctx context.Context, goalID string) {
	// Outage: the model path is dead — no claims, no Decide rounds, no
	// bootstrap declares (ClaimNextStep burns an attempt, and a verdict
	// minted by a dying gateway is graph churn, not intel). The tick-path
	// runtime probe reopens the fleet on the first successful turn.
	if e.runtimeDead() {
		return
	}
	// Budget first: an exhausted goal must not spend another Decide round
	// declaring "promising" steps it will never get to run.
	if over, why := e.goalOverBudget(ctx, goalID); over {
		e.stopGoalForBudget(ctx, goalID, why)
		return
	}

	// Claim-time completion guard: the tick's sweep retires solved titles
	// once per tick, but a flag landing between sweep and schedule (or via
	// any non-tick claim path) must not buy this goal another round — a
	// completed challenge pays nothing for more work. Same semantics as
	// sweepCompleted: stop the goal, free the container, let an in-flight
	// step land naturally.
	if g, err := e.store.GetGoal(ctx, goalID); err == nil && e.challengeComplete(g.Title) {
		if err := e.store.SetGoalStatus(ctx, goalID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
			e.log.Error("claim-time complete guard: set status", "goal", goalID, "err", err)
		} else {
			e.releaseStoppedContainer(goalID)
			e.log.Info("challenge complete: claim-time retire", "goal", goalID, "title", g.Title)
		}
		return
	}

	// Runner breaker: a runtime that keeps dying must not eat attempt
	// budgets — wait out the cooldown with everything left pending.
	if e.breakerOpen() {
		return
	}

	e.mu.Lock()
	snap, hasSnap := e.snapshot[goalID]
	deciding := e.deciding != ""
	e.mu.Unlock()

	// Bootstrap: a brand-new goal with no steps skips its first Decide
	// round — the engine itself declares the configured direct-attack step.
	// Easy objectives then cost one Execute pass instead of the full
	// Decide→decompose→Execute cycle, and when the direct attack fails its
	// finding is exactly the intel Decide needs for a good first split.
	// Requeued pass-2/3 goals are brand-new goals too: their bootstrap step
	// is a one-shot "read the ledger, attack the flagged hypothesis" pass.
	if bs := e.cfg.Runtime.BootstrapStep; bs != "" && !hasSnap {
		if steps, err := e.store.ListSteps(ctx, goalID); err == nil && len(steps) == 0 {
			if _, err := e.store.CreateStep(ctx, goalID, bs, nil, "engine:bootstrap"); err != nil {
				e.log.Error("bootstrap: create step", "goal", goalID, "err", err)
			} else {
				e.log.Info("bootstrap: direct-attack step declared", "goal", goalID)
			}
		}
	}

	// Decide trigger: first round, graph growth, or drained steps. Decide
	// is globally serial — one round across all goals at a time.
	if !deciding {
		if trigger, why := e.decideTrigger(ctx, goalID, snap, hasSnap); trigger {
			e.startDecide(ctx, goalID, why)
		}
	}

	// Execute: keep claiming while budget remains.
	for {
		e.mu.Lock()
		if e.running >= e.cfg.Runtime.MaxConcurrentSteps {
			e.mu.Unlock()
			return
		}
		e.mu.Unlock()
		if e.StepGate != nil && !e.StepGate(ctx, goalID) {
			return // no slot for this goal's challenge; steps stay pending
		}
		step, err := e.store.ClaimNextStep(ctx, goalID, "zhulongx")
		if err != nil {
			if !errors.Is(err, store.ErrNothingToClaim) && !errors.Is(err, store.ErrGoalNotActive) {
				e.log.Error("claim step", "goal", goalID, "err", err)
			}
			return
		}
		e.mu.Lock()
		e.running++
		firstClaimed := false
		if _, ok := e.firstClaim[goalID]; !ok {
			e.firstClaim[goalID] = e.now()
			firstClaimed = true
		}
		e.mu.Unlock()
		if firstClaimed {
			// Capture the flag baseline for the budget refuel: what the
			// platform credited before this pass began.
			//
			// firstTouch is deliberately NOT set here (run 46196: e3-02's
			// only step ever claimed was a 27-second 409 → WAITING_SLOT
			// deferral; the claim-time mark made the title read "worked"
			// forever, so it lost the first-touch sort and the endgame's
			// never-touched rank to titles with real work — and never saw a
			// container all run). "Touched" now means a step FINISHED with
			// real output (see markTitleWorked); a slot-race deferral does
			// not burn the fairness signal.
			if e.FlagProgress != nil {
				if g, err := e.store.GetGoal(ctx, goalID); err == nil {
					if cur, _, ok := e.FlagProgress(g.Title); ok {
						e.mu.Lock()
						e.flagBase[goalID] = cur
						e.mu.Unlock()
					}
				}
			}
		}
		e.wg.Add(1)
		go func(st *stepRef) {
			defer e.wg.Done()
			// The concurrency slot frees on EVERY exit path — a panic in
			// executeStep must not leak it (a leaked running count wedges
			// every future claim) nor kill the whole engine.
			defer func() {
				e.mu.Lock()
				e.running--
				e.mu.Unlock()
			}()
			defer func() {
				if r := recover(); r != nil {
					e.log.Error("execute: panic recovered — step returned for retry", "goal", goalID, "step", st.id, "panic", r)
					dctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cancel()
					e.failStep(dctx, goalID, st.id, fmt.Sprintf("panic: %v", r), true)
				}
			}()
			e.executeStep(ctx, goalID, st.id)
		}(&stepRef{step.ID})
	}
}

type stepRef struct{ id string }

// goalOverBudget reports whether the goal has exhausted GoalStepBudget or
// GoalWallBudget. A goal with a step still in flight is never over budget
// here: the stop must not race the executor's finish write.
func (e *Engine) goalOverBudget(ctx context.Context, goalID string) (bool, string) {
	// Outage freeze: a dead runtime must not stop goals out of budgets the
	// outage itself prevented them from spending (run 43263: three goals
	// wall-stopped at t+280-285 while their steps had hung dead for half of
	// the window, then the fleet drained to silence).
	if e.runtimeDead() {
		return false, ""
	}
	g, err := e.store.GetGoal(ctx, goalID)
	if err != nil {
		return false, ""
	}
	sb, wb := e.stepBudgetFor(g.Title), e.wallBudgetFor(g.Title)
	if sb <= 0 && wb <= 0 {
		return false, ""
	}
	_, running, err := e.store.OpenStepCount(ctx, goalID)
	if err != nil || running > 0 {
		return false, "" // checked again next tick
	}
	if sb > 0 {
		steps, err := e.store.ListSteps(ctx, goalID)
		if err == nil {
			done := 0
			for _, s := range steps {
				if s.Status == fgs.StepDone {
					done++
				}
			}
			e.mu.Lock()
			bonus := e.stepBonus[goalID]
			e.mu.Unlock()
			if done >= sb+bonus {
				// A goal banking flags while draining its steps is
				// mid-harvest, not spent: give the flag refuel a chance
				// to grant more steps before stopping the pass. Grace is
				// deliberately NOT offered here — it extends wall time,
				// which is not what a step-exhausted goal lacks.
				if reason := e.flagRefuel(ctx, goalID); reason != "" {
					e.log.Info("budget: step budget extended", "goal", goalID, "reason", reason)
				} else {
					return true, fmt.Sprintf("step budget exhausted (%d done steps)", done)
				}
			}
		}
	}
	if wb > 0 {
		e.mu.Lock()
		first, ok := e.firstClaim[goalID]
		e.mu.Unlock()
		if ok && e.now().Sub(first) > wb {
			if reason := e.refuelBudget(ctx, goalID, wb); reason != "" {
				e.log.Info("budget: wall budget extended", "goal", goalID, "reason", reason)
			} else if e.StepGate != nil && !e.StepGate(ctx, goalID) {
				// Slot-starvation freeze: the goal is not spending its wall
				// on attack work — it is waiting for a container slot the
				// engine cannot give it. Burning its whole first pass as
				// queue wait killed titles unread (run 46196: e3-02 claimed
				// one 27-second step, got a platform 409, deferred
				// WAITING_SLOT, and aged out its 30m wall in the queue
				// without a single recon request — its title then read
				// "worked" and never got a container). Re-anchor the clock:
				// the goal stays alive and claims the moment a slot frees.
				e.mu.Lock()
				e.firstClaim[goalID] = e.now()
				e.mu.Unlock()
				return false, ""
			} else {
				return true, fmt.Sprintf("wall budget exhausted (%s in flight)", e.now().Sub(first).Round(time.Second))
			}
		}
	}
	return false, ""
}

// refuelBudget gives an expiring WALL budget one more lease when the goal
// has earned it: the flag refuel first, then active grace (the last step
// finished within graceWindow of the deadline — the goal is mid-flow, a
// Decide round between two execute steps, not wedged; one 10-minute
// extension per goal).
//
// Returns the reason when the deadline was pushed, "" when the budget
// stays exhausted.
func (e *Engine) refuelBudget(ctx context.Context, goalID string, wb time.Duration) string {
	const graceWindow = 3 * time.Minute

	if reason := e.flagRefuel(ctx, goalID); reason != "" {
		return reason
	}

	e.mu.Lock()
	last, finished := e.lastFinish[goalID]
	graced := e.graceUsed[goalID]
	e.mu.Unlock()
	if finished && !graced && e.now().Sub(last) <= graceWindow {
		e.mu.Lock()
		e.graceUsed[goalID] = true
		e.firstClaim[goalID] = e.firstClaim[goalID].Add(10 * time.Minute)
		e.mu.Unlock()
		return "active grace: step landed moments before the deadline"
	}
	return ""
}

// flagRefuel re-arms both budgets when the goal's challenge banked a NEW
// correct flag since this pass began (baseline captured at first claim).
// Score landing mid-pass is the hardest progress signal there is. Each
// refuel resets the wall window AND grants FlagStepBonus extra Execute
// steps — refueling the clock alone still let the step cap cut a
// multi-flag intranet mid-harvest (run 43065: seven restarts, 31% of the
// run's slot capacity, four of six flags). FlagRefillMax refuels per goal
// cap it. "" = no refuel (also when no flag progress is wired, so the
// step-exhausted path stays a clean stop for flag-less runs).
func (e *Engine) flagRefuel(ctx context.Context, goalID string) string {
	if e.FlagProgress == nil {
		return ""
	}
	g, err := e.store.GetGoal(ctx, goalID)
	if err != nil {
		return ""
	}
	cur, _, ok := e.FlagProgress(g.Title)
	if !ok {
		return ""
	}
	maxRefills := e.cfg.Runtime.FlagRefillMax
	if maxRefills <= 0 {
		maxRefills = 4
	}
	stepBonus := e.cfg.Runtime.FlagStepBonus
	if stepBonus <= 0 {
		stepBonus = 3
	}
	e.mu.Lock()
	base, seen := e.flagBase[goalID]
	refills := e.flagRefills[goalID]
	e.mu.Unlock()
	if !seen {
		// first observation — record the baseline, judge later
		e.mu.Lock()
		e.flagBase[goalID] = cur
		e.mu.Unlock()
		return ""
	}
	if cur <= base || refills >= maxRefills {
		return ""
	}
	e.mu.Lock()
	e.flagBase[goalID] = cur
	e.flagRefills[goalID] = refills + 1
	e.stepBonus[goalID] += stepBonus
	e.firstClaim[goalID] = e.now() // fresh full window
	e.mu.Unlock()
	return fmt.Sprintf("flag refuel: correct count %d → %d (+%d steps)", base, cur, stepBonus)
}

// harvestFlags scans text that just landed in the graph for concrete
// flag-shaped values and hands each to the submit hook. The model derives
// flags in the strangest places — run 42361's f2-01 computed its full flag
// inside a DECIDE round's step declaration — so every landing site calls
// this. Cheap charset guard keeps brief examples (flag{...}, flag{uuid})
// out.
func (e *Engine) harvestFlags(ctx context.Context, goalID, text string) {
	if e.OnFlagCandidate == nil {
		return
	}
	g, err := e.store.GetGoal(ctx, goalID)
	if err != nil {
		return
	}
	for _, m := range flagPattern.FindAllString(text, 3) {
		e.wg.Add(1)
		go func(flag string) {
			defer e.wg.Done()
			cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			e.OnFlagCandidate(cctx, g.Title, flag)
		}(m)
	}
}

// DASCTF flags are DASCTF{...}-shaped (same charset family); the
// alternation keeps the harvest generic across platforms without matching
// bare brace pairs in prose.
var flagPattern = regexp.MustCompile(`(?i)(?:flag|dasctf)\{[0-9a-z_-]{8,80}\}`)

// stopGoalForBudget stops a zombie goal and requeues it for the second
// pass immediately. Findings stay in the graph; the agent-maintained attack
// ledger on disk is what carries knowledge across the requeue.
func (e *Engine) stopGoalForBudget(ctx context.Context, goalID string, why string) {
	g, err := e.store.GetGoal(ctx, goalID)
	if err != nil {
		return
	}
	if err := e.store.SetGoalStatus(ctx, goalID, fgs.GoalStopped, fgs.ActorEngine); err != nil {
		e.log.Error("budget stop: set status", "goal", goalID, "err", err)
		return
	}
	e.refundSterilePass(goalID, g.Title)
	e.releaseStoppedContainer(goalID)
	e.requeuePass2(ctx, g)
	e.log.Warn("budget: goal stopped, slot released", "goal", goalID, "title", g.Title, "reason", why)
}

// refundSterilePass returns one requeue fuse to a title whose requeued
// pass died without producing any real agent output — every step deferred
// WAITING_SLOT on the slot race (43633: c-04's pass-2/3/4 and c-02's
// pass-3 burned whole passes narrating "max active instances reached"
// with zero attack minutes). One refund per title bounds the loop; a pass
// with a natural report or a deadline-salvaged partial counts as worked
// and keeps its fuse slot.
func (e *Engine) refundSterilePass(goalID, title string) {
	e.mu.Lock()
	wasRequeue := e.requeuedGoal[goalID]
	worked := e.passWorked[goalID]
	refunded := e.sterileRefunded[title]
	delete(e.requeuedGoal, goalID)
	delete(e.passWorked, goalID)
	if wasRequeue && !worked && !refunded && e.requeues[title] > 0 {
		e.requeues[title]--
		e.sterileRefunded[title] = true
		e.mu.Unlock()
		e.log.Info("requeue: sterile pass refunded to the fuse", "goal", goalID, "title", title)
		return
	}
	e.mu.Unlock()
}

// releaseStoppedContainer closes the stopped goal's challenge container off
// the tick path, with retries. The requeued pass-2 goal sits at the back of
// the queue and will not reuse the container for hours; an idle one must
// not hold a slot. A single failed POST used to leak the container for the
// rest of the run (42361: two leaks ≈ a quarter of the fleet's slot
// capacity) — the hook's own ForceRelease is one-shot, so the engine
// retries it. The slot gate's idle sweep remains the backstop.
func (e *Engine) releaseStoppedContainer(goalID string) {
	if e.ReleaseContainer == nil {
		return
	}
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		for _, wait := range e.releaseBackoff {
			if wait > 0 {
				time.Sleep(wait)
			}
			cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			err := e.ReleaseContainer(cctx, goalID)
			cancel()
			if err == nil {
				return
			}
			e.log.Warn("budget: container release failed — retrying", "goal", goalID, "err", err)
		}
		e.log.Error("budget: container release failed after all retries", "goal", goalID)
	}()
}

// decideTrigger: run Decide on first sight,
// when the graph grew since the last Decide, or when no steps remain open.
func (e *Engine) decideTrigger(ctx context.Context, goalID string, prev store.SnapshotCounts, hasPrev bool) (bool, string) {
	cur, err := e.store.Snapshot(ctx, goalID)
	if err != nil {
		e.log.Error("snapshot", "goal", goalID, "err", err)
		return false, ""
	}
	if !hasPrev {
		// A goal that already has steps (engine bootstrap or externally
		// declared) needs no initial round: Decide enters when those steps
		// drain, with real intel instead of a split made at the moment of
		// least information.
		if steps, err := e.store.ListSteps(ctx, goalID); err == nil && len(steps) > 0 {
			if cur.OpenSteps == 0 {
				return true, "steps drained"
			}
			return false, ""
		}
		return true, "initial"
	}
	if cur.Facts > prev.Facts {
		return true, "facts grew"
	}
	if cur.Findings > prev.Findings {
		return true, "findings grew"
	}
	if cur.Hints > prev.Hints {
		return true, "hints grew"
	}
	if cur.OpenSteps == 0 {
		return true, "steps drained"
	}
	return false, ""
}

// startDecide launches the globally serial Decide round in the background.
func (e *Engine) startDecide(ctx context.Context, goalID, why string) {
	e.mu.Lock()
	if e.deciding != "" {
		e.mu.Unlock()
		return
	}
	e.deciding = goalID
	e.mu.Unlock()
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		// A panic in decide must not kill the engine NOR wedge the
		// globally-serial Decide slot forever.
		defer func() {
			if r := recover(); r != nil {
				e.log.Error("decide: panic recovered", "goal", goalID, "panic", r)
			}
			e.mu.Lock()
			e.deciding = ""
			e.mu.Unlock()
		}()
		e.decide(ctx, goalID, why)
	}()
}

// refreshCheckpoint stores the post-Decide snapshot for the next trigger.
func (e *Engine) refreshCheckpoint(ctx context.Context, goalID string) {
	snap, err := e.store.Snapshot(ctx, goalID)
	if err == nil {
		e.mu.Lock()
		e.snapshot[goalID] = snap
		e.mu.Unlock()
	}
}
