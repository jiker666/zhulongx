package pi

import (
	"fmt"
	"regexp"
)

// ToolPolicy gates the shell commands the agent may execute. zhulongx sits
// outside the agent process, so it cannot block a tool call before it runs —
// the honest enforcement point is mid-run: the adapter watches
// bash_execution_update events, and the first command matching a blocked
// pattern aborts the whole run (ErrPolicyViolation) instead of waiting for
// the agent to settle. Pre-execution gating would require a Pi TS extension
// (documented as future work).
type ToolPolicy struct {
	patterns []*regexp.Regexp
}

// CompileToolPolicy builds a policy from regex patterns. Empty/nil input
// yields a nil policy = allow everything.
func CompileToolPolicy(patterns []string) (*ToolPolicy, error) {
	if len(patterns) == 0 {
		return nil, nil
	}
	p := &ToolPolicy{patterns: make([]*regexp.Regexp, 0, len(patterns))}
	for _, raw := range patterns {
		re, err := regexp.Compile("(?i)" + raw)
		if err != nil {
			return nil, fmt.Errorf("pi: invalid blocked_tools pattern %q: %w", raw, err)
		}
		p.patterns = append(p.patterns, re)
	}
	return p, nil
}

// Violation returns the first matched pattern if the command is forbidden,
// "" otherwise. A nil policy allows everything.
func (p *ToolPolicy) Violation(command string) string {
	if p == nil {
		return ""
	}
	for _, re := range p.patterns {
		if re.MatchString(command) {
			return re.String()
		}
	}
	return ""
}
