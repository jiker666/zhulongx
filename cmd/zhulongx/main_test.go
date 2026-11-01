package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"zhulongx/internal/bench"
	"zhulongx/internal/cfg"
	"zhulongx/internal/engine"
	"zhulongx/internal/store"
)

// fastLaneFixture stands an httptest platform behind the real bench client
// and gate, then drives wireFlagFastLane through the engine's OnFlagCandidate
// hook the way the engine's flag harvest does.
type fastLaneFixture struct {
	srv    *httptest.Server
	client *bench.Client
	gate   *bench.SlotGate
	engine *engine.Engine
	store  *store.Store

	mu       sync.Mutex
	status   string // a-01 container status served by the platform
	submits  []string
}

func newFastLaneFixture(t *testing.T, initialStatus string) *fastLaneFixture {
	t.Helper()
	f := &fastLaneFixture{status: initialStatus}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/challenges") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode([]bench.Challenge{{
				UniqueCode:       "a-01",
				ContainerStatus:  f.platformStatus(),
				FlagCount:        1,
				CorrectFlagCount: 0,
			}})
		case strings.HasSuffix(r.URL.Path, "/challenges/submit") && r.Method == http.MethodPost:
			var body struct {
				UniqueCode string `json:"unique_code"`
				Flag       string `json:"flag"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.recordSubmit(body.Flag)
			_ = json.NewEncoder(w).Encode(bench.SubmitResult{Correct: true, CorrectFlagCount: 1, TotalFlagCount: 1})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.srv.Close)

	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	f.store = st

	bc, err := bench.NewClient(f.srv.URL, "test-token")
	if err != nil {
		t.Fatal(err)
	}
	f.client = bc
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	f.gate = bench.NewSlotGate(st, bc, 3, log)
	e := engine.New(st, cfg.Default(), log, nil)
	f.engine = e
	wireFlagFastLane(e, bc, f.gate, log)
	return f
}

func (f *fastLaneFixture) platformStatus() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status
}

func (f *fastLaneFixture) recordSubmit(flag string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.submits = append(f.submits, flag)
}

func (f *fastLaneFixture) submitted() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.submits...)
}

func (f *fastLaneFixture) setStatus(s string) {
	f.mu.Lock()
	f.status = s
	f.mu.Unlock()
}

func TestFastLaneDefersFlagUntilContainerLive(t *testing.T) {
	// Run 42778's first cut of the gate: a flag landing while no container
	// was live was marked submitted and dropped forever. The value must
	// instead wait for the container and go out the moment it is live.
	f := newFastLaneFixture(t, "stopped")
	ctx := context.Background()
	if _, err := f.store.CreateGoal(ctx, "bench:a-01", "o", "obj"); err != nil {
		t.Fatal(err)
	}

	f.engine.OnFlagCandidate(ctx, "bench:a-01", "flag{deferred}")
	if got := f.submitted(); len(got) != 0 {
		t.Fatalf("a flag against a stopped container must not fire: %v", got)
	}

	// Container comes live; the next snapshot pump must flush the value.
	f.setStatus("running")
	f.gate.Refresh(ctx)
	if got := f.submitted(); len(got) != 1 || got[0] != "flag{deferred}" {
		t.Fatalf("deferred flag must flush once its container is live: %v", got)
	}

	// And it must fire exactly once, not again on later arrivals.
	f.engine.OnFlagCandidate(ctx, "bench:a-01", "flag{deferred}")
	if got := f.submitted(); len(got) != 1 {
		t.Fatalf("a submitted value must never be re-fired: %v", got)
	}
}

func TestFastLaneSubmitsOncePerValueWhenLive(t *testing.T) {
	f := newFastLaneFixture(t, "running")
	ctx := context.Background()
	if _, err := f.store.CreateGoal(ctx, "bench:a-01", "o", "obj"); err != nil {
		t.Fatal(err)
	}
	f.gate.Allow(ctx, mustGoalID(t, f.store, "bench:a-01")) // first poll populates the snapshot

	f.engine.OnFlagCandidate(ctx, "bench:a-01", "flag{direct}")
	f.engine.OnFlagCandidate(ctx, "bench:a-01", "flag{direct}")
	if got := f.submitted(); len(got) != 1 || got[0] != "flag{direct}" {
		t.Fatalf("live-container flag must fire exactly once: %v", got)
	}
}

func mustGoalID(t *testing.T, st *store.Store, title string) string {
	t.Helper()
	goals, err := st.ListGoals(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range goals {
		if g.Title == title {
			return g.ID
		}
	}
	t.Fatalf("goal %q not found", title)
	return ""
}

func TestFastLaneFlushTerminatesWhenPendingNeverGoesLive(t *testing.T) {
	// Regression: flushPending's first cut re-scanned the pending map and
	// re-selected the same non-submittable entry forever — a livelock that
	// surfaced as a 10-minute go test timeout. A pending code that never
	// goes live must simply stay deferred, and the pump must return.
	f := newFastLaneFixture(t, "stopped")
	ctx := context.Background()
	if _, err := f.store.CreateGoal(ctx, "bench:a-01", "o", "obj"); err != nil {
		t.Fatal(err)
	}
	f.engine.OnFlagCandidate(ctx, "bench:a-01", "flag{stuck}")
	if got := f.submitted(); len(got) != 0 {
		t.Fatalf("nothing may fire against a stopped container: %v", got)
	}

	done := make(chan struct{})
	go func() {
		f.gate.Refresh(ctx) // status is still stopped: pump must return, not spin
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("flushPending must terminate when a pending code never goes live")
	}
	if got := f.submitted(); len(got) != 0 {
		t.Fatalf("the deferred value must not fire while its container is down: %v", got)
	}

	// And it must still flush the moment the container finally comes up.
	f.setStatus("running")
	f.gate.Refresh(ctx)
	if got := f.submitted(); len(got) != 1 || got[0] != "flag{stuck}" {
		t.Fatalf("deferred value must flush once live: %v", got)
	}
}
