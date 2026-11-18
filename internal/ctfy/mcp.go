package ctfy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// MCPClient is a minimal MCP streamable-HTTP client (JSON-RPC over POST).
// The platform serves its whole player API as MCP tools at /api/v1/mcp/
// (CTFY-0001 §1.2), and several AWD lifecycle endpoints are DOCUMENTED only
// as MCP tool names (get_awd_match, submit_awd_flags) — this client is the
// reliable route to them, with the documented REST routes as fallback.
type MCPClient struct {
	url   string
	token string
	hc    *http.Client

	mu      sync.Mutex
	session string
	nextID  int
	tools   map[string]json.RawMessage // tool name -> inputSchema
	inited  bool
}

// MCPAPI is the driver seam (mocked in tests).
type MCPAPI interface {
	CallTool(ctx context.Context, tool string, candidates map[string]any) (string, error)
	HasTool(ctx context.Context, tool string) bool
}

// LoadMCPConfig reads <workdir>/mcp.json and returns a lazy client. The
// file's exact schema is platform-rendered; this parser walks it for the
// first string "url" (the common mcpServers.{name}.url shape and friends).
// A missing file or stdio-only config returns nil, nil — MCP is an
// enhancement, never a dependency.
func LoadMCPConfig(workDir, token string) (*MCPClient, error) {
	raw, err := os.ReadFile(filepath.Join(workDir, "mcp.json"))
	if err != nil {
		return nil, nil // absent (dry runs, MCP-less deployments) — fine
	}
	var cfg any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("ctfy: mcp.json unparsable: %w", err)
	}
	url := findURL(cfg)
	if url == "" {
		return nil, nil // no http url advertised; not fatal
	}
	url = expandEnv(url, token)
	return &MCPClient{url: url, token: token, hc: &http.Client{Timeout: 60 * time.Second}}, nil
}

// findURL walks any JSON value for the first string field named "url".
func findURL(v any) string {
	switch t := v.(type) {
	case map[string]any:
		if u, ok := t["url"].(string); ok && strings.HasPrefix(u, "http") {
			return u
		}
		for _, k := range sortedKeys(t) {
			if u := findURL(t[k]); u != "" {
				return u
			}
		}
	case []any:
		for _, e := range t {
			if u := findURL(e); u != "" {
				return u
			}
		}
	}
	return ""
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

// expandEnv substitutes ${VAR} placeholders (the platform writes the token
// by reference, never by value — CTFY-0001 §1.2).
func expandEnv(s, token string) string {
	s = strings.ReplaceAll(s, "${CTFY_TOKEN}", token)
	return os.Expand(s, func(k string) string {
		if k == "CTFY_TOKEN" {
			return token
		}
		return os.Getenv(k)
	})
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// ensureInit performs the initialize handshake once (lazily, on first use,
// so a dead MCP server never blocks startup).
func (c *MCPClient) ensureInit(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.inited {
		return nil
	}
	res, err := c.post(ctx, rpcRequest{
		JSONRPC: "2.0", ID: c.allocID(), Method: "initialize",
		Params: map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "zhulongx-ctfyagent", "version": "1.0"},
		},
	})
	if err != nil {
		return fmt.Errorf("ctfy: mcp initialize: %w", err)
	}
	_ = res // server info unused
	if _, err := c.postNotification(ctx, rpcRequest{
		JSONRPC: "2.0", Method: "notifications/initialized",
	}); err != nil {
		// some servers tolerate a missing notification; do not fail hard
		_ = err
	}
	if err := c.listToolsLocked(ctx); err != nil {
		return err
	}
	c.inited = true
	return nil
}

func (c *MCPClient) allocID() int {
	c.nextID++
	return c.nextID
}

