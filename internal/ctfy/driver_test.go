package ctfy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zhulongx/internal/pi"
)

func TestParseReport(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []Submitted
		bad  bool
	}{
		{name: "plain", in: `{"summary":"s","submitted":[{"question_id":"flag","answer":"ctfy{x}","verdict":"correct"}],"more_work":false}`,
			want: []Submitted{{QuestionID: "flag", Answer: "ctfy{x}", Verdict: "correct"}}},
		{name: "fenced", in: "```\n{\"summary\":\"s\",\"submitted\":[]}\n```", want: nil},
		{name: "prose then object", in: "I did things.\n{\"summary\":\"s\",\"submitted\":[]}", want: nil},
		{name: "two objects — last wins", in: `{"summary":"first"} {"summary":"second","submitted":[{"question_id":"q","answer":"a","verdict":"wrong"}]}`,
			want: []Submitted{{QuestionID: "q", Answer: "a", Verdict: "wrong"}}},
		{name: "braces inside strings", in: `{"summary":"payload {x} worked","submitted":[]}`, want: nil},
		{name: "garbage", in: "no json here at all", bad: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rep, err := ParseReport(tc.in)
			if tc.bad {
				if err == nil {
					t.Fatalf("expected error, got %+v", rep)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if len(rep.Submitted) != len(tc.want) {
				t.Fatalf("submitted = %+v, want %+v", rep.Submitted, tc.want)
			}
			for i := range tc.want {
				if rep.Submitted[i] != tc.want[i] {
					t.Fatalf("submitted[%d] = %+v, want %+v", i, rep.Submitted[i], tc.want[i])
				}
			}
		})
	}
}

func TestTaskParse(t *testing.T) {
	fixture := `{
  "schema_version": 3,
  "run_mode": "instance",
  "challenge": {"id": "CTFARENA-001", "name": "DocuVault", "description": "vault"},
  "competition_id": "arena",
  "questions": [{"id": "flag", "prompt": "The vault master secret"}],
  "gated_questions": 2,
  "scope": [],
  "deliverable": "an answer per question",
  "platform_url": "https://ctfy.example",
  "max_turns": 40,
  "target_instance": "3f9c",
  "target_endpoints": [{"label": "web", "type": "http", "url": "http://3f9c.ctfy.example:80"}],
  "attachments": [{"name": "crackme", "size": 14120, "path": "/ctfy/work/attachments/crackme"},
                  {"name": "dump.bin", "size": 900000, "path": null}]
}`
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "task.json"), []byte(fixture), 0o644); err != nil {
		t.Fatal(err)
	}
	task, err := LoadTask(dir)
	if err != nil {
		t.Fatal(err)
	}
	if task.RunMode != "instance" || task.Challenge.ID != "CTFARENA-001" || task.GatedQuestions != 2 {
		t.Fatalf("task decode off: %+v", task)
	}
	if task.MaxTurns == nil || *task.MaxTurns != 40 {
		t.Fatalf("max_turns = %v", task.MaxTurns)
	}
	if len(task.Attachments) != 2 || task.Attachments[1].Path != nil {
		t.Fatalf("attachments off: %+v", task.Attachments)
	}
}

