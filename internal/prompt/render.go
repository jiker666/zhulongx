// Package prompt renders the Decide/Execute prompts from embedded
// templates, rendered with the
// FGS vocabulary (Step instead of Intent, plus the Finding review action).
package prompt

import (
	_ "embed"
	"fmt"
	"sort"
	"strings"

	"zhulongx/internal/fgs"
	"zhulongx/internal/store"
)

//go:embed prompts/decide.md
var decideTemplate string

//go:embed prompts/execute.md
var executeTemplate string

func render(tpl string, replacements map[string]string) string {
	out := tpl
	for k, v := range replacements {
		out = strings.ReplaceAll(out, "{"+k+"}", v)
	}
	return out
}

// RenderDecide builds the Decide prompt.
func RenderDecide(g *store.Graph, factIDs []string, maxSteps int) string {
	ids := append([]string(nil), factIDs...)
	sort.Strings(ids)
	repl := map[string]string{
		"goal_id":        g.Goal.ID,
		"goal_title":     g.Goal.Title,
		"goal_origin":    g.Goal.Origin,
		"goal_objective": g.Goal.Objective,
		"graph_yaml":     renderGraphSection(g),
		"fact_ids":       yamlList(ids),
		"open_steps":     renderStepsSection(g),
		"open_findings":  renderFindingsSection(g),
		"hints":          renderHintsSection(g),
		"max_steps":      fmt.Sprintf("%d", maxSteps),
	}
	return render(decideTemplate, repl)
}

// RenderExecute builds the Execute prompt for one step.
func RenderExecute(g *store.Graph, stepID string) string {
	desc, deps := "", ""
	for _, st := range g.Steps {
		if st.ID == stepID {
			desc = st.Description
			deps = yamlList(st.DependsOn)
			break
		}
	}
	repl := map[string]string{
		"goal_id":          g.Goal.ID,
		"goal_title":       g.Goal.Title,
		"goal_origin":      g.Goal.Origin,
		"goal_objective":   g.Goal.Objective,
		"step_id":          stepID,
		"step_description": desc,
		"depends_on":       deps,
		"graph_yaml":       renderGraphSection(g),
	}
	return render(executeTemplate, repl)
}

func renderGraphSection(g *store.Graph) string {
	var sb strings.Builder
	sb.WriteString("goal: ")
	sb.WriteString(g.Goal.Title)
	sb.WriteString(" (status: ")
	sb.WriteString(string(g.Goal.Status))
	sb.WriteString(")\norigin: ")
	sb.WriteString(g.Goal.Origin)
	sb.WriteString("\nobjective: ")
	sb.WriteString(g.Goal.Objective)
	sb.WriteString("\nfacts:\n")
	for _, f := range g.Facts {
		fmt.Fprintf(&sb, "  - %s: %s\n", f.ID, f.Content)
	}
	sb.WriteString("steps:\n")
	for _, st := range g.Steps {
		fmt.Fprintf(&sb, "  - %s [%s]: %s (depends_on: %s)\n", st.ID, st.Status, st.Description, strings.Join(st.DependsOn, ","))
	}
	sb.WriteString("findings:\n")
	for _, f := range g.Findings {
		fmt.Fprintf(&sb, "  - %s [%s] (from %s): %s\n", f.ID, f.Status, f.StepID, f.Content)
	}
	return sb.String()
}

func renderStepsSection(g *store.Graph) string {
	var sb strings.Builder
	for _, st := range g.Steps {
		if st.Status == fgs.StepPending || st.Status == fgs.StepRunning {
			fmt.Fprintf(&sb, "  - id: %s\n    description: %s\n    status: %s\n", st.ID, st.Description, st.Status)
		}
	}
	return sb.String()
}

func renderFindingsSection(g *store.Graph) string {
	var sb strings.Builder
	for _, f := range g.Findings {
		if f.Status == fgs.FindingOpen {
			fmt.Fprintf(&sb, "  - id: %s\n    content: %s\n    evidence: %s\n", f.ID, f.Content, f.Evidence)
		}
	}
	return sb.String()
}

func renderHintsSection(g *store.Graph) string {
	var sb strings.Builder
	for _, h := range g.Hints {
		fmt.Fprintf(&sb, "  - id: %s (%s): %s\n", h.ID, h.Creator, h.Content)
	}
	return sb.String()
}

func yamlList(ids []string) string {
	if len(ids) == 0 {
		return "[]"
	}
	parts := make([]string, len(ids))
	for i, s := range ids {
		parts[i] = fmt.Sprintf("%q", s)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}
