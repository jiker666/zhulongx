// Package cfg loads zhulongx.yaml: runtime, scheduling and Pi settings
// in one place — the runtime is exactly one Pi agent loop.
package cfg

import (
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"

	"zhulongx/internal/pi"
)

// Duration is a time.Duration that unmarshals from YAML strings ("30s").
type Duration time.Duration

func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	var s string
	if err := node.Decode(&s); err != nil {
		return err
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("cfg: invalid duration %q: %w", s, err)
	}
	*d = Duration(v)
	return nil
}

func (d Duration) D() time.Duration { return time.Duration(d) }

// Runtime tunes the scheduler loop.
type Runtime struct {
	TickInterval       Duration `yaml:"tick_interval"`
	DecideTimeout      Duration `yaml:"decide_timeout"`
	ExecuteTimeout     Duration `yaml:"execute_timeout"`
	MaxConcurrentSteps int      `yaml:"max_concurrent_steps"`
	MaxStepsPerDecide  int      `yaml:"max_steps_per_decide"`
	StepMaxAttempts    int      `yaml:"step_max_attempts"`
	// RepairTimeout bounds the single follow-up round that salvages a
	// contract miss (no JSON / invalid schema) without re-running the step.
	RepairTimeout Duration `yaml:"repair_timeout"`
	// DecideNoopLimit auto-stops a goal after N consecutive no-op Decide
	// rounds while no steps are open (bounds wasted Decide rounds).
	DecideNoopLimit int `yaml:"decide_noop_limit"`
	// GoalStepBudget caps how many DONE Execute steps one goal may run
	// before the scheduler stops it. 0 disables. It is the engine-side
	// backstop against zombie goals: a goal whose Decide keeps declaring
	// "promising" next steps can otherwise pin a scarce slot forever.
	GoalStepBudget int `yaml:"goal_step_budget"`
	// GoalWallBudget caps a goal's total wall time from its first claimed
	// step. 0 disables. Step count alone cannot bound a goal that runs few
	// but very long steps.
	GoalWallBudget Duration `yaml:"goal_wall_budget"`
	// RunDeadline, when > 0, is measured from engine start: budget-stopped
	// goals are requeued for a second pass once the whole queue drains,
	// until the deadline nears. 0 disables requeueing.
	RunDeadline Duration `yaml:"run_deadline"`
	// BootstrapStep, when non-empty, becomes the description of an
	// engine-declared first step on a brand-new goal and the initial Decide
	// round is skipped: easy objectives are solved by one direct Execute
	// pass instead of paying the decomposition tax (a model round-trip plus
	// a split made at the moment of least information). Decide enters after
	// the bootstrap finding lands, with real intel. Empty = legacy behavior.
	BootstrapStep string `yaml:"bootstrap_step"`
	// EndgameAfter, when > 0, switches the scheduler to harvest mode once
	// RunDeadline minus this window remains: goals with banked-but-unfinished
	// flag progress are scheduled before untouched ones. Completion rate is
	// won in the tail — a goal that already holds 2 of 4 flags converts a
	// free slot into score far cheaper than a fresh first pass. 0 disables.
	EndgameAfter Duration `yaml:"endgame_after"`
	// EndgameMinActive keeps the harvest window fed: once in endgame, if
	// fewer than this many goals are active the scheduler requeues the best
	// stopped titles (banked progress first) past the normal requeue cap.
	// Run 42838: hour-5 utilization collapsed to 1.17 slots because every
	// title had burned its 2 requeues — the queue emptied while partial
	// multi-flag goals sat stopped. An idle endgame slot is worth exactly
	// zero. 0 disables the top-up.
	EndgameMinActive int `yaml:"endgame_min_active"`
	// EndgameStepBudget / EndgameWallBudget override GoalStepBudget /
	// GoalWallBudget inside the harvest window (0 = keep the mid-run cap).
	// Run 42838 walls died one or two moves short of the flag with the next
	// move already named in the ledger — deep chains (locked-suffix write
	// primitives, custom-crypto keystream batteries, 30k-entry internal dir
	// fuzzes) need more steps and minutes per pass than first-touch recon
	// does. In endgame the queue is thin, slots would otherwise idle, and
	// breadth no longer trades against depth.
	EndgameStepBudget int          `yaml:"endgame_step_budget"`
	EndgameWallBudget Duration     `yaml:"endgame_wall_budget"`
	// FlagRefillMax caps how many times banking a NEW correct flag may refuel
	// one goal's budgets in a pass: the wall window resets AND FlagStepBonus
	// extra Execute steps are granted. Multi-flag intranets legitimately
	// convert for hours; the old hard cap of two refueled the clock but the
	// step budget still cut the goal mid-harvest (a 6-flag intranet burned
	// 31% of one run's slot capacity across seven restarts and never
	// finished). 0 = code default (4).
	FlagRefillMax int `yaml:"flag_refill_max"`
	// FlagStepBonus is how many extra Execute steps each flag refuel grants
	// on top of the step-budget reset. 0 = code default (3).
	FlagStepBonus int `yaml:"flag_step_bonus"`
}

