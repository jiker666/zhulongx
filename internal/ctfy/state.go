package ctfy

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Submission is one answer the agent handed to the platform during a
// session, with the verdict the platform returned (as the agent observed
// it — the authoritative record lives platform-side; this feeds
// result.json and the next session's mission).
type Submission struct {
	QuestionID string    `json:"question_id"`
	Answer     string    `json:"answer"`
	Verdict    string    `json:"verdict"` // correct|wrong|unknown
	At         time.Time `json:"at"`
}

// State is everything that must survive both the next pi session and a
// full container restart (CTFY-0001 §3.3 rounds restart the container with
// the working directory intact). It lives at <workdir>/state/state.json
// and is rewritten atomically after every session.
type State struct {
	Sessions    int               `json:"sessions"`
	ToolCalls   int               `json:"tool_calls"`
	Answers     map[string]string `json:"answers"` // qid -> last submitted answer
	Solved      []string          `json:"solved"`  // qids with an observed correct verdict
	Wrong       map[string]int    `json:"wrong"`   // qid -> observed wrong count
	Submissions []Submission      `json:"submissions"`
	AWDFlags    []AWDFlagRecord   `json:"awd_flags"` // banked flag values (deduped)
	NoProgress  int               `json:"no_progress"`
	MatchOver   bool              `json:"match_over"` // awd: agent saw the match end
	Notes       string            `json:"notes"`      // last session summary (writeup seed)
}

// AWDFlagRecord is one banked AWD flag. Values repeat every tick round for
// the same box family, so the dedupe key is (value, round): the same value
// in a NEW round is fresh score, the same value in the same round is a dup.
type AWDFlagRecord struct {
	Value   string    `json:"value"`
	Host    string    `json:"host,omitempty"`
	Round   int       `json:"round,omitempty"`
	At      time.Time `json:"at"`
	Verdict string    `json:"verdict"` // banked|duplicate|error
}

func NewState() *State {
	return &State{
		Answers: map[string]string{},
		Wrong:   map[string]int{},
		Solved:  []string{},
	}
}

func statePath(workDir string) string {
	return filepath.Join(workDir, "state", "state.json")
}

// LoadState restores run state from the working directory; a missing file
// is a fresh run, not an error.
func LoadState(workDir string) (*State, error) {
	raw, err := os.ReadFile(statePath(workDir))
	if err != nil {
		if os.IsNotExist(err) {
			return NewState(), nil
		}
		return nil, err
	}
	var s State
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("ctfy: parse state: %w", err)
	}
	if s.Answers == nil {
		s.Answers = map[string]string{}
	}
	if s.Wrong == nil {
		s.Wrong = map[string]int{}
	}
	return &s, nil
}

// Save writes state atomically (tmp file + rename in the same directory).
func (s *State) Save(workDir string) error {
	dir := filepath.Join(workDir, "state")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := statePath(workDir) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, statePath(workDir))
}

// IsSolved reports whether the platform has (per our observations) accepted
// an answer for qid.
func (s *State) IsSolved(qid string) bool {
	for _, id := range s.Solved {
		if id == qid {
			return true
		}
	}
	return false
}

// MarkSolved adds qid once.
func (s *State) MarkSolved(qid string) {
	if !s.IsSolved(qid) {
		s.Solved = append(s.Solved, qid)
	}
}

// HasAWDFlag reports whether (value, round) is already banked.
func (s *State) HasAWDFlag(value string, round int) bool {
	for _, f := range s.AWDFlags {
		if f.Value == value && f.Round == round {
			return true
		}
	}
	return false
}

// RecordAWDFlag appends a banked flag; returns false when it is a duplicate.
func (s *State) RecordAWDFlag(f AWDFlagRecord) bool {
	if f.Value == "" || s.HasAWDFlag(f.Value, f.Round) {
		return false
	}
	if f.At.IsZero() {
		f.At = time.Now().UTC()
	}
	s.AWDFlags = append(s.AWDFlags, f)
	return true
}

// Record folds one session's submission into state. It returns whether the
// submission carried new information (progress).
func (s *State) Record(sub Submission) bool {
	s.Submissions = append(s.Submissions, sub)
	if sub.QuestionID == "" {
		return false
	}
	prevAnswer, had := s.Answers[sub.QuestionID]
	s.Answers[sub.QuestionID] = sub.Answer
	progress := !had || prevAnswer != sub.Answer
	switch sub.Verdict {
	case "correct":
		if !s.IsSolved(sub.QuestionID) {
			s.MarkSolved(sub.QuestionID)
			progress = true
		}
	case "wrong":
		s.Wrong[sub.QuestionID]++
		progress = true // the platform's verdict is knowledge
	}
	return progress
}