func TestStateRoundTripAndRecord(t *testing.T) {
	dir := t.TempDir()
	st := NewState()
	progress := st.Record(Submission{QuestionID: "q1", Answer: "a1", Verdict: "wrong"})
	if !progress || st.Wrong["q1"] != 1 || st.IsSolved("q1") {
		t.Fatalf("wrong verdict not recorded: %+v", st)
	}
	progress = st.Record(Submission{QuestionID: "q1", Answer: "a1", Verdict: "correct"})
	if !progress || !st.IsSolved("q1") {
		t.Fatalf("correct verdict not solved: %+v", st)
	}
	if st.Record(Submission{QuestionID: "q1", Answer: "a1", Verdict: "correct"}) {
		t.Fatal("duplicate correct is not progress")
	}
	if err := st.Save(dir); err != nil {
		t.Fatal(err)
	}
	got, err := LoadState(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !got.IsSolved("q1") || got.Wrong["q1"] != 1 || got.Sessions != 0 {
		t.Fatalf("roundtrip lost state: %+v", got)
	}
}

func TestResultWrite(t *testing.T) {
	dir := t.TempDir()
	r := Result{Answers: map[string]string{"q": "a"}, Solved: []string{"q"}, FullySolved: true, StopReason: "done"}
	r.Writeup = strings.Repeat("w", 10_000)
	if err := WriteResult(dir, r); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "result.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got Result
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.SchemaVersion != 3 || got.FullySolved != true || len(got.Writeup) > maxWriteup+20 {
		t.Fatalf("result off: %+v", got)
	}
}

// fakePrompter scripts one PromptResult per session.
type fakePrompter struct {
	texts []string
	i     int
}

func (f *fakePrompter) Prompt(ctx context.Context, msg string) (*pi.PromptResult, error) {
	if f.i >= len(f.texts) {
		return &pi.PromptResult{Text: `{"summary":"exhausted","submitted":[]}`}, nil
	}
	t := f.texts[f.i]
	f.i++
	return &pi.PromptResult{Text: t, ToolCalls: 3}, nil
}
func (f *fakePrompter) Close() error { return nil }

// fakeAPI scripts gated refreshes.
type fakeAPI struct {
	refreshes [][]Question
	comp      []CompetitionInfo
	calls     int
	targets   []AWDTarget
}

func (f *fakeAPI) ChallengeRefresh(ctx context.Context, id string) ([]Question, int, error) {
	if len(f.refreshes) == 0 {
		return nil, 0, os.ErrNotExist
	}
	qs := f.refreshes[0]
	f.refreshes = f.refreshes[1:]
	return qs, 0, nil
}
func (f *fakeAPI) CompetitionState(ctx context.Context, id string) (CompetitionInfo, error) {
	return CompetitionInfo{PlayOpen: true}, nil
}
func (f *fakeAPI) AWDTargets(ctx context.Context, compID string) ([]AWDTarget, error) {
	return f.targets, nil
}

// fakeMCP scripts the MCP surface.
type fakeMCP struct {
	fail      bool
	submitted []string          // flags handed to submit_awd_flags
	responses map[string]string // tool -> text
	calls     []string
}

func (f *fakeMCP) CallTool(ctx context.Context, tool string, candidates map[string]any) (string, error) {
	f.calls = append(f.calls, tool)
	if f.fail {
		return "", errors.New("mcp down")
	}
	if tool == "submit_awd_flags" {
		if flags, ok := candidates["flags"].([]string); ok {
			f.submitted = append(f.submitted, flags...)
		}
	}
	if r, ok := f.responses[tool]; ok {
		return r, nil
	}
	return `{}`, nil
}
func (f *fakeMCP) HasTool(ctx context.Context, tool string) bool { return true }

func newTestDriver(t *testing.T, mode string, texts []string, api API) (*Driver, string) {
	t.Helper()
	dir := t.TempDir()
	readme := "README: do the thing. answers go to POST /api/v1/submissions"
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte(readme), 0o644); err != nil {
		t.Fatal(err)
	}
	task := &Task{
		SchemaVersion:  3,
		RunMode:        mode,
		Challenge:      ChallengeRef{ID: "C-1"},
		Questions:      []Question{{ID: "flag", Prompt: "the flag"}},
		GatedQuestions: 0,
	}
	env := Env{WorkDir: dir, ChallengeID: "C-1", PlatformURL: "https://x", Token: "t"}
	fp := &fakePrompter{texts: texts}
	d := &Driver{
		env:       env,
		task:      task,
		questions: append([]Question(nil), task.Questions...),
		api:       api,
		state:     NewState(),
		newPrompt: func() (Prompter, error) { return fp, nil },
		log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:       time.Now,
		readme:    readme,
		doctrine:  "test doctrine",
		budgets:   budgetsFor(mode, nil),
	}
	// shrink timeouts so failures stay fast
	d.budgets.sleepBetween = time.Millisecond
	return d, dir
}

func TestDriverSolvesAndStops(t *testing.T) {
	d, dir := newTestDriver(t, "instance", []string{
		`{"summary":"got it","submitted":[{"question_id":"flag","answer":"ctfy{a}","verdict":"correct"}],"more_work":false}`,
	}, &fakeAPI{})
	reason := d.Run(context.Background())
	if reason != ReasonDone {
		t.Fatalf("reason = %s, want done", reason)
	}
	if !d.State().IsSolved("flag") {
		t.Fatal("flag not solved in state")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "state", "state.json"))
	if !strings.Contains(string(raw), "ctfy{a}") {
		t.Fatalf("state file missing answer: %s", raw)
	}
}

