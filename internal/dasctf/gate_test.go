package dasctf

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"zhulongx/internal/store"
)

func slogNop() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func envelope(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"code": CodeOK, "message": "", "data": data})
}

// newMock spins a platform serving two exercises: 1 offline (no env) and
// 2 env-backed whose build is async: it lands one detail-poll AFTER the
// build POST (the poll that raced the build still sees isNeedCheck=true).
func newMock(t *testing.T) (*Client, *store.Store, *int32, *int32) {
	t.Helper()
	var builds, recovers, detailsAfterBuild int32
	envLive := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/slab-match/api/v1/agent/ctf/exercise-list":
			envelope(w, []map[string]any{{
				"id": 100, "name": "CRYPTO", "order": 1,
				"corpus": []map[string]any{
					{"id": 1, "name": "offline-one", "order": 1, "isOpen": true, "hasSolved": false},
					{"id": 2, "name": "web-one", "order": 2, "isOpen": true, "hasSolved": false},
				},
			}})
		case r.URL.Path == "/slab-match/api/v1/agent/ctf/exercise":
			id := r.URL.Query().Get("exerciseId")
			if id == "1" {
				envelope(w, map[string]any{
					"id": 1, "name": "offline-one", "description": "d", "hasSolved": false,
					"score": "300", "difficulty": "HARD", "endpointType": "none",
					"attachment": map[string]any{"files": []map[string]any{{"name": "a.zip", "url": "https://x/a.zip", "ext": "zip"}}},
					"isNeedInit": false, "isNeedCheck": false,
				})
				return
			}
			eps := []map[string]any{}
			needCheck := !envLive
			if atomic.LoadInt32(&builds) > 0 && !envLive {
				// Async build: visible as live from the SECOND detail poll
				// after the build POST onward.
				if atomic.AddInt32(&detailsAfterBuild, 1) >= 2 {
					envLive = true
				}
			}
			needCheck = !envLive
			if envLive {
				eps = append(eps, map[string]any{
					"exposeIps": []string{"10.0.0.9"}, "ports": []string{"80"},
					"portMappings": []map[string]any{{"type": "tcp", "port": "80", "proxy": "30080"}},
					"proxyIps":     []string{"1.2.3.4"}, "isProxy": true,
					"expireTime": time.Now().Add(30 * time.Minute).UnixMilli(),
				})
			}
			envelope(w, map[string]any{
				"id": 2, "name": "web-one", "description": "d2", "hasSolved": false,
				"score": "300", "difficulty": "HARD", "endpointType": "monopoly",
				"endpoints": eps, "isNeedInit": true, "isNeedCheck": needCheck,
			})
		case r.URL.Path == "/slab-match/api/v1/agent/ctf/build-exercise-env":
			atomic.AddInt32(&builds, 1) // async: visible on a later detail poll
			envelope(w, map[string]any{})
		case r.URL.Path == "/slab-match/api/v1/agent/ctf/recover-exercise-env":
			atomic.AddInt32(&recovers, 1)
			envLive = false
			envelope(w, map[string]any{})
		case r.URL.Path == "/slab-match/api/v1/agent/answer-panel/answer":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["flag"] == "DASCTF{0123456789abcdef}" && body["exerciseId"] == float64(1) {
				envelope(w, map[string]any{"isCorrect": true})
				return
			}
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": "A0001", "message": "答案错误", "data": nil})
		default:
			t.Fatalf("unexpected platform call %s", r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)
	c, err := NewClient(srv.URL, "ak_test")
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(t.TempDir() + "\\test.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return c, st, &builds, &recovers
}

func TestClientListFlattenAndAnswer(t *testing.T) {
	c, _, _, _ := newMock(t)
	ctx := context.Background()
	exs, err := c.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(exs) != 2 {
		t.Fatalf("want 2 exercises, got %d", len(exs))
	}
	if exs[0].Category != "CRYPTO" || exs[1].ID != 2 {
		t.Fatalf("flatten wrong: %+v", exs)
	}
	res, err := c.Answer(ctx, 1, "DASCTF{0123456789abcdef}")
	if err != nil || !res.IsCorrect {
		t.Fatalf("correct answer rejected: %+v %v", res, err)
	}
	if _, err := c.Answer(ctx, 1, "DASCTF{nope}"); err == nil || !CodeIs(err, "A0001") {
		t.Fatalf("wrong answer must surface APIError A0001, got %v", err)
	}
	if _, err := c.Answer(ctx, 1, strings.Repeat("x", 300)); err == nil {
		t.Fatal("over-length flag must be rejected client-side")
	}
}

func TestImportIdempotentWithBrief(t *testing.T) {
	c, st, _, _ := newMock(t)
	ctx := context.Background()
	n, err := Import(ctx, st, c, nil)
	if err != nil || n != 2 {
		t.Fatalf("first import: n=%d err=%v", n, err)
	}
	n, err = Import(ctx, st, c, nil)
	if err != nil || n != 0 {
		t.Fatalf("second import must be idempotent: n=%d err=%v", n, err)
	}
	goals, _ := st.ListGoals(ctx)
	for _, g := range goals {
		id, ok := CodeOfTitle(g.Title)
		if !ok {
			t.Fatalf("title %q lacks prefix", g.Title)
		}
		if id == 1 && !strings.Contains(g.Origin, "a.zip") {
			t.Fatalf("offline brief must carry attachment url: %s", g.Origin)
		}
		if id == 1 && !strings.Contains(g.Origin, "endpointType=none") {
			t.Fatalf("offline brief must say offline: %s", g.Origin)
		}
		if id == 2 && !strings.Contains(g.Origin, "靶机环境") {
			t.Fatalf("env brief must mention env: %s", g.Origin)
		}
		if strings.Contains(g.Origin, "ak_test") {
			t.Fatal("brief must never contain the access key")
		}
	}
}

func TestGateOfflineAlwaysAllowedEnvBackedWaitsForBuild(t *testing.T) {
	c, st, builds, recovers := newMock(t)
	ctx := context.Background()
	if _, err := Import(ctx, st, c, nil); err != nil {
		t.Fatal(err)
	}
	g := NewGate(st, c, slogNop())
	g.pollTTL = 0 // poll every call: deterministic
	goals, _ := st.ListGoals(ctx)
	byTitle := map[string]string{}
	for _, gl := range goals {
		byTitle[gl.Title] = gl.ID
	}
	offline := byTitle["dasctf:1"]
	web := byTitle["dasctf:2"]

	if !g.Allow(ctx, offline) {
		t.Fatal("offline exercise must always be admissible")
	}
	if atomic.LoadInt32(builds) != 0 {
		t.Fatal("offline exercise must never trigger a build")
	}
	// First Allow on env-backed: build fires, admission denied (env still
	// "building" per snapshot taken before the build landed).
	if g.Allow(ctx, web) {
		t.Fatal("env-backed must wait while its env is not live")
	}
	if atomic.LoadInt32(builds) != 1 {
		t.Fatalf("want 1 build, got %d", atomic.LoadInt32(builds))
	}
	// Cooldown holds: no second build even though env is still not live in
	// the gate's cache.
	g.lastBuild[2] = time.Now().Add(10 * time.Second) // simulate fresh build
	if g.Allow(ctx, web) {
		t.Fatal("still waiting for env")
	}
	if atomic.LoadInt32(builds) != 1 {
		t.Fatalf("cooldown violated: builds=%d", atomic.LoadInt32(builds))
	}
	// Env now live (mock flipped): admitted.
	g.lastBuild[2] = time.Time{}
	if !g.Allow(ctx, web) {
		t.Fatal("live env must be admissible")
	}
	// Progress: 0/1 before solve.
	if cur, total, ok := g.Progress(2); !ok || cur != 0 || total != 1 {
		t.Fatalf("progress want 0/1, got %d/%d ok=%v", cur, total, ok)
	}
	// Fast lane: correct flag banked exactly once; non-DASCTF shape skipped.
	g.Submit(ctx, "dasctf:1", "flag{something_else}")
	g.Submit(ctx, "dasctf:1", "DASCTF{0123456789abcdef}")
	g.Submit(ctx, "dasctf:1", "DASCTF{0123456789abcdef}")
	if atomic.LoadInt32(recovers) != 0 {
		t.Fatalf("no recover expected before solve, got %d", atomic.LoadInt32(recovers))
	}
	// Release of a stopped env-backed goal recovers its env.
	if err := g.ForceRelease(ctx, web); err != nil {
		t.Fatalf("force release: %v", err)
	}
	if atomic.LoadInt32(recovers) != 1 {
		t.Fatalf("want 1 recover, got %d", atomic.LoadInt32(recovers))
	}
}