func (c *MCPClient) listToolsLocked(ctx context.Context) error {
	res, err := c.post(ctx, rpcRequest{JSONRPC: "2.0", ID: c.allocID(), Method: "tools/list"})
	if err != nil {
		return err
	}
	var page struct {
		Tools []struct {
			Name        string          `json:"name"`
			InputSchema json.RawMessage `json:"inputSchema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(res, &page); err != nil {
		return err
	}
	c.tools = map[string]json.RawMessage{}
	for _, t := range page.Tools {
		c.tools[t.Name] = t.InputSchema
	}
	return nil
}

// HasTool reports whether the server advertises the tool.
func (c *MCPClient) HasTool(ctx context.Context, tool string) bool {
	if err := c.ensureInit(ctx); err != nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.tools[tool]
	return ok
}

// CallTool invokes a tool, filling arguments from candidates according to
// the tool's declared required properties (the spec documents tool NAMES,
// not argument shapes — the schema is the contract). Falls back to one
// retry with every candidate when the server rejects the first attempt.
// Returns the tool's first text content block.
func (c *MCPClient) CallTool(ctx context.Context, tool string, candidates map[string]any) (string, error) {
	if err := c.ensureInit(ctx); err != nil {
		return "", err
	}
	args := c.schemaArgs(tool, candidates, false)
	text, err := c.callOnce(ctx, tool, args)
	if err == nil {
		return text, nil
	}
	// second attempt: everything we have (some servers declare no schema
	// but require arguments anyway)
	full := c.schemaArgs(tool, candidates, true)
	if text2, err2 := c.callOnce(ctx, tool, full); err2 == nil {
		return text2, nil
	}
	return "", err
}

func (c *MCPClient) callOnce(ctx context.Context, tool string, args map[string]any) (string, error) {
	c.mu.Lock()
	res, err := c.post(ctx, rpcRequest{
		JSONRPC: "2.0", ID: c.allocID(), Method: "tools/call",
		Params: map[string]any{"name": tool, "arguments": args},
	})
	c.mu.Unlock()
	if err != nil {
		return "", err
	}
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return "", fmt.Errorf("ctfy: mcp %s: decode: %w", tool, err)
	}
	if out.IsError {
		msg := ""
		for _, blk := range out.Content {
			if blk.Text != "" {
				msg = blk.Text
				break
			}
		}
		return "", fmt.Errorf("ctfy: mcp %s: tool error: %s", tool, msg)
	}
	for _, blk := range out.Content {
		if blk.Type == "text" {
			return blk.Text, nil
		}
	}
	return string(res), nil
}

// schemaArgs builds the arguments map: required properties from the tool's
// inputSchema, filled from candidates. all=true includes every candidate
// key the schema knows about.
func (c *MCPClient) schemaArgs(tool string, candidates map[string]any, all bool) map[string]any {
	args := map[string]any{}
	c.mu.Lock()
	schema := c.tools[tool]
	c.mu.Unlock()
	if len(schema) == 0 {
		if all {
			return candidates
		}
		return args
	}
	var s struct {
		Required []string `json:"required"`
		Props    map[string]struct {
			Type string `json:"type"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(schema, &s); err != nil {
		return args
	}
	wanted := map[string]bool{}
	for _, k := range s.Required {
		wanted[k] = true
	}
	if all {
		for k := range s.Props {
			wanted[k] = true
		}
		for k := range candidates {
			wanted[k] = true
		}
	}
	for k := range wanted {
		if v, ok := candidates[k]; ok {
			args[k] = v
		}
	}
	return args
}

// post sends one JSON-RPC request and returns the result member, handling
// both application/json and text/event-stream (SSE) response frames and
// tracking the mcp-session-id header. CALLER HOLDS c.mu — this client is
// driver-single-threaded, and the handshake paths nest post under the lock.
func (c *MCPClient) post(ctx context.Context, req rpcRequest) (json.RawMessage, error) {
	body, _ := json.Marshal(req)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	if c.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.session != "" {
		httpReq.Header.Set("Mcp-Session-Id", c.session)
	}
	resp, err := c.hc.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		c.session = sid
	}
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		// a dead session is recoverable: drop it so the next call re-inits
		if resp.StatusCode == 404 || resp.StatusCode == 400 {
			c.session = ""
			c.inited = false
		}
		return nil, fmt.Errorf("http %d: %.200s", resp.StatusCode, raw)
	}
	ct := resp.Header.Get("Content-Type")
	var rpc rpcResponse
	if strings.Contains(ct, "text/event-stream") {
		rpc, err = readSSE(resp.Body, req.ID)
		if err != nil {
			return nil, err
		}
	} else {
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			return nil, err
		}
		if len(bytes.TrimSpace(raw)) == 0 {
			return nil, fmt.Errorf("empty response")
		}
		if err := json.Unmarshal(raw, &rpc); err != nil {
			return nil, err
		}
	}
	if rpc.Error != nil {
		return nil, fmt.Errorf("rpc %d: %s", rpc.Error.Code, rpc.Error.Message)
	}
	return rpc.Result, nil
}

func (c *MCPClient) postNotification(ctx context.Context, req rpcRequest) (bool, error) {
	body, _ := json.Marshal(req)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	if c.token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.hc.Do(httpReq)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode < 300, nil
}

// readSSE scans an SSE stream for the JSON-RPC response carrying wantID.
func readSSE(r io.Reader, wantID int) (rpcResponse, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		var rpc rpcResponse
		if err := json.Unmarshal([]byte(payload), &rpc); err != nil {
			continue
		}
		if rpc.ID == wantID {
			return rpc, nil
		}
	}
	return rpcResponse{}, io.ErrUnexpectedEOF
}
