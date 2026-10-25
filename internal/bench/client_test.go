package bench

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newMock spins up a platform stub and asserts the auth header on every
// request. handler may be nil to get the default /challenges response.
func newMock(t *testing.T, handler http.HandlerFunc) (*Client, *[]string) {
	t.Helper()
	var paths []string
	mux := http.NewServeMux()
	mux.HandleFunc("/openapi/v1/challenges", func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		if handler != nil {
			handler(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[
		  {"unique_code":"web_01","description":"sqli","difficulty":"easy","level":1,
		   "total_score":100,"flag_count":2,"correct_flag_count":1,"is_completed":false,
		   "container_status":"available","container_addr":["10.0.1.5:8080"]},
		  {"unique_code":"crypto_02","description":null,"difficulty":"hard","level":3,
		   "total_score":200,"flag_count":1,"correct_flag_count":0,"is_completed":false,
		   "container_status":"stopped","container_addr":[]}
		]`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c, err := NewClient(srv.URL, "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c, &paths
}

func TestNewClientValidation(t *testing.T) {
	if _, err := NewClient("", "t"); err == nil || !strings.Contains(err.Error(), "base URL") {
		t.Errorf("empty base URL: got %v", err)
	}
	if _, err := NewClient("not a url", "t"); err == nil {
		t.Error("invalid base URL accepted")
	}
	if _, err := NewClient("http://x/", ""); err == nil || !strings.Contains(err.Error(), "BENCHMARK_TOKEN") {
		t.Errorf("empty token: got %v", err)
	}
	c, err := NewClient("http://x/", "t")
	if err != nil || c.BaseURL() != "http://x" {
		t.Errorf("trailing slash not trimmed: %q %v", c.BaseURL(), err)
	}
}

func TestListDecodesChallenges(t *testing.T) {
	c, _ := newMock(t, nil)
	chs, err := c.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(chs) != 2 {
		t.Fatalf("want 2 challenges, got %d", len(chs))
	}
	web := chs[0]
	if web.UniqueCode != "web_01" || web.Difficulty != "easy" || web.Level != 1 ||
		web.TotalScore != 100 || web.FlagCount != 2 || web.CorrectFlagCount != 1 ||
		web.IsCompleted || web.ContainerStatus != "available" ||
		len(web.ContainerAddr) != 1 || web.ContainerAddr[0] != "10.0.1.5:8080" {
		t.Errorf("web_01 decoded wrong: %+v", web)
	}
	if chs[1].ContainerAddr == nil {
		t.Error("crypto_02 container_addr should decode as empty slice, not nil-shape mismatch")
	}
}

func TestStartReturnsAddresses(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/openapi/v1/challenges/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("start method = %s", r.Method)
		}
		if r.URL.Query().Get("unique_code") != "web_01" {
			t.Errorf("start unique_code = %q", r.URL.Query().Get("unique_code"))
		}
		w.Write([]byte(`{"unique_code":"web_01","container_addr":["10.0.1.5:8080","10.0.1.5:8443"]}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c, _ := newMockAt(t, srv)
	addrs, err := c.Start(context.Background(), "web_01")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(addrs) != 2 || addrs[1] != "10.0.1.5:8443" {
		t.Errorf("addrs = %v", addrs)
	}
}

func TestHintNullVsValue(t *testing.T) {
	mux := http.NewServeMux()
	n := 0
	mux.HandleFunc("/openapi/v1/challenges/hint", func(w http.ResponseWriter, r *http.Request) {
		n++
		if n == 1 {
			w.Write([]byte(`{"unique_code":"web_01","hint":null}`))
			return
		}
		w.Write([]byte(`{"unique_code":"web_01","hint":"try the username field"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c, _ := newMockAt(t, srv)
	if h, ok, err := c.Hint(context.Background(), "web_01"); err != nil || ok || h != "" {
		t.Errorf("hint null: %q %v %v", h, ok, err)
	}
	if h, ok, err := c.Hint(context.Background(), "web_01"); err != nil || !ok || h != "try the username field" {
		t.Errorf("hint value: %q %v %v", h, ok, err)
	}
}

func TestSubmitHappyAndDuplicate(t *testing.T) {
	mux := http.NewServeMux()
	calls := 0
	mux.HandleFunc("/openapi/v1/challenges/submit", func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("submit content-type = %q", r.Header.Get("Content-Type"))
		}
		if calls == 1 {
			w.Write([]byte(`{"correct":true,"awarded":50,"cumulative_score":80,"correct_flag_count":2,
			  "total_flag_count":3,"matched_flag_index":1}`))
			return
		}
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"code":"duplicate","message":"flag already submitted","detail":{}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c, _ := newMockAt(t, srv)
	res, err := c.Submit(context.Background(), "web_01", "flag{a}")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if !res.Correct || res.Awarded != 50 || res.CumulativeScore != 80 ||
		res.CorrectFlagCount != 2 || res.TotalFlagCount != 3 ||
		res.MatchedFlagIndex == nil || *res.MatchedFlagIndex != 1 {
		t.Errorf("submit result wrong: %+v", res)
	}
	_, err = c.Submit(context.Background(), "web_01", "flag{a}")
	if !CodeIs(err, CodeDuplicate) {
		t.Fatalf("want duplicate APIError, got %v", err)
	}
}

func TestSubmitLocalLengthValidation(t *testing.T) {
	c, _ := newMock(t, nil)
	if _, err := c.Submit(context.Background(), "web_01", ""); err == nil {
		t.Error("empty flag accepted")
	}
	if _, err := c.Submit(context.Background(), "web_01", strings.Repeat("x", MaxFlagLen+1)); err == nil {
		t.Error("oversized flag accepted")
	}
}

func TestClose(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/openapi/v1/challenges/close", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("unique_code") != "web_01" {
			t.Errorf("close unique_code = %q", r.URL.Query().Get("unique_code"))
		}
		w.Write([]byte(`{"unique_code":"web_01","closed":true}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c, _ := newMockAt(t, srv)
	if err := c.Close(context.Background(), "web_01"); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestErrorEnvelopeAndFrameworkValidation(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		body    string
		code    string
		wantMsg string
	}{
		{"task_not_found", 404, `{"code":"task_not_found","message":"no task for token","detail":{}}`, CodeTaskNotFound, "no task for token"},
		{"invalid_state", 409, `{"code":"invalid_state","message":"task over","detail":{}}`, CodeInvalidState, "task over"},
		{"challenge_not_found", 404, `{"code":"challenge_not_found","message":"no such challenge","detail":{}}`, CodeChallengeNotFound, "no such challenge"},
		{"resource_unavailable", 503, `{"code":"resource_unavailable","message":"exhausted","detail":{}}`, CodeResourceUnavailable, "exhausted"},
		{"framework_422", 422, `{"detail":[{"loc":["body","flag"],"msg":"String should have at least 1 character","type":"string_too_short"}]}`, CodeValidation, "body.flag"},
		{"non_json", 502, `<html>bad gateway</html>`, "http_502", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := tc.status, tc.body
			c, _ := newMock(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				w.Write([]byte(body))
			})
			_, err := c.List(context.Background())
			if !CodeIs(err, tc.code) {
				t.Fatalf("want code %s, got %v", tc.code, err)
			}
			if tc.wantMsg != "" && !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("message %q missing from %v", tc.wantMsg, err)
			}
		})
	}
}

func TestAuthHeaderSent(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("BENCHMARK_TOKEN")
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	c, err := NewClient(srv.URL, "tok-123")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got != "tok-123" {
		t.Errorf("BENCHMARK_TOKEN header = %q", got)
	}
}

// newMockAt wraps an already-started test server as a client.
func newMockAt(t *testing.T, srv *httptest.Server) (*Client, *[]string) {
	t.Helper()
	c, err := NewClient(srv.URL, "a1b2c3d4-e5f6-7890-abcd-ef1234567890")
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c, nil
}