func TestDriverNoProgressStops(t *testing.T) {
	d, _ := newTestDriver(t, "instance", []string{
		`{"summary":"nothing","submitted":[],"more_work":false}`,
		`{"summary":"still nothing","submitted":[],"more_work":false}`,
		`{"summary":"dead end","submitted":[],"more_work":false}`,
	}, &fakeAPI{})
	reason := d.Run(context.Background())
	if reason != ReasonNoProgress {
		t.Fatalf("reason = %s, want no_progress", reason)
	}
	if d.State().Sessions != 3 {
		t.Fatalf("sessions = %d", d.State().Sessions)
	}
}

func TestDriverMoreWorkKeepsGoing(t *testing.T) {
	d, _ := newTestDriver(t, "instance", []string{
		`{"summary":"working","submitted":[],"more_work":true}`,
		`{"summary":"done","submitted":[{"question_id":"flag","answer":"x","verdict":"correct"}],"more_work":false}`,
	}, &fakeAPI{})
	reason := d.Run(context.Background())
	if reason != ReasonDone {
		t.Fatalf("reason = %s, want done", reason)
	}
	if d.State().NoProgress != 0 {
		t.Fatalf("more_work session counted as no-progress: %d", d.State().NoProgress)
	}
}

func TestDriverGatedUnlock(t *testing.T) {
	api := &fakeAPI{refreshes: [][]Question{
		{{ID: "flag", Prompt: "the flag"}, {ID: "secret", Prompt: "newly unlocked"}},
	}}
	d, _ := newTestDriver(t, "instance", []string{
		// session 1: solves visible question; refresh (from checkStop's
		// all-solved path or post-correct path) reveals "secret"
		`{"summary":"first","submitted":[{"question_id":"flag","answer":"x","verdict":"correct"}],"more_work":true}`,
		// session 2: solves the unlocked one
		`{"summary":"second","submitted":[{"question_id":"secret","answer":"y","verdict":"correct"}],"more_work":false}`,
	}, api)
	d.task.GatedQuestions = 1
	reason := d.Run(context.Background())
	if reason != ReasonDone {
		t.Fatalf("reason = %s, want done", reason)
	}
	if !d.State().IsSolved("secret") {
		t.Fatal("unlocked question never solved")
	}
}

func TestDriverAWDRunsUntilMatchOver(t *testing.T) {
	d, _ := newTestDriver(t, "awd", []string{
		`{"summary":"round tick","submitted":[],"more_work":true}`,
		`{"summary":"match ended","submitted":[],"more_work":false,"match_over":true}`,
	}, &fakeAPI{})
	reason := d.Run(context.Background())
	if reason != ReasonMatchOver {
		t.Fatalf("reason = %s, want match_over", reason)
	}
}

func TestDriverAWDCompetitionClock(t *testing.T) {
	api := &struct{ fakeAPI }{}
	api.comp = nil
	d, _ := newTestDriver(t, "awd", []string{
		`{"summary":"t1","submitted":[],"more_work":true}`,
		`{"summary":"t2","submitted":[],"more_work":true,"match_over":true}`,
	}, api)
	reason := d.Run(context.Background())
	if reason != ReasonMatchOver {
		t.Fatalf("reason = %s, want match_over (agent report is the backstop)", reason)
	}
}

func TestDriverAWDBanksFlags(t *testing.T) {
	d, _ := newTestDriver(t, "awd", []string{
		`{"summary":"reaped box 5","submitted":[],"flags":[{"value":"ctfy{r1}","host":"10.0.0.5"}],"more_work":true}`,
		`{"summary":"same value again, match over","submitted":[],"flags":[{"value":"ctfy{r1}","host":"10.0.0.5"}],"more_work":false,"match_over":true}`,
	}, &fakeAPI{})
	mcp := &fakeMCP{}
	d.mcp = mcp
	reason := d.Run(context.Background())
	if reason != ReasonMatchOver {
		t.Fatalf("reason = %s, want match_over", reason)
	}
	if len(mcp.submitted) != 1 {
		t.Fatalf("flags submitted = %v, want exactly one bank", mcp.submitted)
	}
	st := d.State()
	if len(st.AWDFlags) != 1 || st.AWDFlags[0].Verdict != "banked" {
		t.Fatalf("awd flag records = %+v", st.AWDFlags)
	}
	if !strings.Contains(strings.Join(mcp.calls, ","), "get_awd_match") {
		t.Fatalf("match clock never synced: %v", mcp.calls)
	}
}

