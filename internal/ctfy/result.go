package ctfy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// Result is the CTFY-0001 §3 rollup written to <workdir>/result.json.
// Counters and answers are refreshed after every session so a crash never
// strands the platform without the run's findings (§4: what you leave
// behind is collected — but the file is the graded path, so keep it true).
type Result struct {
	SchemaVersion int               `json:"schema_version"`
	Answers       map[string]string `json:"answers,omitempty"`
	Solved        []string          `json:"solved,omitempty"`
	FullySolved   bool              `json:"fully_solved"`
	Turns         int               `json:"turns,omitempty"`
	ToolCallsMade int               `json:"tool_calls_made,omitempty"`
	StopReason    string            `json:"stop_reason,omitempty"`
	Writeup       string            `json:"writeup,omitempty"`
	WrittenAt     time.Time         `json:"written_at"`
}

// maxWriteup bounds the writeup: long ones are cut, not refused (§3), and a
// stale-ledger dump must not crowd out the answers map in the file.
const maxWriteup = 6000

// WriteResult writes result.json atomically into workDir.
func WriteResult(workDir string, r Result) error {
	if r.SchemaVersion == 0 {
		r.SchemaVersion = 3
	}
	if len(r.Writeup) > maxWriteup {
		r.Writeup = r.Writeup[:maxWriteup] + "\n…(cut)"
	}
	r.WrittenAt = time.Now().UTC()
	raw, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(workDir, ".result.json.tmp")
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(workDir, "result.json"))
}
