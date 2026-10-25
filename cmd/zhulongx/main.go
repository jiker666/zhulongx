// zhulongx is the CLI entry point: run (scheduler loop), goal, hint, fact,
// status, export, init-config. It replaces Cairn's `cairn serve` +
// `cairn dispatch` pair with one process.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "embed"

	"zhulongx/internal/cfg"
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
	e := engine.New(st, c, log, nil)
	log.Info("zhulongx running", "db", c.DBPath, "pi", c.Pi.Command)
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
