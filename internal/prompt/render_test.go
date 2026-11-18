package prompt

import (
	"strings"
	"testing"

	"zhulongx/internal/fgs"
	"zhulongx/internal/store"
)

// Run 46631: the engine pays 10% of a title's score to pre-seed a requeued
// pass with the platform hint (AddHint), but RenderExecute never rendered
// the hints table — the only mode that does the work never saw what was
// bought (b-02 and c-09 each burned a pull this way). The hint text MUST
// reach the Execute brief.
func TestRenderExecuteIncludesHints(t *testing.T) {
	g := &store.Graph{
		Goal: fgs.Goal{ID: "goal_1", Title: "bench:x-01", Origin: "test", Objective: "obj", Status: fgs.GoalActive},
		Steps: []fgs.Step{
			{ID: "s_0001", Description: "attack", Status: fgs.StepRunning},
		},
		Hints: []fgs.Hint{
			{ID: "h_0001", GoalID: "goal_1", Content: "CVE-2023-51467 is the way in", Creator: "engine"},
		},
	}
	out := RenderExecute(g, "s_0001")
	if !strings.Contains(out, "Platform hints already paid for") {
		t.Fatalf("execute brief must carry the hints section header")
	}
	if !strings.Contains(out, "CVE-2023-51467 is the way in") {
		t.Fatalf("execute brief must contain the seeded hint text, got:\n%s", out[:min(400, len(out))])
	}
}

func TestRenderExecuteWithoutHintsRendersCleanly(t *testing.T) {
	g := &store.Graph{
		Goal: fgs.Goal{ID: "goal_1", Title: "bench:x-01", Origin: "test", Objective: "obj", Status: fgs.GoalActive},
		Steps: []fgs.Step{
			{ID: "s_0001", Description: "attack", Status: fgs.StepRunning},
		},
	}
	out := RenderExecute(g, "s_0001")
	if !strings.Contains(out, "Platform hints already paid for") {
		t.Fatalf("section header should still render (empty list)")
	}
	if strings.Contains(out, "h_0001") {
		t.Fatalf("no hint ids expected, got:\n%s", out[:min(400, len(out))])
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
