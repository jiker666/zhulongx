// Package bench is the client for the TSec Benchmark Platform Challenges
// API (see docs/zhulongx/04-benchmark.md). It is deliberately thin: five
// endpoints, one auth header, and the unified {code, message, detail}
// error envelope — the solving decisions (start/hint/submit/close) stay
// with the agent during Execute, so this client exists for the two
// operator-side loops: importing challenges as goals and reconciling
// platform state back into the graph.
package bench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// API error codes from the platform's unified envelope.
const (
	CodeTaskNotFound        = "task_not_found"       // 404: token invalid/missing/task gone
	CodeChallengeNotFound   = "challenge_not_found"  // 404: unique_code not in the task set
	CodeInvalidState        = "invalid_state"        // 409: task over / active-instance limit
	CodeDuplicate           = "duplicate"            // 409: same flag_index re-submitted
	CodeResourceUnavailable = "resource_unavailable" // 503: range instances not ready/exhausted
	CodeInternal            = "internal_error"       // 500
	CodeValidation          = "validation_error"     // 422 framework shape, not the envelope
)

// SubmitFlag constraints from the API doc.
const (
	MinFlagLen = 1
	MaxFlagLen = 4096
)

// APIError is the unified business error {code, message, detail}. The
// Code* helpers below classify it without string matching.
type APIError struct {
	StatusCode int
	Code       string
	Message    string
	Detail     string // raw detail JSON, usually "{}"
}

func (e *APIError) Error() string {
	if e.Detail != "" && e.Detail != "{}" {
		return fmt.Sprintf("bench: %s (%d): %s %s", e.Code, e.StatusCode, e.Message, e.Detail)
	}
	return fmt.Sprintf("bench: %s (%d): %s", e.Code, e.StatusCode, e.Message)
}

// CodeIs reports whether err is an APIError with the given code.
func CodeIs(err error, code string) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Code == code
}

// Client talks to one benchmark task. The token is a task credential:
// it must come from the environment (BENCHMARK_TOKEN), never from flags
// or config files, so it never lands in shell history or the repo.
type Client struct {
	baseURL string // no trailing slash
	token   string
	http    *http.Client
}

// NewClient validates the pair the platform issues and returns a client.
func NewClient(baseURL, token string) (*Client, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, fmt.Errorf("bench: base URL is empty (set BENCHMARK_BASE_URL)")
	}
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("bench: invalid base URL %q", baseURL)
	}
	if strings.TrimSpace(token) == "" {
		return nil, fmt.Errorf("bench: token is empty (set BENCHMARK_TOKEN)")
	}
	return &Client{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: 30 * time.Second},
	}, nil
}

// BaseURL is the (non-secret) platform address, used in goal briefs so
// the agent can call the API without extra lookups.
func (c *Client) BaseURL() string { return c.baseURL }

// Challenge is one row of GET /openapi/v1/challenges.
type Challenge struct {
	UniqueCode       string   `json:"unique_code"`
	Description      string   `json:"description"`
	Difficulty       string   `json:"difficulty"`
	Level            int      `json:"level"`
	TotalScore       int      `json:"total_score"`
	FlagCount        int      `json:"flag_count"`
	CorrectFlagCount int      `json:"correct_flag_count"`
	IsCompleted      bool     `json:"is_completed"`
	ContainerStatus  string   `json:"container_status"` // pending|available|stop_pending|stopped
	ContainerAddr    []string `json:"container_addr"`   // non-empty only when available
}

// SubmitResult is the response of POST /openapi/v1/challenges/submit.
type SubmitResult struct {
	Correct          bool `json:"correct"`
	Awarded          int  `json:"awarded"`
	CumulativeScore  int  `json:"cumulative_score"`
	CorrectFlagCount int  `json:"correct_flag_count"`
	TotalFlagCount   int  `json:"total_flag_count"`
	MatchedFlagIndex *int `json:"matched_flag_index"`
}

