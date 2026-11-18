package ctfy

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"zhulongx/internal/pi"
)

// Prompter is the agent seam (satisfied by *pi.Adapter; mocked in tests).
type Prompter interface {
	Prompt(ctx context.Context, message string) (*pi.PromptResult, error)
	Close() error
}

// PrompterFactory launches one fresh agent process per session.
type PrompterFactory func() (Prompter, error)

// modeBudgets holds per-run-mode pacing. Sessions are bounded pi prompts;
// "turns" in the platform contract map to our sessions (soft budget).
type modeBudgets struct {
	sessionTimeout time.Duration
	sessionCap     int // 0 = until another stop condition fires
	maxNoProgress  int
	sleepBetween   time.Duration
}

func budgetsFor(mode string, maxTurns *int) modeBudgets {
	b := modeBudgets{sessionTimeout: 30 * time.Minute, sessionCap: 12, maxNoProgress: 3, sleepBetween: 5 * time.Second}
	switch mode {
	case "qa":
		b.sessionTimeout = 12 * time.Minute
		b.sessionCap = 4
		b.maxNoProgress = 2
	case "defence":
		b.sessionTimeout = 25 * time.Minute
		b.sessionCap = 6
	case "awd":
		b.sessionTimeout = 25 * time.Minute
		b.sessionCap = 0 // the match clock, not a counter, ends an awd run
		b.maxNoProgress = 1 << 30
		b.sleepBetween = 90 * time.Second
	case "engagement":
		b.sessionTimeout = 35 * time.Minute
		b.sessionCap = 20
	}
	if maxTurns != nil && *maxTurns > 0 && (b.sessionCap == 0 || *maxTurns < b.sessionCap) {
		b.sessionCap = *maxTurns
	}
	return b
}

// Driver runs one CTFY dispatch: bounded pi sessions over persistent state
// until the run is done, out of budget, out of progress, or (awd) the
// match clock ends. It never submits on its own — the agent owns every
// platform write, per the per-run README — and it rewrites result.json
// after every session so a crash strands nothing.
type Driver struct {
	env       Env
	task      *Task
	questions []Question
	api       API
	mcp       MCPAPI // MCP tool surface (awd match clock, flag banking); nil = absent
	state     *State
	newPrompt PrompterFactory
	log       *slog.Logger
	now       func() time.Time
	doctrine  string
	readme    string
	budgets   modeBudgets

	failStreak     int
	awdClockChecks int

	// awd live view (synced from platform, throttled)
	match       *awdMatch
	targets     []AWDTarget
	lastAWDSync time.Time
}

// awdMatch is the tick clock of an AWD match (get_awd_match): every tick
// the checker replants flags on every box, so attacks are worth repeating
// per tick and banked values go stale at each rollover.
type awdMatch struct {
	StartsAt    time.Time
	TickSeconds int
	TickCount   int
	EndsAt      time.Time
	CurrentTick int
	Known       bool
}

// NewDriver wires a driver. workDir is the platform working directory; the
// doctrine file is read once (missing = loud startup error, not a silent
// doctrine-free run) and the README re-read per session by Run.
func NewDriver(env Env, task *Task, api API, mcp MCPAPI, factory PrompterFactory, log *slog.Logger, doctrinePath string) (*Driver, error) {
	raw, err := os.ReadFile(filepath.Join(env.WorkDir, "README.md"))
	if err != nil {
		return nil, fmt.Errorf("ctfy: read README.md: %w", err)
	}
	d := &Driver{
		env:       env,
		task:      task,
		questions: append([]Question(nil), task.Questions...),
		api:       api,
		mcp:       mcp,
		newPrompt: factory,
		log:       log,
		now:       time.Now,
		readme:    string(raw),
		budgets:   budgetsFor(task.RunMode, env.MaxTurns),
	}
	if doctrinePath != "" {
		doc, err := os.ReadFile(doctrinePath)
		if err != nil {
			return nil, fmt.Errorf("ctfy: read doctrine: %w", err)
		}
		d.doctrine = string(doc)
	}
	st, err := LoadState(env.WorkDir)
	if err != nil {
		return nil, err
	}
	d.state = st
	return d, nil
}

// State exposes the run state (for final result assembly).
func (d *Driver) State() *State { return d.state }

// StopReason values surfaced in result.json.
const (
	ReasonDone       = "done"
	ReasonBudget     = "budget"
	ReasonNoProgress = "no_progress"
	ReasonMatchOver  = "match_over"
	ReasonInterrupt  = "interrupted"
)

