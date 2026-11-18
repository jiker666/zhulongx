package ctfy

import (
	"encoding/json"
	"strings"
)

// AgentReport is the structured tail every pi session must end with. It is
// the driver's only channel for session outcomes; the ledgers and notes
// files carry the long-form state the next session reads.
type AgentReport struct {
	Summary   string         `json:"summary"`
	Submitted []Submitted    `json:"submitted"`
	Flags     []CapturedFlag `json:"flags"` // awd: raw flag values captured this session
	MoreWork  bool           `json:"more_work"`
	MatchOver bool           `json:"match_over"`
}

// Submitted is one answer handed over during the session.
type Submitted struct {
	QuestionID string `json:"question_id"`
	Answer     string `json:"answer"`
	Verdict    string `json:"verdict"` // correct|wrong|unknown
}

// CapturedFlag is one AWD flag value lifted from a rival box this session.
// The driver banks it via MCP submit_awd_flags — flags die at tick rollover,
// so reporting them promptly is worth more than exploiting one more box.
type CapturedFlag struct {
	Value string `json:"value"`
	Host  string `json:"host,omitempty"`
	Round int    `json:"round,omitempty"`
}

// ParseReport extracts the last TOP-LEVEL JSON object in the session's
// final text. Only depth-0 objects are candidates: any nested object
// (a submission entry, say) also unmarshals cleanly into the permissive
// AgentReport struct and would silently shadow the real report. Tolerates
// markdown fences and trailing prose; returns an error when nothing parses
// (the driver treats that as a failed session, not a crash).
func ParseReport(text string) (*AgentReport, error) {
	t := stripFences(text)
	var top []int // start indices of depth-0 objects
	depth, inStr, esc := 0, false, false
	for i := 0; i < len(t); i++ {
		c := t[i]
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
			if depth == 0 {
				top = append(top, i)
			}
			depth++
		case '}':
			if depth > 0 {
				depth--
			}
		}
	}
	// Walk backwards: prefer the last top-level object that parses into a
	// non-empty report; keep the last parsable one as a fallback ({} is a
	// legitimate, if useless, report).
	var fallback *AgentReport
	for k := len(top) - 1; k >= 0; k-- {
		obj, ok := balancedObject(t, top[k])
		if !ok {
			continue
		}
		var rep AgentReport
		if err := json.Unmarshal([]byte(obj), &rep); err != nil {
			continue
		}
		r := rep
		if fallback == nil {
			fallback = &r
		}
		if reportNonEmpty(&r) {
			return &r, nil
		}
	}
	if fallback != nil {
		return fallback, nil
	}
	return nil, errNoReport
}

// reportNonEmpty guards against shadow objects: an inner object leaks
// through as an all-zero report only when it carries none of the meaningful
// fields.
func reportNonEmpty(r *AgentReport) bool {
	return r.Summary != "" || len(r.Submitted) > 0 || len(r.Flags) > 0 || r.MatchOver || r.MoreWork
}

type parseErr string

func (e parseErr) Error() string { return string(e) }

const errNoReport = parseErr("ctfy: session text carries no JSON report")

// stripFences removes ``` fences so a fenced final object still parses.
func stripFences(s string) string {
	if !strings.Contains(s, "```") {
		return s
	}
	var b strings.Builder
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "```") {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

// balancedObject returns the substring starting at open that ends at the
// matching close brace, honoring strings and escapes.
func balancedObject(s string, open int) (string, bool) {
	depth := 0
	inStr, esc := false, false
	for i := open; i < len(s); i++ {
		c := s[i]
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
				return s[open : i+1], true
			}
		}
	}
	return "", false
}
