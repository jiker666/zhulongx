package contract

import (
	"fmt"
	"strings"
)

// validate.go holds the payload validators for the FGS
// vocabulary: DecideAnswer (was reason), ExecuteAnswer (was explore).
// The accepted/data envelope is preserved verbatim so prompts stay in the
// same envelope teams already know.

// Verdict kinds.
const (
	KindComplete = "complete"
	KindSteps    = "steps"
	KindNoop     = "noop"
	KindRejected = "rejected"
)

// CompleteSpec is the goal-completion verdict.
type CompleteSpec struct {
	From        []string
	Description string
}

// StepSpec is one proposed step.
type StepSpec struct {
	From        []string
	Description string
}

// DecideAnswer is the validated result of a Decide round. At most one of
// Complete/Steps is set; Findings review may accompany any verdict.
type DecideAnswer struct {
	Kind      string
	Complete  *CompleteSpec
	Steps     []StepSpec
	Promote   []string
	Discard   []string
	RejectMsg string
}

// ExecuteAnswer is the validated result of an Execute run.
type ExecuteAnswer struct {
	Content  string
	Evidence string
}

// unwrap mirrors contracts._unwrap_wrapped_payload: accept either the raw
// payload or {"accepted": bool, "data" | "reason": ...}.
func unwrap(payload map[string]any) (rejected bool, reason string, data map[string]any, err error) {
	accVal, hasAccepted := payload["accepted"]
	if !hasAccepted {
		return false, "", payload, nil
	}
	accepted, ok := accVal.(bool)
	if !ok {
		return false, "", nil, fmt.Errorf("contract: accepted must be boolean")
	}
	if !accepted {
		if r, ok := payload["reason"].(string); ok {
			reason = r
		}
		return true, reason, nil, nil
	}
	switch d := payload["data"].(type) {
	case nil:
		return false, "", map[string]any{}, nil
	case map[string]any:
		return false, "", d, nil
	default:
		return false, "", nil, fmt.Errorf("contract: data must be an object")
	}
}

// ValidateDecide validates a Decide payload.
//
// Rules (decide payload + FGS finding review):
//   - accepted=false → rejected verdict
//   - data.complete  → from must be non-empty strings; description non-empty
//   - data.steps     → non-empty list; each has non-empty description and
//     non-empty from; truncated to maxSteps; must be non-empty when there
//     are no open steps ("steps must be non-empty when open steps are empty")
//   - data.findings  → {promote: [ids], discard: [ids]}, no duplicates
//   - complete and steps are mutually exclusive
func ValidateDecide(payload map[string]any, openStepsEmpty bool, maxSteps int) (*DecideAnswer, error) {
	rejected, reason, data, err := unwrap(payload)
	if err != nil {
		return nil, err
	}
	if rejected {
		return &DecideAnswer{Kind: KindRejected, RejectMsg: reason}, nil
	}

	ans := &DecideAnswer{Kind: KindNoop}

	if raw, ok := data["findings"]; ok && raw != nil {
		fr, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("contract: findings must be an object with promote/discard")
		}
		if ans.Promote, err = idList(fr["promote"], "findings.promote"); err != nil {
			return nil, err
		}
		if ans.Discard, err = idList(fr["discard"], "findings.discard"); err != nil {
			return nil, err
		}
		if dup := firstDuplicate(ans.Promote, ans.Discard); dup != "" {
			return nil, fmt.Errorf("contract: finding %s appears in both promote and discard", dup)
		}
	}

	if raw, ok := data["complete"]; ok && raw != nil {
		if _, hasSteps := data["steps"]; hasSteps && data["steps"] != nil {
			return nil, fmt.Errorf("contract: complete and steps are mutually exclusive")
		}
		c, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("contract: complete must be an object")
		}
		spec := &CompleteSpec{}
		if spec.From, err = idList(c["from"], "complete.from"); err != nil {
			return nil, err
		}
		if len(spec.From) == 0 {
			return nil, fmt.Errorf("contract: complete.from must not be empty")
		}
		desc, _ := c["description"].(string)
		if strings.TrimSpace(desc) == "" {
			return nil, fmt.Errorf("contract: complete.description must not be empty")
		}
		spec.Description = strings.TrimSpace(desc)
		ans.Kind = KindComplete
		ans.Complete = spec
		return ans, nil
	}

	if raw, ok := data["steps"]; ok && raw != nil {
		list, ok := raw.([]any)
		if !ok {
			return nil, fmt.Errorf("contract: steps must be an array")
		}
		if len(list) == 0 {
			if openStepsEmpty {
				return nil, fmt.Errorf("contract: steps must not be empty while no steps are open")
			}
			return ans, nil
		}
		for i, item := range list {
			m, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("contract: steps[%d] must be an object", i)
			}
			spec := StepSpec{}
			if spec.From, err = idList(m["from"], "steps.from"); err != nil {
				return nil, err
			}
			if len(spec.From) == 0 {
				return nil, fmt.Errorf("contract: steps[%d].from must not be empty", i)
			}
			desc, _ := m["description"].(string)
			if strings.TrimSpace(desc) == "" {
				return nil, fmt.Errorf("contract: steps[%d].description must not be empty", i)
			}
			spec.Description = strings.TrimSpace(desc)
			ans.Steps = append(ans.Steps, spec)
		}
		if len(ans.Steps) > maxSteps {
			ans.Steps = ans.Steps[:maxSteps]
		}
		ans.Kind = KindSteps
		return ans, nil
	}

	if openStepsEmpty && (ans.Promote == nil && ans.Discard == nil) {
		// Noop with zero open steps is allowed (the scheduler re-triggers
		// reason); mirror that leniency — the engine enforces a no-progress
		// guard instead of the contract.
		return ans, nil
	}
	return ans, nil
}

// ValidateExecute validates an Execute payload: the agent must return
// {"data": {"finding": {"content", "evidence"?}}} (execute returned a
// bare description; FGS adds evidence for the audit trail).
func ValidateExecute(payload map[string]any) (*ExecuteAnswer, error) {
	rejected, reason, data, err := unwrap(payload)
	if err != nil {
		return nil, err
	}
	if rejected {
		return nil, fmt.Errorf("contract: execute rejected by agent: %s", reason)
	}
	raw, ok := data["finding"]
	if !ok || raw == nil {
		return nil, fmt.Errorf("contract: data.finding is required")
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("contract: data.finding must be an object")
	}
	content, _ := m["content"].(string)
	if strings.TrimSpace(content) == "" {
		return nil, fmt.Errorf("contract: finding.content must not be empty")
	}
	evidence, _ := m["evidence"].(string)
	return &ExecuteAnswer{Content: strings.TrimSpace(content), Evidence: strings.TrimSpace(evidence)}, nil
}

func idList(raw any, what string) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("contract: %s must be an array of ids", what)
	}
	var out []string
	for i, item := range list {
		s, ok := item.(string)
		if !ok || strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("contract: %s[%d] must be a non-empty string", what, i)
		}
		out = append(out, strings.TrimSpace(s))
	}
	return out, nil
}

func firstDuplicate(lists ...[]string) string {
	seen := map[string]bool{}
	for _, l := range lists {
		for _, s := range l {
			if seen[s] {
				return s
			}
			seen[s] = true
		}
	}
	return ""
}