// Run drives the dispatch to completion.
func (d *Driver) Run(ctx context.Context) string {
	d.log.Info("ctfy: dispatch start",
		"mode", d.task.RunMode, "questions", len(d.questions),
		"gated", d.task.GatedQuestions, "sessions_cap", d.budgets.sessionCap,
		"prior_sessions", d.state.Sessions)
	for {
		if d.task.RunMode == "awd" {
			d.awdSync(ctx)
		}
		reason, stop := d.checkStop(ctx)
		if stop {
			d.log.Info("ctfy: dispatch end", "reason", reason, "sessions", d.state.Sessions,
				"solved", len(d.state.Solved))
			return reason
		}
		progressed := d.runSession(ctx)
		if progressed {
			d.failStreak = 0
		} else {
			d.failStreak++
		}
		if err := d.state.Save(d.env.WorkDir); err != nil {
			d.log.Error("ctfy: state save failed", "err", err)
		}
		d.writeSnapshot(progressReason(progressed))
		if d.task.RunMode == "awd" && !d.matchOver() {
			select {
			case <-ctx.Done():
			case <-time.After(d.awdSleep()):
			}
		}
	}
}

// awdSync refreshes the match clock (MCP get_awd_match) and, once per
// container run, the target roster (REST). Throttled to once a minute so a
// fast session loop cannot hammer the shared API budget.
func (d *Driver) awdSync(ctx context.Context) {
	now := d.now()
	if !d.lastAWDSync.IsZero() && now.Sub(d.lastAWDSync) < time.Minute {
		return
	}
	d.lastAWDSync = now
	if d.mcp != nil {
		sctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		m, err := fetchAWDMatch(sctx, d.mcp, d.env.CompetitionID)
		cancel()
		switch {
		case err != nil:
			d.log.Warn("ctfy: awd match sync failed (continuing on prior view)", "err", err)
		case m != nil:
			d.match = m
		}
	}
	if len(d.targets) == 0 && d.api != nil && d.env.CompetitionID != "" {
		sctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		targets, err := d.api.AWDTargets(sctx, d.env.CompetitionID)
		cancel()
		if err != nil {
			d.log.Warn("ctfy: awd targets fetch failed (agent can read them itself)", "err", err)
		} else if len(targets) > 0 {
			d.targets = targets
			d.log.Info("ctfy: awd field mapped", "boxes", len(targets))
		}
	}
}

// awdSleep waits out to the NEXT tick rollover plus a small settle margin:
// fresh flags land at the boundary, so an attack session started just after
// it reaps the new round first. Without a known clock, a fixed cadence.
func (d *Driver) awdSleep() time.Duration {
	m := d.match
	if m == nil || !m.Known || m.TickSeconds <= 0 {
		return d.budgets.sleepBetween
	}
	next := m.StartsAt.Add(time.Duration(m.TickSeconds*(m.CurrentTick+1)) * time.Second)
	wait := next.Sub(d.now()) + 12*time.Second
	if wait < 20*time.Second {
		wait = 20 * time.Second
	}
	if wait > 5*time.Minute {
		wait = 5 * time.Minute
	}
	return wait
}

// awdSessionTimeout sizes one session so the own-box health check recurs
// every few ticks regardless of tick length.
func (d *Driver) awdSessionTimeout() time.Duration {
	m := d.match
	if m == nil || !m.Known || m.TickSeconds <= 0 {
		return d.budgets.sessionTimeout
	}
	t := time.Duration(3*m.TickSeconds) * time.Second
	if t < 4*time.Minute {
		t = 4 * time.Minute
	}
	if t > d.budgets.sessionTimeout {
		t = d.budgets.sessionTimeout
	}
	return t
}

func progressReason(p bool) string {
	if p {
		return "running"
	}
	return "stalled"
}

func (d *Driver) checkStop(ctx context.Context) (string, bool) {
	if ctx.Err() != nil {
		return ReasonInterrupt, true
	}
	if d.task.RunMode == "awd" {
		if d.matchOver() {
			return ReasonMatchOver, true
		}
		return "", false
	}
	if d.allVisibleSolved() {
		// gated challenges may still hide unlocked questions: one refresh
		// before declaring victory
		if d.task.GatedQuestions > 0 && d.refreshQuestions(context.Background()) {
			return "", false
		}
		if d.allVisibleSolved() {
			return ReasonDone, true
		}
	}
	if d.budgets.sessionCap > 0 && d.state.Sessions >= d.budgets.sessionCap {
		return ReasonBudget, true
	}
	if d.state.NoProgress >= d.budgets.maxNoProgress {
		return ReasonNoProgress, true
	}
	return "", false
}

