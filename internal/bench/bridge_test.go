package bench

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"zhulongx/internal/fgs"
	"zhulongx/internal/store"
)

// platformStub serves a mutable challenge list so tests can flip
// completion state between calls.
type platformStub struct {
	srv  *httptest.Server
	mu   sync.Mutex
	list string
}

func newPlatformStub(t *testing.T, list string) *platformStub {
	t.Helper()
	p := &platformStub{list: list}
	mux := http.NewServeMux()
	mux.HandleFunc("/openapi/v1/challenges", func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		defer p.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(p.list))
	})
	p.srv = httptest.NewServer(mux)
	t.Cleanup(p.srv.Close)
	return p
}

func (p *platformStub) set(list string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.list = list
}

func client(t *testing.T, url string) *Client {
	t.Helper()
	c, err := NewClient(url, "test-token")
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatalf("OpenMemory: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

const twoChallenges = `[
 {"unique_code":"web_01","description":"sqli","difficulty":"easy","level":1,
  "total_score":100,"flag_count":2,"correct_flag_count":0,"is_completed":false,
  "container_status":"stopped","container_addr":[]},
 {"unique_code":"crypto_02","description":null,"difficulty":"hard","level":3,
  "total_score":200,"flag_count":1,"correct_flag_count":0,"is_completed":false,
  "container_status":"stopped","container_addr":[]}
]`

func goalByTitle(t *testing.T, st *store.Store, title string) *fgs.Goal {
	t.Helper()
	goals, err := st.ListGoals(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for i := range goals {
		if goals[i].Title == title {
			return &goals[i]
		}
	}
	t.Fatalf("goal %q not found", title)
	return nil
}

func TestImportCreatesGoalsWithBriefAndIsIdempotent(t *testing.T) {
	st := openStore(t)
	p := newPlatformStub(t, twoChallenges)
	c := client(t, p.srv.URL)

	n, err := Import(context.Background(), st, c)
	if err != nil || n != 2 {
		t.Fatalf("Import = %d, %v; want 2, nil", n, err)
	}
	// Re-import: nothing new.
	if n, err := Import(context.Background(), st, c); err != nil || n != 0 {
		t.Fatalf("re-Import = %d, %v; want 0, nil", n, err)
	}

	goals, err := st.ListGoals(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(goals) != 2 {
		t.Fatalf("want 2 goals, got %d", len(goals))
	}
	web := goalByTitle(t, st, "bench:web_01")
	// The brief must carry the operating manual, but never a token.
	for _, want := range []string{
		"web_01", "sqli", "easy", p.srv.URL,
		"/openapi/v1/challenges/start?unique_code=web_01",
		"/openapi/v1/challenges/hint?unique_code=web_01",
		"/openapi/v1/challenges/submit",
		"/openapi/v1/challenges/close?unique_code=web_01",
		"BENCHMARK_TOKEN", "VPN", "duplicate",
	} {
		if !strings.Contains(web.Origin, want) {
			t.Errorf("brief missing %q", want)
		}
	}
	if strings.Contains(web.Origin, "test-token") {
		t.Error("brief leaks the token")
	}
	if !strings.Contains(web.Objective, "is_completed=true") ||
		!strings.Contains(web.Objective, "2 个 flag") {
		t.Errorf("objective wrong: %q", web.Objective)
	}
}

func TestImportLeavesNonBenchGoalsAlone(t *testing.T) {
	st := openStore(t)
	if _, err := st.CreateGoal(context.Background(), "my own goal", "o", "g"); err != nil {
		t.Fatal(err)
	}
	p := newPlatformStub(t, twoChallenges)
	n, err := Import(context.Background(), st, client(t, p.srv.URL))
	if err != nil || n != 2 {
		t.Fatalf("Import = %d, %v", n, err)
	}
	goals, _ := st.ListGoals(context.Background())
	if len(goals) != 3 {
		t.Fatalf("want 3 goals (1 mine + 2 bench), got %d", len(goals))
	}
	// And re-import still skips: only 2 bench titles exist.
	if n, _ := Import(context.Background(), st, client(t, p.srv.URL)); n != 0 {
		t.Errorf("re-import created %d", n)
	}
}

func TestSyncCompletesPlatformConfirmedGoals(t *testing.T) {
	st := openStore(t)
	p := newPlatformStub(t, twoChallenges)
	c := client(t, p.srv.URL)
	if _, err := Import(context.Background(), st, c); err != nil {
		t.Fatal(err)
	}

	// Platform now reports web_01 fully solved, crypto_02 still open.
	p.set(`[
 {"unique_code":"web_01","description":"sqli","difficulty":"easy","level":1,
  "total_score":100,"flag_count":2,"correct_flag_count":2,"is_completed":true,
  "container_status":"stopped","container_addr":[]},
 {"unique_code":"crypto_02","description":null,"difficulty":"hard","level":3,
  "total_score":200,"flag_count":1,"correct_flag_count":0,"is_completed":false,
  "container_status":"available","container_addr":["10.9.9.9:22"]}
]`)

	rep, err := Sync(context.Background(), st, c)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if len(rep.Completed) != 1 || !strings.Contains(rep.Completed[0], "web_01") {
		t.Errorf("Completed = %v", rep.Completed)
	}
	if rep.InProgress != 1 || rep.Mismatched != nil || rep.Missing != nil {
		t.Errorf("report = %+v", rep)
	}

	web := goalByTitle(t, st, "bench:web_01")
	if web.Status != fgs.GoalCompleted || web.CompletedAt == nil {
		t.Fatalf("web_01 not completed: %+v", web)
	}
	facts, err := st.ListFacts(context.Background(), web.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range facts {
		if strings.Contains(f.Content, "平台确认通关") && strings.Contains(f.Content, "web_01") {
			found = true
		}
	}
	if !found {
		t.Errorf("completion fact missing: %+v", facts)
	}
}

func TestSyncReportsMismatchAndMissing(t *testing.T) {
	st := openStore(t)
	p := newPlatformStub(t, twoChallenges)
	c := client(t, p.srv.URL)
	if _, err := Import(context.Background(), st, c); err != nil {
		t.Fatal(err)
	}

	// Locally complete crypto_02 (agent judgement), but the platform
	// still lists it incomplete → mismatch, never auto-reopened.
	crypto := goalByTitle(t, st, "bench:crypto_02")
	f, err := st.AddHumanFact(context.Background(), crypto.ID, "agent claims done", "test")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CompleteGoal(context.Background(), crypto.ID, []string{f.ID}, "agent says all flags in", "test"); err != nil {
		t.Fatal(err)
	}

	// Platform list loses web_01 and keeps crypto_02 incomplete.
	p.set(`[
 {"unique_code":"crypto_02","description":null,"difficulty":"hard","level":3,
  "total_score":200,"flag_count":1,"correct_flag_count":0,"is_completed":false,
  "container_status":"stopped","container_addr":[]}
]`)

	rep, err := Sync(context.Background(), st, c)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if len(rep.Mismatched) != 1 || !strings.Contains(rep.Mismatched[0], "crypto_02") {
		t.Errorf("Mismatched = %v", rep.Mismatched)
	}
	if len(rep.Missing) != 1 || !strings.Contains(rep.Missing[0], "web_01") {
		t.Errorf("Missing = %v", rep.Missing)
	}
	if rep.InProgress != 0 || rep.Completed != nil {
		t.Errorf("report = %+v", rep)
	}
	// crypto_02 stays completed: sync only reports a mismatch, it never
	// rolls a goal back.
	if g := goalByTitle(t, st, "bench:crypto_02"); g.Status != fgs.GoalCompleted {
		t.Errorf("crypto_02 status changed to %s", g.Status)
	}
}

func TestSyncRepeatedIsStable(t *testing.T) {
	st := openStore(t)
	p := newPlatformStub(t, twoChallenges)
	c := client(t, p.srv.URL)
	if _, err := Import(context.Background(), st, c); err != nil {
		t.Fatal(err)
	}
	p.set(`[
 {"unique_code":"web_01","description":"sqli","difficulty":"easy","level":1,
  "total_score":100,"flag_count":2,"correct_flag_count":2,"is_completed":true,
  "container_status":"stopped","container_addr":[]},
 {"unique_code":"crypto_02","description":null,"difficulty":"hard","level":3,
  "total_score":200,"flag_count":1,"correct_flag_count":1,"is_completed":true,
  "container_status":"stopped","container_addr":[]}
]`)
	for i := 0; i < 3; i++ {
		rep, err := Sync(context.Background(), st, c)
		if err != nil {
			t.Fatalf("sync %d: %v", i, err)
		}
		// Rounds after the first: nothing new to complete, and both
		// local completions are platform-confirmed → no mismatches.
		if i > 0 && (len(rep.Completed) != 0 || len(rep.Mismatched) != 0) {
			t.Errorf("sync %d unstable: %+v", i, rep)
		}
	}
	for _, title := range []string{"bench:web_01", "bench:crypto_02"} {
		if g := goalByTitle(t, st, title); g.Status != fgs.GoalCompleted {
			t.Errorf("%s status = %s", title, g.Status)
		}
	}
}
