// Command ctfyagent drives one CTFY-0001 dispatch: it reads the platform
// briefing from the working directory, runs bounded pi sessions against the
// challenge until the run is finished, and keeps result.json true the whole
// way. Exit 0 = finished (scored or not); non-zero = this image failed
// before doing its work.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"zhulongx/internal/ctfy"
	"zhulongx/internal/pi"
)

const doctrinePath = "/opt/zhx/ctfy-doctrine.md"

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	code := run(log)
	os.Exit(code)
}

func run(log *slog.Logger) int {
	// Protocol step 1: the briefing. It may be absent only on a dry run.
	workDir := os.Getenv("CTFY_WORK_DIR")
	if workDir == "" {
		workDir = "/ctfy/work"
	}
	dryEnv := os.Getenv("CTFY_EVAL_DRY_RUN") == "1"

	task, taskErr := ctfy.LoadTask(workDir)
	dry := dryEnv || (taskErr == nil && task.DryRun)
	if dry {
		// CTFY-0001 §3.1: nobody scores this; the cheapest correct answer
		// is the file and a clean exit.
		if err := ctfy.WriteResult(workDir, ctfy.Result{StopReason: "dry_run"}); err != nil {
			log.Error("dry run: result write failed", "err", err)
			return 1
		}
		log.Info("dry run: wrote result.json, exiting clean")
		return 0
	}
	if taskErr != nil {
		fmt.Fprintf(os.Stderr, "STARTUP_CONFIG_ERROR: cannot read %s/task.json (%v) and this is not a dry run\n", workDir, taskErr)
		return 1
	}

	env := ctfy.FromEnv(task)

	// Protocol step 2: model funding. An unfunded run is a real state —
	// say it loudly, after leaving the honest result behind (§1.1).
	if !env.LLMFunded {
		_ = ctfy.WriteResult(workDir, ctfy.Result{StopReason: "unfunded: no LLM credential in environment"})
		fmt.Fprintln(os.Stderr, "STARTUP_CONFIG_ERROR: no LLM credential (LLM_API_KEY/ANTHROPIC_API_KEY/OPENAI_API_KEY) — nothing funds this run")
		return 1
	}
	if _, err := exec.LookPath("pi"); err != nil {
		fmt.Fprintln(os.Stderr, "STARTUP_DEPENDENCY_ERROR: pi executable not found")
		return 1
	}

	var api ctfy.API
	if env.PlatformURL != "" && env.Token != "" {
		api = ctfy.NewClient(env.PlatformURL, env.Token)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		if err := api.(interface{ Ping(context.Context) error }).Ping(ctx); err != nil {
			log.Warn("ctfy: platform ping failed (continuing; agent derives routes from README)", "err", err)
		} else {
			log.Info("ctfy: platform token verified")
		}
		cancel()
	} else {
		log.Warn("ctfy: no platform URL/token in env — gated refresh and match clock disabled")
	}

	// MCP surface (awd tick clock + flag banking). Absent config is normal;
	// broken config is logged and skipped — the driver never depends on it.
	var mcp ctfy.MCPAPI
	if env.Token != "" {
		if cl, err := ctfy.LoadMCPConfig(env.WorkDir, env.Token); err != nil {
			log.Warn("ctfy: mcp.json present but unusable (continuing without MCP)", "err", err)
		} else if cl != nil {
			mcp = cl
			log.Info("ctfy: mcp surface wired")
		}
	}

	factory := func() (ctfy.Prompter, error) {
		return pi.Start(pi.LaunchConfig{
			Command: "pi",
			Dir:     env.WorkDir,
			// No model/provider config is injected: the platform pre-writes
			// ~/.pi/agent/{models,settings}.json with the funded provider
			// (CTFY-0001 §1.1) and this image ships neither file.
		})
	}

	driver, err := ctfy.NewDriver(env, task, api, mcp, factory, log, doctrinePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "STARTUP_CONFIG_ERROR: %v\n", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	reason := driver.Run(ctx)

	if err := ctfy.WriteResult(workDir, driver.FinalResult(reason)); err != nil {
		log.Error("ctfy: final result write failed", "err", err)
		return 1
	}
	log.Info("ctfy: dispatch finished", "reason", reason, "sessions", driver.State().Sessions, "solved", len(driver.State().Solved))
	return 0
}
