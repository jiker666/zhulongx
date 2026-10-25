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
	// DecideNoopLimit auto-stops a goal after N consecutive no-op Decide
	// rounds while no steps are open (bounds wasted Decide rounds).
	DecideNoopLimit int `yaml:"decide_noop_limit"`
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