// List returns every challenge in the task with current progress.
func (c *Client) List(ctx context.Context) ([]Challenge, error) {
	var out []Challenge
	if err := c.do(ctx, http.MethodGet, "/openapi/v1/challenges", "", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Start boots the challenge container and returns its direct addresses.
func (c *Client) Start(ctx context.Context, uniqueCode string) ([]string, error) {
	var out struct {
		UniqueCode    string   `json:"unique_code"`
		ContainerAddr []string `json:"container_addr"`
	}
	if err := c.do(ctx, http.MethodPost, "/openapi/v1/challenges/start?unique_code="+url.QueryEscape(uniqueCode), "", nil, &out); err != nil {
		return nil, err
	}
	return out.ContainerAddr, nil
}

// Hint fetches the (score-penalizing) hint. ok=false means hint: null.
func (c *Client) Hint(ctx context.Context, uniqueCode string) (hint string, ok bool, err error) {
	var out struct {
		UniqueCode string  `json:"unique_code"`
		Hint       *string `json:"hint"`
	}
	if err := c.do(ctx, http.MethodGet, "/openapi/v1/challenges/hint?unique_code="+url.QueryEscape(uniqueCode), "", nil, &out); err != nil {
		return "", false, err
	}
	if out.Hint == nil {
		return "", false, nil
	}
	return *out.Hint, true, nil
}

// Submit posts a flag for judgement. A duplicate correct submission
// surfaces as *APIError{Code: CodeDuplicate}, not a nil result.
func (c *Client) Submit(ctx context.Context, uniqueCode, flag string) (*SubmitResult, error) {
	if n := len(flag); n < MinFlagLen || n > MaxFlagLen {
		return nil, fmt.Errorf("bench: flag length %d outside [%d, %d]", n, MinFlagLen, MaxFlagLen)
	}
	body, err := json.Marshal(map[string]string{"unique_code": uniqueCode, "flag": flag})
	if err != nil {
		return nil, err
	}
	var out SubmitResult
	if err := c.do(ctx, http.MethodPost, "/openapi/v1/challenges/submit", "application/json", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Close releases the challenge container.
func (c *Client) Close(ctx context.Context, uniqueCode string) error {
	var out struct {
		UniqueCode string `json:"unique_code"`
		Closed     bool   `json:"closed"`
	}
	if err := c.do(ctx, http.MethodPost, "/openapi/v1/challenges/close?unique_code="+url.QueryEscape(uniqueCode), "", nil, &out); err != nil {
		return err
	}
	if !out.Closed {
		return fmt.Errorf("bench: close of %s returned closed=false", uniqueCode)
	}
	return nil
}

// do performs one request. Non-2xx responses are decoded as the unified
// envelope (or the FastAPI 422 shape) and returned as *APIError.
func (c *Client) do(ctx context.Context, method, path, contentType string, body []byte, out any) error {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rd)
	if err != nil {
		return fmt.Errorf("bench: build request: %w", err)
	}
	req.Header.Set("BENCHMARK_TOKEN", c.token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("bench: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("bench: read response: %w", err)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if out == nil || len(raw) == 0 {
			return nil
		}
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("bench: decode 200 response from %s: %w (%.200s)", path, err, raw)
		}
		return nil
	}
	return newAPIError(resp.StatusCode, raw)
}

func newAPIError(status int, raw []byte) error {
	// Business envelope: {code, message, detail}.
	var env struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Detail  json.RawMessage `json:"detail"`
	}
	if err := json.Unmarshal(raw, &env); err == nil && env.Code != "" {
		return &APIError{StatusCode: status, Code: env.Code, Message: env.Message, Detail: string(env.Detail)}
	}
	// Framework validation (422): {"detail": [ {loc, msg, type}, ... ]}.
	var v struct {
		Detail []struct {
			Loc []string `json:"loc"`
			Msg string   `json:"msg"`
		} `json:"detail"`
	}
	if err := json.Unmarshal(raw, &v); err == nil && len(v.Detail) > 0 {
		msgs := make([]string, 0, len(v.Detail))
		for _, d := range v.Detail {
			msgs = append(msgs, fmt.Sprintf("%s: %s", strings.Join(d.Loc, "."), d.Msg))
		}
		return &APIError{StatusCode: status, Code: CodeValidation, Message: strings.Join(msgs, "; "), Detail: string(raw)}
	}
	return &APIError{StatusCode: status, Code: fmt.Sprintf("http_%d", status), Message: strings.TrimSpace(string(raw))}
}
