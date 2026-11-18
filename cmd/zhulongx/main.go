// zhulongx is the CLI entry point: run (scheduler loop), goal, hint, fact,
// status, export, init-config — scheduling and task management in one
// process.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "embed"

	"zhulongx/internal/bench"
	"zhulongx/internal/cfg"
	"zhulongx/internal/dasctf"
	"zhulongx/internal/engine"
	"zhulongx/internal/fgs"
	"zhulongx/internal/store"
)

//go:embed zhulongx.example.yaml
var exampleConfig []byte

const usageText = `zhulongx — Fact/Goal/Step/Finding task engine driven by the Pi agent loop

Usage:
  zhulongx run [--config zhulongx.yaml]            start the scheduler loop
  zhulongx init-config [path]                      write a default config file
  zhulongx goal new --title T --origin O --objective G [--config F]
  zhulongx goal stop|resume|reopen <goalID> [--feedback TEXT] [--config F]
  zhulongx hint add <goalID> --content TEXT [--creator NAME] [--config F]
  zhulongx fact add <goalID> --content TEXT [--creator NAME] [--config F]
  zhulongx status [goalID] [--config F]            graph overview / detail
  zhulongx export <goalID> [--config F]            print graph YAML
  zhulongx audit [goalID] [--config F]             recent audit entries
  zhulongx bench import [--base-url URL] [--config F]  TSecBench: challenges -> goals
  zhulongx bench sync [--base-url URL] [--config F]    TSecBench: reconcile goal states
  zhulongx dasctf import [--config F]                  DASCTF: exercises -> goals
  zhulongx dasctf sync [--config F]                    DASCTF: reconcile goal states

bench auth comes from the environment only: BENCHMARK_BASE_URL (or
--base-url) and BENCHMARK_TOKEN — export both in the shell that runs
zhulongx so the agent's shell inherits them too.

dasctf auth likewise: DASCTF_HOST and DASCTF_ACCESSKEY.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usageText)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun(os.Args[2:])
	case "init-config":
		err = cmdInitConfig(os.Args[2:])
	case "goal":
		err = cmdGoal(os.Args[2:])
	case "hint":
		err = cmdHint(os.Args[2:])
	case "fact":
		err = cmdFact(os.Args[2:])
	case "status":
		err = cmdStatus(os.Args[2:])
	case "export":
		err = cmdExport(os.Args[2:])
	case "audit":
		err = cmdAudit(os.Args[2:])
	case "bench":
		err = cmdBench(os.Args[2:])
	case "dasctf":
		err = cmdDasctf(os.Args[2:])
	default:
		fmt.Fprint(os.Stderr, usageText)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "zhulongx:", err)
		os.Exit(1)
	}
}

// parseMixed parses flags that may appear before or after positional
// arguments (Go's flag package stops at the first positional otherwise).
func parseMixed(fs *flag.FlagSet, args []string) ([]string, error) {
	var positionals []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return positionals, nil
		}
		positionals = append(positionals, args[0])
		args = args[1:]
	}
}

func commonFlags(args []string) (*cfg.Config, []string, error) {
	fs := flag.NewFlagSet("", flag.ContinueOnError)
	configPath := fs.String("config", "zhulongx.yaml", "config file path")
	positionals, err := parseMixed(fs, args)
	if err != nil {
		return nil, nil, err
	}
	c, err := cfg.Load(*configPath)
	if err != nil {
		return nil, nil, err
	}
	return c, positionals, nil
}

func openStore(c *cfg.Config) (*store.Store, error) {
	return store.Open(c.DBPath)
}

func newLogger(level string) *slog.Logger {
	var lv slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv}))
}

func cmdRun(args []string) error {
	c, _, err := commonFlags(args)
	if err != nil {
		return err
	}
	st, err := openStore(c)
	if err != nil {
		return err
	}
	defer st.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log := newLogger(c.LogLevel)
	applyRunDeadlineEnv(c, log)
	e := engine.New(st, c, log, nil)
	wireNoopRescue(e, st, log)
	wireStepGate(e, st, log)
	wireProgressiveImport(ctx, st, log)
	wireDasctf(e, st, log)
	log.Info("zhulongx running", "db", c.DBPath, "pi", c.Pi.Command,
		"run_deadline", c.Runtime.RunDeadline.D().String())
	if err := e.Run(ctx); err != nil {
		return err
	}
	log.Info("zhulongx stopped")
	return nil
}

func cmdInitConfig(args []string) error {
	path := "zhulongx.yaml"
	if len(args) == 1 {
		path = args[0]
	}
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("%s already exists", path)
	}
	return os.WriteFile(path, exampleConfig, 0o644)
}

func cmdGoal(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("goal requires a subcommand: new|stop|resume|reopen")
	}
	switch args[0] {
	case "new":
		fs := flag.NewFlagSet("goal new", flag.ContinueOnError)
		title := fs.String("title", "", "goal title")
		origin := fs.String("origin", "", "background context")
		objective := fs.String("objective", "", "what must be achieved")
		configPath := fs.String("config", "zhulongx.yaml", "config file path")
		if _, err := parseMixed(fs, args[1:]); err != nil {
			return err
		}
		if *title == "" || *origin == "" || *objective == "" {
			return fmt.Errorf("--title, --origin, --objective are required")
		}
		c, err := cfg.Load(*configPath)
		if err != nil {
			return err
		}
		st, err := openStore(c)
		if err != nil {
			return err
		}
		defer st.Close()
		g, err := st.CreateGoal(context.Background(), *title, *origin, *objective)
		if err != nil {
			return err
		}
		fmt.Println(g.ID)
		return nil
	case "stop", "resume":
		if len(args) < 2 {
			return fmt.Errorf("goal %s requires <goalID>", args[0])
		}
		c, _, err := commonFlags(args[2:])
		if err != nil {
			return err
		}
		st, err := openStore(c)
		if err != nil {
			return err
		}
		defer st.Close()
		target := "stopped"
		if args[0] == "resume" {
			target = "active"
		}
		return st.SetGoalStatus(context.Background(), args[1], fgs.GoalStatus(target), fgs.ActorHuman)
	case "reopen":
		fs := flag.NewFlagSet("goal reopen", flag.ContinueOnError)
		feedback := fs.String("feedback", "", "why the goal is reopened")
		creator := fs.String("creator", "human", "who reopens")
		configPath := fs.String("config", "zhulongx.yaml", "config file path")
		if _, err := parseMixed(fs, args[2:]); err != nil {
			return err
		}
		if *feedback == "" {
			return fmt.Errorf("--feedback is required")
		}
		c, err := cfg.Load(*configPath)
		if err != nil {
			return err
		}
		st, err := openStore(c)
		if err != nil {
			return err
		}
		defer st.Close()
		return st.ReopenGoal(context.Background(), args[1], *feedback, *creator)
	default:
		return fmt.Errorf("unknown goal subcommand %q", args[0])
	}
}

func cmdHint(args []string) error {
	if len(args) < 2 || args[0] != "add" {
		return fmt.Errorf("hint add <goalID> --content TEXT [--creator NAME]")
	}
	goalID := args[1]
	fs := flag.NewFlagSet("hint add", flag.ContinueOnError)
	content := fs.String("content", "", "hint text")
	creator := fs.String("creator", "human", "hint author")
	configPath := fs.String("config", "zhulongx.yaml", "config file path")
	if _, err := parseMixed(fs, args[2:]); err != nil {
		return err
	}
	c, err := cfg.Load(*configPath)
	if err != nil {
		return err
	}
	st, err := openStore(c)
	if err != nil {
		return err
	}
	defer st.Close()
	h, err := st.AddHint(context.Background(), goalID, *content, *creator)
	if err != nil {
		return err
	}
	fmt.Println(h.ID)
	return nil
}

func cmdFact(args []string) error {
	if len(args) < 2 || args[0] != "add" {
		return fmt.Errorf("fact add <goalID> --content TEXT [--creator NAME]")
	}
	goalID := args[1]
	fs := flag.NewFlagSet("fact add", flag.ContinueOnError)
	content := fs.String("content", "", "fact text")
	creator := fs.String("creator", "human", "fact author")
	configPath := fs.String("config", "zhulongx.yaml", "config file path")
	if _, err := parseMixed(fs, args[2:]); err != nil {
		return err
	}
	c, err := cfg.Load(*configPath)
	if err != nil {
		return err
	}
	st, err := openStore(c)
	if err != nil {
		return err
	}
	defer st.Close()
	f, err := st.AddHumanFact(context.Background(), goalID, *content, *creator)
	if err != nil {
		return err
	}
	fmt.Println(f.ID)
	return nil
}

func cmdStatus(args []string) error {
	c, positionals, err := commonFlags(args)
	if err != nil {
		return err
	}
	st, err := openStore(c)
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()
	if len(positionals) > 0 {
		return statusDetail(ctx, st, positionals[0])
	}
	goals, err := st.ListGoals(ctx)
	if err != nil {
		return err
	}
	for _, g := range goals {
		snap, _ := st.Snapshot(ctx, g.ID)
		fmt.Printf("%s  %-12s %-30s facts=%d findings=%d steps_open=%d hints=%d\n",
			g.ID, g.Status, truncate(g.Title, 30), snap.Facts, snap.Findings, snap.OpenSteps, snap.Hints)
	}
	return nil
}

func statusDetail(ctx context.Context, st *store.Store, goalID string) error {
	g, err := st.GetGoal(ctx, goalID)
	if err != nil {
		return err
	}
	fmt.Printf("goal %s [%s] %s\n  origin:    %s\n  objective: %s\n",
		g.ID, g.Status, g.Title, g.Origin, g.Objective)
	steps, _ := st.ListSteps(ctx, goalID)
	fmt.Println("steps:")
	for _, s := range steps {
		fmt.Printf("  %s %-8s attempts=%d %s", s.ID, s.Status, s.Attempts, truncate(s.Description, 60))
		if s.FindingID != "" {
			fmt.Printf(" → %s", s.FindingID)
		}
		fmt.Println()
	}
	findings, _ := st.ListFindings(ctx, goalID, false)
	fmt.Println("findings:")
	for _, f := range findings {
		fmt.Printf("  %s %-8s ← %s %s\n", f.ID, f.Status, f.StepID, truncate(f.Content, 60))
	}
	facts, _ := st.ListFacts(ctx, goalID)
	fmt.Println("facts:")
	for _, f := range facts {
		fmt.Printf("  %s %s\n", f.ID, truncate(f.Content, 70))
	}
	return nil
}

func cmdExport(args []string) error {
	c, positionals, err := commonFlags(args)
	if err != nil {
		return err
	}
	if len(positionals) < 1 {
		return fmt.Errorf("export requires <goalID>")
	}
	st, err := openStore(c)
	if err != nil {
		return err
	}
	defer st.Close()
	out, err := st.ExportYAML(context.Background(), positionals[0])
	if err != nil {
		return err
	}
	fmt.Print(out)
	return nil
}

func cmdAudit(args []string) error {
	c, positionals, err := commonFlags(args)
	if err != nil {
		return err
	}
	st, err := openStore(c)
	if err != nil {
		return err
	}
	defer st.Close()
	goalID := ""
	if len(positionals) > 0 {
		goalID = positionals[0]
	}
	entries, err := st.ListAudit(context.Background(), goalID, 100)
	if err != nil {
		return err
	}
	for _, a := range entries {
		fmt.Printf("%d %s %s %s %s\n",
			a.Seq, a.At.Format(time.RFC3339), a.Actor, a.Action, a.Entity)
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

// cmdBench bridges the TSec Benchmark Platform Challenges API: import
// creates one goal per challenge (origin carries the full combat brief),
// sync reconciles platform completion state back into the graph. The
// solving itself runs through the normal run loop: the agent operates
// start/hint/submit/close via curl with BENCHMARK_TOKEN from its
// inherited environment.
func cmdBench(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("bench requires a subcommand: import|sync")
	}
	sub := args[0]
	if sub != "import" && sub != "sync" {
		return fmt.Errorf("unknown bench subcommand %q (want import|sync)", sub)
	}
	fs := flag.NewFlagSet("bench "+sub, flag.ContinueOnError)
	configPath := fs.String("config", "zhulongx.yaml", "config file path")
	baseURL := fs.String("base-url", os.Getenv("BENCHMARK_BASE_URL"),
		"benchmark platform base URL (default: env BENCHMARK_BASE_URL)")
	prioFile := fs.String("priority-file", "",
		"file with unique codes to import first, one per line (# comments)")
	if _, err := parseMixed(fs, args[1:]); err != nil {
		return err
	}
	c, err := cfg.Load(*configPath)
	if err != nil {
		return err
	}
	st, err := openStore(c)
	if err != nil {
		return err
	}
	defer st.Close()
	bc, err := bench.NewClient(*baseURL, os.Getenv("BENCHMARK_TOKEN"))
	if err != nil {
		return err
	}
	ctx := context.Background()
	switch sub {
	case "import":
		priority, err := readPriorityFile(*prioFile)
		if err != nil {
			return err
		}
		if len(priority) > 0 {
			fmt.Printf("bench: %d code(s) from priority file head the queue\n", len(priority))
		}
		n, err := bench.Import(ctx, st, bc, priority)
		if err != nil {
			return err
		}
		fmt.Printf("bench: imported %d new challenge goal(s)\n", n)
		fmt.Println("bench: next — export BENCHMARK_TOKEN in this shell, then `zhulongx run`")
		return nil
	default: // sync
		rep, err := bench.Sync(ctx, st, bc)
		if err != nil {
			return err
		}
		fmt.Printf("bench: sync done — %d completed by platform", len(rep.Completed))
		if len(rep.Completed) > 0 {
			fmt.Println()
			for _, s := range rep.Completed {
				fmt.Printf("  completed %s\n", s)
			}
		} else {
			fmt.Println()
		}
		if rep.InProgress > 0 {
			fmt.Printf("  in progress: %d goal(s)\n", rep.InProgress)
		}
		for _, s := range rep.Mismatched {
			fmt.Printf("  MISMATCH %s — locally completed, platform disagrees; review before trusting\n", s)
		}
		for _, s := range rep.Missing {
			fmt.Printf("  missing  %s — platform no longer lists this challenge\n", s)
		}
		return nil
	}
}

// readPriorityFile loads unique codes (one per line, # comments and blank
// lines ignored) that bench import should put at the head of the queue.
func readPriorityFile(path string) ([]string, error) {
	if path == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("bench: read priority file: %w", err)
	}
	var codes []string
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		codes = append(codes, line)
	}
	return codes, nil
}

// wireNoopRescue arms the benchmark hint rescue when the run is a
// benchmark session (both env vars present). At the noop-guard edge — the
// agent has produced nothing for DecideNoopLimit straight rounds — it
// fetches the platform hint once per goal and writes it as a Hint,
// buying one last guided round instead of a guaranteed zero. Hints cost
// score, so this fires exactly once and only at that edge.
func wireNoopRescue(e *engine.Engine, st *store.Store, log *slog.Logger) {
	base, token := os.Getenv("BENCHMARK_BASE_URL"), os.Getenv("BENCHMARK_TOKEN")
	if base == "" || token == "" {
		return
	}
	bc, err := bench.NewClient(base, token)
	if err != nil {
		log.Warn("bench: noop rescue not armed", "err", err)
		return
	}
	e.NoopRescue = func(ctx context.Context, goalID string) (string, bool) {
		g, err := st.GetGoal(ctx, goalID)
		if err != nil {
			return "", false
		}
		code, ok := bench.CodeOfTitle(g.Title)
		if !ok {
			return "", false // not a benchmark goal
		}
		hint, has, err := bc.Hint(ctx, code)
		if err != nil {
			log.Warn("bench: rescue hint fetch failed", "goal", goalID, "err", err)
			return "", false
		}
		if !has {
			return "", false // platform has no hint for this one
		}
		return hint, true
	}
	log.Info("bench: noop rescue armed (hint at guard edge, once per goal)")
}

// wireStepGate arms the benchmark container-slot gate when the run is a
// benchmark session. The platform allows at most 3 concurrent challenge
// containers per task; the gate keeps slot-less goals out of the agent
// loop entirely (their steps stay pending at zero model cost) instead of
// letting them burn turns polling for a slot, and reaps containers leaked
// by terminal goals.
// applyRunDeadlineEnv lets the operator stretch or shrink the engine's
// internal stop-watch without rebuilding the image. managed.yaml pins
// run_deadline for the TSecBench 6h window; other sets run longer (run
// 44048, bctf-2026: platform window 10.3h, engine stopped at its baked
// 350m deadline and left 4.4 gifted hours unused). RUN_DEADLINE=10h30m
// style values override the file.
func applyRunDeadlineEnv(c *cfg.Config, log *slog.Logger) {
	v := os.Getenv("RUN_DEADLINE")
	if v == "" {
		return
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		log.Warn("RUN_DEADLINE ignored (want e.g. 10h30m)", "value", v, "err", err)
		return
	}
	c.Runtime.RunDeadline = cfg.Duration(d)
	log.Info("RUN_DEADLINE override active", "run_deadline", d.String())
}

// wireProgressiveImport re-runs the bench import on a slow cadence so
// challenges the platform adds mid-run join the queue at the tail within
// minutes of appearing. Import at t=0 is one-shot and Sync never backfills:
// on progressively-unlocked sets that strands late challenges with no goal
// at all (run 44048: bctf2026-26/37/39 never got a container in 6h while
// 37 siblings did). On fixed sets the diff is empty and each tick costs one
// list fetch.
func wireProgressiveImport(ctx context.Context, st *store.Store, log *slog.Logger) {
	base, token := os.Getenv("BENCHMARK_BASE_URL"), os.Getenv("BENCHMARK_TOKEN")
	if base == "" || token == "" {
		return
	}
	bc, err := bench.NewClient(base, token)
	if err != nil {
		log.Warn("bench: progressive import not armed", "err", err)
		return
	}
	go func() {
		t := time.NewTicker(15 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				n, err := bench.Import(ctx, st, bc, nil)
				if err != nil {
					log.Warn("bench: progressive import tick failed", "err", err)
					continue
				}
				if n > 0 {
					log.Info("bench: progressive import added late challenges", "created", n)
				}
			}
		}
	}()
	log.Info("bench: progressive import armed (15m cadence)")
}

func wireStepGate(e *engine.Engine, st *store.Store, log *slog.Logger) {
	base, token := os.Getenv("BENCHMARK_BASE_URL"), os.Getenv("BENCHMARK_TOKEN")
	if base == "" || token == "" {
		return
	}
	bc, err := bench.NewClient(base, token)
	if err != nil {
		log.Warn("bench: step gate not armed", "err", err)
		return
	}
	const maxContainers = 3
	gate := bench.NewSlotGate(st, bc, maxContainers, log)
	e.StepGate = gate.Allow
	e.ReleaseContainer = func(ctx context.Context, goalID string) error {
		goal, err := st.GetGoal(ctx, goalID)
		if err != nil {
			return fmt.Errorf("release: load goal: %w", err)
		}
		code, ok := bench.CodeOfTitle(goal.Title)
		if !ok {
			return nil // not a benchmark goal: nothing to release
		}
		return gate.ForceRelease(ctx, code)
	}
	e.FlagProgress = func(title string) (int, int, bool) {
		code, ok := bench.CodeOfTitle(title)
		if !ok {
			return 0, 0, false
		}
		return gate.Progress(code)
	}
	wireFlagFastLane(e, bc, gate, log)
	log.Info("bench: step gate armed (slot-paced execute, max concurrent containers)", "max", maxContainers)
}

// wireFlagFastLane connects the engine's flag harvest to the platform
// submit API. Every flag-shaped string the engine sees land in the graph is
// submitted immediately — once per unique value — so a derived flag never
// waits for a future step to carry it (run 42361: f2-01's fully computed
// flag sat unsubmitted for the run's final 54 minutes). Duplicates are
// answered by the platform anyway (409 duplicate), but not asking twice
// keeps the submit log honest.
//
// A value that lands while its challenge has no live container is DEFERRED,
// not dropped and not fired blind: the platform judges a submission against
// the current instance, so a submit against a stopped container scores
// wrong (run 42416: the agent's own banked value, 7s after close), but the
// value itself must survive until the container is live again (run 42778's
// first cut of this gate marked the value submitted BEFORE deciding, so a
// deferred flag was lost forever). Deferred values flush on every fresh
// gate snapshot and on every later candidate arrival.
func wireFlagFastLane(e *engine.Engine, bc *bench.Client, gate *bench.SlotGate, log *slog.Logger) {
	var mu sync.Mutex
	submitted := map[string]bool{}
	pending := map[string]map[string]bool{} // code → values deferred while no container was live

	submit := func(ctx context.Context, code, flag string) {
		res, err := bc.Submit(ctx, code, flag)
		var ae *bench.APIError
		switch {
		case errors.As(err, &ae) && ae.Code == bench.CodeDuplicate:
			log.Info("bench: fast-lane flag already banked by the agent", "code", code)
		case err != nil:
			log.Warn("bench: fast-lane submit failed", "code", code, "err", err)
		case res.Correct:
			// The response carries the scoring pipeline's own progress count —
			// feed it to the gate immediately so scheduling (completion sweep,
			// endgame ranking, stall accounting) never reads a lagging list.
			gate.SetSubmitProgress(code, res.CorrectFlagCount, res.TotalFlagCount)
			log.Info("bench: fast-lane FLAG BANKED", "code", code, "progress", fmt.Sprintf("%d/%d", res.CorrectFlagCount, res.TotalFlagCount))
		default:
			log.Info("bench: fast-lane submit not correct", "code", code)
		}
	}

	// flushPending drains every pending value whose challenge is now
	// submittable. Codes are snapshotted first and skipped — never
	// re-scanned — when still not submittable: a re-scan loop re-selects
	// the same deferred entry forever and livelocks the pump (caught as a
	// 10-minute test timeout while the only pending code could never go
	// live).
	flushPending := func(ctx context.Context) {
		mu.Lock()
		codes := make([]string, 0, len(pending))
		for c := range pending {
			codes = append(codes, c)
		}
		mu.Unlock()
		for _, code := range codes {
			for {
				if !gate.Submittable(code) {
					break // stays deferred until a later snapshot
				}
				mu.Lock()
				var flag string
				for f := range pending[code] {
					flag = f
					break
				}
				if flag == "" {
					mu.Unlock()
					break
				}
				delete(pending[code], flag)
				if len(pending[code]) == 0 {
					delete(pending, code)
				}
				submitted[flag] = true
				mu.Unlock()
				submit(ctx, code, flag)
			}
		}
	}

	e.OnFlagCandidate = func(ctx context.Context, title, flag string) {
		code, ok := bench.CodeOfTitle(title)
		if !ok {
			return
		}
		flushPending(ctx) // every arrival pumps the deferred queue
		mu.Lock()
		if submitted[flag] {
			mu.Unlock()
			return
		}
		mu.Unlock()
		// Decide on a live snapshot: the cached one may predate a close by
		// up to pollTTL, and Submittable never refreshes on its own.
		gate.Refresh(ctx)
		if !gate.Submittable(code) {
			mu.Lock()
			if pending[code] == nil {
				pending[code] = map[string]bool{}
			}
			pending[code][flag] = true
			mu.Unlock()
			log.Info("bench: fast-lane defers flag until its container is live", "code", code)
			return
		}
		mu.Lock()
		submitted[flag] = true
		mu.Unlock()
		submit(ctx, code, flag)
	}

	// Fresh snapshots (engine ticks poll the platform) pump deferred flags.
	gate.OnSnapshot(func(ctx context.Context) { flushPending(ctx) })
}

// readPriorityIDs loads exercise IDs (one per line, # comments and blank
// lines ignored) that dasctf import should put at the head of the queue.
func readPriorityIDs(path string) ([]int, error) {
	if path == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("dasctf: read priority file: %w", err)
	}
	var ids []int
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		id, err := strconv.Atoi(line)
		if err != nil {
			return nil, fmt.Errorf("dasctf: priority file: %q is not an exercise id", line)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// cmdDasctf bridges the DASCTF slab-match Agent API: import creates one
// goal per open exercise (origin carries the full combat brief), sync
// reconciles platform hasSolved state back into the graph.
func cmdDasctf(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("dasctf requires a subcommand: import|sync")
	}
	sub := args[0]
	if sub != "import" && sub != "sync" {
		return fmt.Errorf("unknown dasctf subcommand %q (want import|sync)", sub)
	}
	fs := flag.NewFlagSet("dasctf "+sub, flag.ContinueOnError)
	configPath := fs.String("config", "zhulongx.yaml", "config file path")
	prioFile := fs.String("priority-file", "", "file with exercise ids to import first, one per line (# comments)")
	if _, err := parseMixed(fs, args[1:]); err != nil {
		return err
	}
	c, err := cfg.Load(*configPath)
	if err != nil {
		return err
	}
	st, err := openStore(c)
	if err != nil {
		return err
	}
	defer st.Close()
	dc, err := dasctf.NewClient(os.Getenv("DASCTF_HOST"), os.Getenv("DASCTF_ACCESSKEY"))
	if err != nil {
		return err
	}
	ctx := context.Background()
	switch sub {
	case "import":
		priority, err := readPriorityIDs(*prioFile)
		if err != nil {
			return err
		}
		if len(priority) > 0 {
			fmt.Printf("dasctf: %d id(s) from priority file head the queue\n", len(priority))
		}
		n, err := dasctf.Import(ctx, st, dc, priority)
		if err != nil {
			return err
		}
		fmt.Printf("dasctf: imported %d new exercise goal(s)\n", n)
		fmt.Println("dasctf: next — export DASCTF_HOST and DASCTF_ACCESSKEY in this shell, then `zhulongx run`")
		return nil
	default: // sync
		rep, err := dasctf.Sync(ctx, st, dc)
		if err != nil {
			return err
		}
		fmt.Printf("dasctf: sync done — %d completed by platform", len(rep.Completed))
		if len(rep.Completed) > 0 {
			fmt.Println()
			for _, s := range rep.Completed {
				fmt.Printf("  completed %s\n", s)
			}
		} else {
			fmt.Println()
		}
		if rep.InProgress > 0 {
			fmt.Printf("  in progress: %d goal(s)\n", rep.InProgress)
		}
		for _, s := range rep.Mismatched {
			fmt.Printf("  MISMATCH %s — locally completed, platform disagrees; review before trusting\n", s)
		}
		for _, s := range rep.Missing {
			fmt.Printf("  missing  %s — platform no longer lists this exercise\n", s)
		}
		return nil
	}
}

// wireDasctf arms the DASCTF env gate + flag fast lane when the run is a
// DASCTF session (both env vars present). The gate builds env-backed
// exercises operator-side (agent steps never burn a turn on build/poll),
// recovers the envs of solved/stopped goals, and submits every
// DASCTF-shaped flag candidate the moment it lands in the graph.
func wireDasctf(e *engine.Engine, st *store.Store, log *slog.Logger) {
	host, key := os.Getenv("DASCTF_HOST"), os.Getenv("DASCTF_ACCESSKEY")
	if host == "" || key == "" {
		return
	}
	if os.Getenv("BENCHMARK_BASE_URL") != "" {
		log.Warn("dasctf: BENCHMARK_* env also set; the bench gate owns StepGate, dasctf gate stays off")
		return
	}
	dc, err := dasctf.NewClient(host, key)
	if err != nil {
		log.Warn("dasctf: gate not armed", "err", err)
		return
	}
	gate := dasctf.NewGate(st, dc, log)
	e.StepGate = gate.Allow
	e.ReleaseContainer = gate.ForceRelease
	e.FlagProgress = func(title string) (int, int, bool) {
		id, ok := dasctf.CodeOfTitle(title)
		if !ok {
			return 0, 0, false
		}
		return gate.Progress(id)
	}
	e.OnFlagCandidate = func(ctx context.Context, title, flag string) {
		gate.Submit(ctx, title, flag)
	}
	log.Info("dasctf: gate armed (env lifecycle paced, flag fast lane live)")
}
