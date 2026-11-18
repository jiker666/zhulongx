// Package ctfy adapts the zhulongx agent stack to the CTFY-0001 agent
// protocol: one platform dispatch = one challenge run, driven as bounded
// pi sessions with all durable state under the platform working directory
// so container restarts (protocol "rounds") lose nothing.
package ctfy

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Question is one answerable unit of a run (a flag prompt, an MCQ, or — on
// gated challenges — a question that only exists after an earlier correct
// answer unlocked it).
type Question struct {
	ID     string `json:"id"`
	Prompt string `json:"prompt"`
}

// Endpoint is one published address of the target.
type Endpoint struct {
	Label string `json:"label"`
	Type  string `json:"type"` // http|https|tcp|udp|ssh
	URL   string `json:"url"`
}

// Attachment is a challenge file; Path is nil when the platform did not
// copy it into the working directory (bounded at 4 MiB per run).
type Attachment struct {
	Name string  `json:"name"`
	Size int64   `json:"size"`
	Path *string `json:"path"`
}

// ChallengeRef names the challenge this run attacks.
type ChallengeRef struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Task is the subset of /ctfy/work/task.json the driver acts on. Unknown
// fields are tolerated by design (the schema grows additively).
type Task struct {
	SchemaVersion   int          `json:"schema_version"`
	RunMode         string       `json:"run_mode"` // instance|qa|defence|awd|engagement
	Challenge       ChallengeRef `json:"challenge"`
	CompetitionID   string       `json:"competition_id"`
	Questions       []Question   `json:"questions"`
	GatedQuestions  int          `json:"gated_questions"`
	Scope           []string     `json:"scope"`
	Rules           []string     `json:"rules_of_engagement"`
	Deliverable     string       `json:"deliverable"`
	PlatformURL     string       `json:"platform_url"`
	MaxTurns        *int         `json:"max_turns"` // null = no budget; never 0
	TargetInstance  string       `json:"target_instance"`
	TargetEndpoints []Endpoint   `json:"target_endpoints"`
	Attachments     []Attachment `json:"attachments"`
	DryRun          bool         `json:"dry_run"`
}

// LoadTask reads task.json from the working directory.
func LoadTask(workDir string) (*Task, error) {
	raw, err := os.ReadFile(filepath.Join(workDir, "task.json"))
	if err != nil {
		return nil, fmt.Errorf("ctfy: read task.json: %w", err)
	}
	var t Task
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("ctfy: parse task.json: %w", err)
	}
	if t.RunMode == "" {
		return nil, fmt.Errorf("ctfy: task.json has no run_mode")
	}
	return &t, nil
}

// QuestionByID returns the current view of a question (ok=false once it is
// no longer listed).
func (t *Task) QuestionByID(id string) (Question, bool) {
	for _, q := range t.Questions {
		if q.ID == id {
			return q, true
		}
	}
	return Question{}, false
}