func TestDriverAWDBanksFlagsWithoutMCP(t *testing.T) {
	// no MCP surface at all: flags are still recorded (pending) so the
	// ledger survives and later rounds do not lose them.
	d, _ := newTestDriver(t, "awd", []string{
		`{"summary":"cap","submitted":[],"flags":[{"value":"ctfy{x}"}],"more_work":true}`,
		`{"summary":"over","submitted":[],"more_work":false,"match_over":true}`,
	}, &fakeAPI{})
	reason := d.Run(context.Background())
	if reason != ReasonMatchOver {
		t.Fatalf("reason = %s", reason)
	}
	if len(d.State().AWDFlags) != 1 || d.State().AWDFlags[0].Verdict != "pending" {
		t.Fatalf("records = %+v", d.State().AWDFlags)
	}
}

func TestDriverAWDMatchClockStopsRun(t *testing.T) {
	d, _ := newTestDriver(t, "awd", []string{
		`{"summary":"work","submitted":[],"more_work":true}`,
	}, &fakeAPI{})
	// clock expired long ago -> first checkStop ends the run with zero sessions
	start := d.now().Add(-3 * time.Hour)
	d.match = &awdMatch{
		StartsAt: start, TickSeconds: 60, TickCount: 60,
		EndsAt: start.Add(60 * time.Minute), CurrentTick: 60, Known: true,
	}
	reason := d.Run(context.Background())
	if reason != ReasonMatchOver {
		t.Fatalf("reason = %s, want match_over from clock math", reason)
	}
	if d.State().Sessions != 0 {
		t.Fatalf("sessions = %d, want 0", d.State().Sessions)
	}
}

func TestDriverAWDTargetSyncIntoMission(t *testing.T) {
	api := &fakeAPI{targets: []AWDTarget{
		{Address: "10.0.0.9", Team: "us", IsOwn: true},
		{Address: "10.0.0.2", Team: "rival-a"},
	}}
	var captured string
	fp := &fakePrompter{texts: []string{`{"summary":"over","submitted":[],"more_work":false,"match_over":true}`}}
	dir := t.TempDir()
	readme := "README: awd"
	os.WriteFile(filepath.Join(dir, "README.md"), []byte(readme), 0o644)
	task := &Task{RunMode: "awd", Challenge: ChallengeRef{ID: "C-1"}}
	d := &Driver{
		env:  Env{WorkDir: dir, ChallengeID: "C-1", CompetitionID: "comp-1", PlatformURL: "https://x", Token: "t"},
		task: task, questions: nil, api: api, state: NewState(),
		newPrompt: func() (Prompter, error) {
			return promptSpy{fp, &captured}, nil
		},
		log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		now:     time.Now,
		readme:  readme,
		budgets: budgetsFor("awd", nil),
	}
	d.budgets.sleepBetween = time.Millisecond
	reason := d.Run(context.Background())
	if reason != ReasonMatchOver {
		t.Fatalf("reason = %s", reason)
	}
	for _, want := range []string{"10.0.0.9", "OURS", "10.0.0.2", "rival", `"flags"`} {
		if !strings.Contains(captured, want) {
			t.Errorf("mission missing %q", want)
		}
	}
}

// promptSpy records the last mission text handed to the agent.
type promptSpy struct {
	inner *fakePrompter
	last  *string
}

func (p promptSpy) Prompt(ctx context.Context, msg string) (*pi.PromptResult, error) {
	*p.last = msg
	return p.inner.Prompt(ctx, msg)
}
func (p promptSpy) Close() error { return nil }

func TestBuildMissionCarriesEverything(t *testing.T) {
	st := NewState()
	st.Record(Submission{QuestionID: "q1", Answer: "a", Verdict: "wrong"})
	path := "/ctfy/work/attachments/crackme"
	o := MissionOptions{
		Mode: "instance", Round: 2, SessionsCap: 12,
		TargetURL: "http://t:80", TargetInst: "3f9c",
		Endpoints:   []Endpoint{{Label: "web", Type: "http", URL: "http://t:80"}},
		Attachments: []Attachment{{Name: "crackme", Size: 10, Path: &path}},
		README:      "README: attack the vault",
		Doctrine:    "DOCTRINE-MARKER",
	}
	m := BuildMission([]Question{{ID: "q1", Prompt: "get the flag"}}, st, o)
	for _, want := range []string{
		"README: attack the vault", "DOCTRINE-MARKER", "3f9c", "http://t:80",
		"crackme", "wrong attempts recorded", "attack/<question-id>/work.md",
		`"more_work"`, "mode=instance",
	} {
		if !strings.Contains(m, want) {
			t.Errorf("mission missing %q", want)
		}
	}
}