func (d *Driver) allVisibleSolved() bool {
	if len(d.questions) == 0 {
		return false
	}
	for _, q := range d.questions {
		if !d.state.IsSolved(q.ID) {
			return false
		}
	}
	return true
}

func (d *Driver) matchOver() bool {
	if d.state.MatchOver {
		return true
	}
	// Match arithmetic: exiting an awd match early records incomplete, so
	// only trust the computed end well past its boundary.
	if m := d.match; m != nil && m.Known && !m.EndsAt.IsZero() && d.now().After(m.EndsAt.Add(10*time.Minute)) {
		d.state.MatchOver = true
		d.log.Info("ctfy: match clock expired", "ends_at", m.EndsAt.Format(time.RFC3339))
		return true
	}
	if d.task.RunMode != "awd" || d.env.CompetitionID == "" || d.api == nil {
		return false
	}
	// Poll the play clock at a restrained cadence: the request budget is
	// shared across every team in the event.
	d.awdClockChecks++
	if d.awdClockChecks%3 != 1 {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	info, err := d.api.CompetitionState(ctx, d.env.CompetitionID)
	if err != nil {
		return false // advisory only; the agent's match_over remains the backstop
	}
	if !info.PlayOpen && info.NextSessionStartsAt == "" {
		d.state.MatchOver = true
		d.log.Info("ctfy: competition closed (play_open=false, no next session)")
	}
	return d.state.MatchOver
}

// fetchAWDMatch reads the tick clock over MCP (the endpoint documented only
// as a tool name). Returns nil, nil when MCP is absent — unknown clock is a
// normal state, not an error.
func fetchAWDMatch(ctx context.Context, mcp MCPAPI, competitionID string) (*awdMatch, error) {
	if mcp == nil {
		return nil, nil
	}
	text, err := mcp.CallTool(ctx, "get_awd_match", map[string]any{"competition_id": competitionID})
	if err != nil {
		return nil, err
	}
	m := parseAWDMatch(text, time.Now())
	if m == nil {
		return nil, fmt.Errorf("ctfy: get_awd_match carried no recognizable clock")
	}
	return m, nil
}

// parseAWDMatch tolerates the field-name variations a live deployment may
// carry (starts_at/started_at, tick_seconds/round_seconds, …) and missing
// pieces (a clock without tick_count simply has no computed end).
func parseAWDMatch(text string, now time.Time) *awdMatch {
	obj := firstJSONObject(text)
	if obj == nil {
		return nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(obj, &raw); err != nil {
		return nil
	}
	m := &awdMatch{}
	pick := func(names ...string) (json.RawMessage, bool) {
		for _, n := range names {
			if v, ok := raw[n]; ok {
				return v, true
			}
		}
		return nil, false
	}
	if v, ok := pick("starts_at", "started_at", "start_time", "begins_at"); ok {
		m.StartsAt = parseClock(v)
	}
	if v, ok := pick("tick_seconds", "round_seconds", "tick_duration_seconds", "tick_duration"); ok {
		m.TickSeconds = parseInt(v)
	}
	if v, ok := pick("tick_count", "ticks", "rounds", "total_ticks", "round_count"); ok {
		m.TickCount = parseInt(v)
	}
	if v, ok := pick("ends_at", "ends", "end_time"); ok {
		m.EndsAt = parseClock(v)
	}
	if v, ok := pick("current_tick", "current_round", "round"); ok {
		m.CurrentTick = parseInt(v)
	} else if !m.StartsAt.IsZero() && m.TickSeconds > 0 && now.After(m.StartsAt) {
		m.CurrentTick = int(now.Sub(m.StartsAt) / (time.Duration(m.TickSeconds) * time.Second))
	}
	if m.EndsAt.IsZero() && !m.StartsAt.IsZero() && m.TickSeconds > 0 && m.TickCount > 0 {
		m.EndsAt = m.StartsAt.Add(time.Duration(m.TickSeconds*m.TickCount) * time.Second)
	}
	m.Known = !m.StartsAt.IsZero() && m.TickSeconds > 0
	return m
}

// firstJSONObject finds the first balanced {...} in text (MCP text content
// may carry the payload bare or wrapped in prose).
func firstJSONObject(text string) []byte {
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		depth, inStr, esc := 0, false, false
		for j := i; j < len(text); j++ {
			c := text[j]
			if inStr {
				switch {
				case esc:
					esc = false
				case c == '\\':
					esc = true
				case c == '"':
					inStr = false
				}
				continue
			}
			switch c {
			case '"':
				inStr = true
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					return []byte(text[i : j+1])
				}
			}
		}
	}
	return nil
}

