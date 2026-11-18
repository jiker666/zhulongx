package ctfy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// mcptestServer speaks enough streamable-HTTP MCP for the client: handshake
// with a session header, tools/list, and tools/call with selectable framing.
type mcptestServer struct {
	mu       sync.Mutex
	sse      bool // respond as text/event-stream instead of application/json
	lastAuth string
	calls    []string // tools/call names, in order
	lastArgs map[string]any
}

func (s *mcptestServer) handler(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastAuth = r.Header.Get("Authorization")
	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(400)
		return
	}
	write := func(result any) {
		if s.sse {
			w.Header().Set("Content-Type", "text/event-stream")
			payload, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": req.ID, "result": result,
			})
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", payload)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	}
	switch req.Method {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", "sess-42")
		write(map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}})
	case "notifications/initialized":
		w.WriteHeader(202)
	case "tools/list":
		write(map[string]any{"tools": []any{
			map[string]any{"name": "get_awd_match", "inputSchema": map[string]any{
				"type": "object", "required": []string{"competition_id"},
				"properties": map[string]any{"competition_id": map[string]any{"type": "string"}}}},
			map[string]any{"name": "submit_awd_flags", "inputSchema": map[string]any{
				"type": "object", "required": []string{"flags"},
				"properties": map[string]any{"flags": map[string]any{"type": "array"}}}},
			map[string]any{"name": "picky", "inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{"answer": map[string]any{"type": "string"}}}},
		}})
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		raw, _ := json.Marshal(req.Params)
		json.Unmarshal(raw, &p)
		s.calls = append(s.calls, p.Name)
		s.lastArgs = p.Arguments
		if p.Name == "picky" && len(p.Arguments) == 0 {
			write(map[string]any{"content": []any{map[string]any{"type": "text", "text": "missing answer"}}, "isError": true})
			return
		}
		write(map[string]any{"content": []any{map[string]any{
			"type": "text", "text": `{"starts_at":"2026-11-13T10:00:00Z","tick_seconds":120}`}}})
	default:
		write(map[string]any{})
	}
}

func TestMCPClientJSONFlow(t *testing.T) {
	srv := &mcptestServer{}
	hs := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer hs.Close()

	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "mcp.json"),
		[]byte(`{"mcpServers":{"ctfy":{"url":"`+hs.URL+`"}}}`), 0o644)
	cl, err := LoadMCPConfig(dir, "tk")
	if err != nil || cl == nil {
		t.Fatalf("load: %v %v", cl, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if !cl.HasTool(ctx, "get_awd_match") {
		t.Fatal("get_awd_match not advertised after init")
	}
	text, err := cl.CallTool(ctx, "get_awd_match", map[string]any{"competition_id": "c1"})
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if !strings.Contains(text, "starts_at") {
		t.Fatalf("unexpected tool text: %q", text)
	}
	srv.mu.Lock()
	auth := srv.lastAuth
	args := srv.lastArgs
	srv.mu.Unlock()
	if auth != "Bearer tk" {
		t.Fatalf("auth header = %q", auth)
	}
	// schema says competition_id is required -> arg must have been sent
	if args["competition_id"] != "c1" {
		t.Fatalf("schema-driven args = %v", args)
	}
}

func TestMCPClientSSEAndRetry(t *testing.T) {
	srv := &mcptestServer{sse: true}
	hs := httptest.NewServer(http.HandlerFunc(srv.handler))
	defer hs.Close()

	cl := &MCPClient{url: hs.URL, token: "tk", hc: &http.Client{Timeout: 10 * time.Second}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	text, err := cl.CallTool(ctx, "picky", map[string]any{"answer": "42"})
	if err != nil {
		t.Fatalf("picky call (needs retry with full candidates): %v", err)
	}
	if !strings.Contains(text, "starts_at") {
		t.Fatalf("unexpected tool text: %q", text)
	}
	srv.mu.Lock()
	calls := append([]string(nil), srv.calls...)
	last := srv.lastArgs
	srv.mu.Unlock()
	// picky declares nothing required -> first attempt sends {} and the
	// server rejects; the retry must then carry the full candidate set.
	if len(calls) != 2 {
		t.Fatalf("expected empty-args attempt then retry, got %d calls", len(calls))
	}
	if last["answer"] != "42" {
		t.Fatalf("retry args = %v", last)
	}
}

func TestMCPConfigTolerant(t *testing.T) {
	dir := t.TempDir()
	// placeholder token expansion + nested url discovery
	os.WriteFile(filepath.Join(dir, "mcp.json"),
		[]byte(`{"servers":{"main":{"url":"https://mcp.example/api/v1/mcp/?t=${CTFY_TOKEN}"}}}`), 0o644)
	cl, err := LoadMCPConfig(dir, "s3cr3t")
	if err != nil || cl == nil {
		t.Fatalf("load: %v %v", cl, err)
	}
	if cl.url != "https://mcp.example/api/v1/mcp/?t=s3cr3t" {
		t.Fatalf("url = %q", cl.url)
	}
	// stdio-only config -> nil client, no error
	dir2 := t.TempDir()
	os.WriteFile(filepath.Join(dir2, "mcp.json"), []byte(`{"mcpServers":{"x":{"command":"/bin/x"}}}`), 0o644)
	cl2, err := LoadMCPConfig(dir2, "t")
	if err != nil || cl2 != nil {
		t.Fatalf("stdio config should yield nil client: %v %v", cl2, err)
	}
	// missing file -> nil client
	cl3, err := LoadMCPConfig(t.TempDir(), "t")
	if err != nil || cl3 != nil {
		t.Fatalf("missing config should yield nil client: %v %v", cl3, err)
	}
}

func TestParseAWDMatch(t *testing.T) {
	now := time.Date(2026, 11, 13, 11, 0, 0, 0, time.UTC)
	m := parseAWDMatch(`{"starts_at":"2026-11-13T10:00:00Z","tick_seconds":120,"tick_count":30}`, now)
	if m == nil || !m.Known {
		t.Fatalf("match = %+v", m)
	}
	if m.CurrentTick != 30 || m.TickSeconds != 120 || m.TickCount != 30 {
		t.Fatalf("clock off: %+v", m)
	}
	if !m.EndsAt.Equal(time.Date(2026, 11, 13, 11, 0, 0, 0, time.UTC)) {
		t.Fatalf("ends_at = %v", m.EndsAt)
	}

	// alternate field names, string numbers, epoch millis, prose wrapping
	m2 := parseAWDMatch(`match: {"start_time":1799990000,"round_seconds":"60","rounds":10,"current_round":"5"} end.`,
		time.Unix(1799990300, 0))
	if m2 == nil || !m2.Known || m2.TickSeconds != 60 || m2.TickCount != 10 || m2.CurrentTick != 5 {
		t.Fatalf("tolerant parse off: %+v", m2)
	}
	if m2.StartsAt.Unix() != 1799990000 {
		t.Fatalf("epoch seconds not parsed: %v", m2.StartsAt)
	}

	if parseAWDMatch("no object at all", now) != nil {
		t.Fatal("garbage should yield nil")
	}
}