// Pi describes how to launch the agent runtime.
type Pi struct {
	// Command is the pi executable (or a test mock). Model/provider
	// selection stays in the user's own pi configuration.
	Command      string   `yaml:"command"`
	Args         []string `yaml:"args"`
	Dir          string   `yaml:"dir"`
	SpawnRetries int      `yaml:"spawn_retries"`
	// BlockedTools are case-insensitive regex patterns; a bash command
	// matching any of them aborts the run as a policy violation.
	BlockedTools []string `yaml:"blocked_tools"`
}

// Config is the whole file.
type Config struct {
	DBPath   string  `yaml:"db_path"`
	LogLevel string  `yaml:"log_level"`
	Runtime  Runtime `yaml:"runtime"`
	Pi       Pi      `yaml:"pi"`
}

// Default returns the built-in defaults.
func Default() *Config {
	return &Config{
		DBPath:   "zhulongx.db",
		LogLevel: "info",
		Runtime: Runtime{
			TickInterval:       Duration(2 * time.Second),
			DecideTimeout:      Duration(10 * time.Minute),
			ExecuteTimeout:     Duration(15 * time.Minute),
			MaxConcurrentSteps: 2,
			MaxStepsPerDecide:  3,
			StepMaxAttempts:    3,
			DecideNoopLimit:    3,
			RepairTimeout:      Duration(3 * time.Minute),
		},
		Pi: Pi{
			Command:      "pi",
			SpawnRetries: 1,
		},
	}
}

// Load reads path, applying defaults for anything unset.
func Load(path string) (*Config, error) {
	c := Default()
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cfg: read %s: %w", path, err)
	}
	if err := yaml.Unmarshal(raw, c); err != nil {
		return nil, fmt.Errorf("cfg: parse %s: %w", path, err)
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Config) validate() error {
	if c.Pi.Command == "" {
		return fmt.Errorf("cfg: pi.command must not be empty")
	}
	if c.Runtime.MaxConcurrentSteps < 1 || c.Runtime.MaxStepsPerDecide < 1 || c.Runtime.StepMaxAttempts < 1 {
		return fmt.Errorf("cfg: concurrency/step caps must be >= 1")
	}
	if c.Runtime.DecideNoopLimit < 1 {
		return fmt.Errorf("cfg: decide_noop_limit must be >= 1")
	}
	if c.Runtime.TickInterval.D() <= 0 || c.Runtime.DecideTimeout.D() <= 0 || c.Runtime.ExecuteTimeout.D() <= 0 {
		return fmt.Errorf("cfg: durations must be positive")
	}
	// fail fast on a bad regex before the first runner launch
	if _, err := pi.CompileToolPolicy(c.Pi.BlockedTools); err != nil {
		return fmt.Errorf("cfg: %w", err)
	}
	return nil
}