// parseClock reads RFC3339 strings or epoch seconds/milliseconds.
func parseClock(v json.RawMessage) time.Time {
	var s string
	if err := json.Unmarshal(v, &s); err == nil {
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
			if t, err := time.Parse(layout, s); err == nil {
				return t
			}
		}
		return time.Time{}
	}
	n := parseInt(v)
	switch {
	case n > 1e12: // milliseconds
		return time.UnixMilli(int64(n))
	case n > 1e9: // seconds
		return time.Unix(int64(n), 0)
	}
	return time.Time{}
}

func parseInt(v json.RawMessage) int {
	var n int
	if err := json.Unmarshal(v, &n); err == nil {
		return n
	}
	var f float64
	if err := json.Unmarshal(v, &f); err == nil {
		return int(f)
	}
	var s string
	if err := json.Unmarshal(v, &s); err == nil {
		if n, err := strconv.Atoi(s); err == nil {
			return n
		}
	}
	return 0
}

// bankFlags submits freshly captured AWD flags (MCP submit_awd_flags) and
// records them with per-round dedupe. The agent also submits per README —
// the driver pass is the safety net that never forgets.
func (d *Driver) bankFlags(ctx context.Context, flags []CapturedFlag) bool {
	if d.task.RunMode != "awd" || len(flags) == 0 {
		return false
	}
	tick := 0
	if m := d.match; m != nil && m.Known {
		tick = m.CurrentTick
	}
	banked := 0
	for _, f := range flags {
		round := f.Round
		if round == 0 {
			round = tick // per-tick values: same value next round is fresh score
		}
		if d.state.HasAWDFlag(f.Value, round) {
			continue
		}
		verdict := "pending"
		if d.mcp != nil {
			verdict = "error"
			sctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			_, err := d.mcp.CallTool(sctx, "submit_awd_flags", map[string]any{
				"competition_id": d.env.CompetitionID,
				"flags":          []string{f.Value},
			})
			cancel()
			if err == nil {
				verdict = "banked"
			} else {
				d.log.Warn("ctfy: flag bank attempt failed (agent-side submission is the backstop)",
					"err", err)
			}
		}
		if d.state.RecordAWDFlag(AWDFlagRecord{Value: f.Value, Host: f.Host, Round: round, At: d.now().UTC(), Verdict: verdict}) {
			banked++
		}
	}
	if banked > 0 {
		d.log.Info("ctfy: awd flags banked", "new", banked, "total", len(d.state.AWDFlags))
	}
	return banked > 0
}

// refreshQuestions re-reads the challenge record and merges newly visible
// questions (gated unlocks). Returns true when something new appeared.
func (d *Driver) refreshQuestions(ctx context.Context) bool {
	if d.api == nil || d.env.ChallengeID == "" {
		return false
	}
	qs, gated, err := d.api.ChallengeRefresh(ctx, d.env.ChallengeID)
	if err != nil {
		d.log.Warn("ctfy: challenge refresh failed", "err", err)
		return false
	}
	known := map[string]bool{}
	for _, q := range d.questions {
		known[q.ID] = true
	}
	added := 0
	for _, q := range qs {
		if !known[q.ID] {
			d.questions = append(d.questions, q)
			added++
		}
	}
	if gated != d.task.GatedQuestions {
		d.task.GatedQuestions = gated
	}
	if added > 0 {
		d.log.Info("ctfy: gated questions unlocked", "added", added, "total", len(d.questions))
	}
	return added > 0
}

// awdView projects the synced match state into the mission's per-session
// display (relative times so the text stays honest for the session's life).
func (d *Driver) awdView() *AWDView {
	if d.task.RunMode != "awd" {
		return nil
	}
	v := &AWDView{Targets: d.targets}
	if m := d.match; m != nil && m.Known {
		v.CurrentTick = m.CurrentTick
		v.TotalTicks = m.TickCount
		v.TickSeconds = m.TickSeconds
		if m.TickSeconds > 0 {
			next := m.StartsAt.Add(time.Duration(m.TickSeconds*(m.CurrentTick+1)) * time.Second)
			if in := next.Sub(d.now()); in > 0 {
				v.NextRolloverIn = in
			}
		}
		if !m.EndsAt.IsZero() {
			if in := m.EndsAt.Sub(d.now()); in > 0 {
				v.MatchEndsIn = in
			}
		}
	}
	return v
}

