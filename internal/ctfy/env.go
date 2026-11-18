package ctfy

import (
	"os"
	"strconv"
)

// Env is the CTFY-0001 §1.1 environment surface the driver consumes. The
// LLM_* variables are NOT interpreted beyond the funding sanity check —
// the platform pre-writes pi's provider config (~/.pi/agent/models.json,
// settings.json) when LLM_BASE_URL is set, and the image deliberately
// ships neither file so the platform's funding config always lands.
type Env struct {
	WorkDir        string
	PlatformURL    string
	Token          string
	ChallengeID    string
	CompetitionID  string
	TargetInstance string
	TargetURL      string
	MaxTurns       *int
	DryRun         bool
	LLMFunded      bool
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

// FromEnv snapshots the dispatch environment. CTFY_* names are the
// contract; the target/env mirrors that also arrive in task.json are
// taken as fallbacks only.
func FromEnv(task *Task) Env {
	e := Env{
		WorkDir:        os.Getenv("CTFY_WORK_DIR"),
		PlatformURL:    os.Getenv("CTFY_PLATFORM_URL"),
		Token:          os.Getenv("CTFY_TOKEN"),
		ChallengeID:    os.Getenv("CTFY_EVAL_CHALLENGE_ID"),
		CompetitionID:  os.Getenv("CTFY_EVAL_COMPETITION_ID"),
		TargetInstance: os.Getenv("CTFY_EVAL_TARGET_INSTANCE"),
		TargetURL:      os.Getenv("CTFY_TARGET_URL"),
		DryRun:         os.Getenv("CTFY_EVAL_DRY_RUN") == "1",
		LLMFunded: firstNonEmpty(
			os.Getenv("LLM_API_KEY"),
			os.Getenv("ANTHROPIC_API_KEY"),
			os.Getenv("ANTHROPIC_AUTH_TOKEN"),
			os.Getenv("OPENAI_API_KEY"),
		) != "",
	}
	if e.WorkDir == "" {
		e.WorkDir = "/ctfy/work"
	}
	if task != nil {
		if e.ChallengeID == "" {
			e.ChallengeID = task.Challenge.ID
		}
		if e.CompetitionID == "" {
			e.CompetitionID = task.CompetitionID
		}
		if e.TargetInstance == "" {
			e.TargetInstance = task.TargetInstance
		}
		if e.PlatformURL == "" {
			e.PlatformURL = task.PlatformURL
		}
	}
	if v := os.Getenv("CTFY_EVAL_MAX_TURNS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			e.MaxTurns = &n
		}
	}
	if task != nil && task.MaxTurns != nil && e.MaxTurns == nil {
		n := *task.MaxTurns
		e.MaxTurns = &n
	}
	return e
}