// runSession launches one bounded pi session over the current mission.
// Returns whether the session carried usable progress.
func (d *Driver) runSession(ctx context.Context) bool {
	runner, err := d.newPrompt()
	if err != nil {
		d.log.Error("ctfy: agent launch failed", "err", err)
		d.state.NoProgress++
		return false
	}
	defer runner.Close()

	mission := BuildMission(d.questions, d.state, MissionOptions{
		Mode:          d.task.RunMode,
		Round:         d.state.Sessions + 1,
		SessionsCap:   d.budgets.sessionCap,
		TargetURL:     d.env.TargetURL,
		TargetInst:    d.env.TargetInstance,
		Endpoints:     d.task.TargetEndpoints,
		Attachments:   d.task.Attachments,
		Scope:         d.task.Scope,
		Rules:         d.task.Rules,
		Deliverable:   d.task.Deliverable,
		CompetitionID: d.env.CompetitionID,
		ChallengeID:   d.env.ChallengeID,
		AWD:           d.awdView(),
		README:        d.readme,
		Doctrine:      d.doctrine,
	})

	timeout := d.budgets.sessionTimeout
	if d.task.RunMode == "awd" {
		timeout = d.awdSessionTimeout()
	}
	sctx, cancel := context.WithTimeout(ctx, timeout)
	start := d.now()
	res, err := runner.Prompt(sctx, mission)
	cancel()
	d.state.Sessions++
	if err != nil {
		d.log.Warn("ctfy: session ended with error",
			"err", err, "elapsed", d.now().Sub(start).Round(time.Second).String())
		d.state.NoProgress++
		return false
	}
	d.state.ToolCalls += res.ToolCalls
	rep, perr := ParseReport(res.Text)
	if perr != nil {
		d.log.Warn("ctfy: session report unparsable",
			"tail", tail(res.Text, 300), "tool_calls", res.ToolCalls)
		d.state.NoProgress++
		return false
	}
	if rep.MatchOver {
		d.state.MatchOver = true
	}
	d.state.Notes = rep.Summary
	progress := false
	for _, s := range rep.Submitted {
		sub := Submission{QuestionID: s.QuestionID, Answer: s.Answer, Verdict: s.Verdict, At: d.now().UTC()}
		if d.state.Record(sub) {
			progress = true
		}
	}
	if d.bankFlags(ctx, rep.Flags) {
		progress = true
	}
	// Gated refresh after every session, not only after correct answers:
	// unlocks can also ride wrong-answer retries platform-side.
	if d.task.GatedQuestions > 0 {
		rctx, rcancel := context.WithTimeout(context.Background(), 20*time.Second)
		d.refreshQuestions(rctx)
		rcancel()
	}
	if !progress {
		// an agent that still sees work is not stalled, just not scoring
		if rep.MoreWork {
			d.state.NoProgress = 0
			d.log.Info("ctfy: session without submissions; agent reports work remains", "summary", oneLine(rep.Summary, 160))
		} else {
			d.state.NoProgress++
			d.log.Info("ctfy: session without submissions", "summary", oneLine(rep.Summary, 160))
		}
	} else {
		d.state.NoProgress = 0
		d.log.Info("ctfy: session progressed",
			"solved", len(d.state.Solved), "submissions", len(rep.Submitted))
	}
	return progress
}

// writeSnapshot refreshes result.json mid-run (crash safety).
func (d *Driver) writeSnapshot(stop string) {
	res := d.buildResult(stop)
	if err := WriteResult(d.env.WorkDir, res); err != nil {
		d.log.Error("ctfy: result snapshot failed", "err", err)
	}
}

// buildResult assembles the §3 rollup from live state.
func (d *Driver) buildResult(stop string) Result {
	answers := map[string]string{}
	for k, v := range d.state.Answers {
		answers[k] = v
	}
	solved := append([]string(nil), d.state.Solved...)
	return Result{
		Answers:       answers,
		Solved:        solved,
		FullySolved:   len(solved) > 0 && len(solved) == len(d.questions),
		Turns:         d.state.Sessions,
		ToolCallsMade: d.state.ToolCalls,
		StopReason:    stop,
		Writeup:       d.state.Notes,
	}
}

// FinalResult is the end-of-run rollup.
func (d *Driver) FinalResult(stop string) Result {
	return d.buildResult(stop)
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
