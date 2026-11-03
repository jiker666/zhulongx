// Package dasctf is the client for the DASCTF slab-match Agent API (see
// C:\Users\Jiker\Downloads\api_doc.md): one auth header, the unified
// {code, message, data} envelope, and a handful of endpoints. Like
// internal/bench it is deliberately thin — solving decisions stay with the
// agent during Execute; this client exists for the operator-side loops
// (importing exercises as goals, env lifecycle, flag submission,
// reconciling platform state into the graph).
package dasctf

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

// Envelope success code. Every other code is a business error whose
// message carries the reason.
const CodeOK = "00000"

// Answer constraints from the API doc.
const (
	MinFlagLen = 1
	MaxFlagLen = 256
)

// APIError is the unified business error {code, message} (HTTP status is
// kept for the log; judgement is by code, never by string matching).
type APIError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("dasctf: %s (%d): %s", e.Code, e.StatusCode, e.Message)
}

// CodeIs reports whether err is an APIError with the given code.
func CodeIs(err error, code string) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Code == code
}

// Client talks to one DASCTF match. The access key is a match credential:
// it must come from the environment (DASCTF_ACCESSKEY), never from flags
// or config files, so it never lands in shell history or the repo.
type Client struct {
	host      string // server host, no trailing slash
	accessKey string
	base      string // host + /slab-match/api/v1/agent
	http      *http.Client
}

// NewClient validates the pair the platform issues and returns a client.
func NewClient(host, accessKey string) (*Client, error) {
	host = strings.TrimRight(strings.TrimSpace(host), "/")
	if host == "" {
		return nil, fmt.Errorf("dasctf: host is empty (set DASCTF_HOST)")
	}
	u, err := url.Parse(host)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("dasctf: invalid host %q", host)
	}
	if strings.TrimSpace(accessKey) == "" {
		return nil, fmt.Errorf("dasctf: access key is empty (set DASCTF_ACCESSKEY)")
	}
	return &Client{
		host:      host,
		accessKey: accessKey,
		base:      host + "/slab-match/api/v1/agent",
		http:      &http.Client{Timeout: 30 * time.Second},
	}, nil
}

// Host is the (non-secret) platform address, used in goal briefs so the
// agent can call the API without extra lookups.
func (c *Client) Host() string { return c.host }

// CorpusEntry is one exercise inside a category of the exercise list.
type CorpusEntry struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Order     int    `json:"order"`
	IsOpen    bool   `json:"isOpen"`
	HasSolved bool   `json:"hasSolved"`
}

// ExerciseCategory is one row of GET /ctf/exercise-list.
type ExerciseCategory struct {
	ID     int           `json:"id"`
	Name   string        `json:"name"` // WEB / PWN / MISC / REVERSE / CRYPTO
	Order  int           `json:"order"`
	Corpus []CorpusEntry `json:"corpus"`
}

// Exercise is one challenge: its category joined onto the list entry.
type Exercise struct {
	ID        int
	Name      string
	Category  string
	IsOpen    bool
	HasSolved bool
}

// Attachment file of an exercise.
type AttachmentFile struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Ext  string `json:"ext"`
}

// User is a credential exposed by an endpoint.
type User struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// PortMapping is a proxy port forward onto a target port.
type PortMapping struct {
	Type  string `json:"type"`
	Port  string `json:"port"`
	Proxy string `json:"proxy"`
}

// Endpoint is one reachable target of an exercise environment.
type Endpoint struct {
	ExposeIps    []string      `json:"exposeIps"`
	Ports        []string      `json:"ports"`
	Users        []User        `json:"users"`
	PortMappings []PortMapping `json:"portMappings"`
	ProxyIps     []string      `json:"proxyIps"`
	IsProxy      bool          `json:"isProxy"`
	ExpireTime   int64         `json:"expireTime"` // ms epoch
}

// Detail is the response of GET /ctf/exercise.
type Detail struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	HasSolved   bool   `json:"hasSolved"`
	Score       string `json:"score"`
	Difficulty  string `json:"difficulty"`
	Attachment  *struct {
		Files []AttachmentFile `json:"files"`
	} `json:"attachment"`
	Endpoints          []Endpoint `json:"endpoints"`
	CanRefreshEndpoint bool       `json:"canRefreshEndpoint"`
	IsNeedInit         bool       `json:"isNeedInit"`
	EndpointType       string     `json:"endpointType"` // monopoly|none
	CurrentTime        int64      `json:"currentTime"`
	IsNeedCheck        bool       `json:"isNeedCheck"`
}

// AnswerResult is the data of a correct POST /answer-panel/answer.
type AnswerResult struct {
	IsCorrect bool `json:"isCorrect"`
}

// Overview is the data of GET /answer-panel/overview.
type Overview struct {
	StagePoint float64 `json:"stagePoint"`
	StageRank  int     `json:"stageRank"`
}

// List returns every open exercise, flattened across categories.
func (c *Client) List(ctx context.Context) ([]Exercise, error) {
	var cats []ExerciseCategory
	if err := c.do(ctx, http.MethodGet, "/ctf/exercise-list", nil, &cats); err != nil {
		return nil, err
	}
	var out []Exercise
	for _, cat := range cats {
		for _, e := range cat.Corpus {
			out = append(out, Exercise{ID: e.ID, Name: e.Name, Category: cat.Name, IsOpen: e.IsOpen, HasSolved: e.HasSolved})
		}
	}
	return out, nil
}

// Detail fetches one exercise's full detail.
func (c *Client) Detail(ctx context.Context, exerciseID int) (*Detail, error) {
	var out Detail
	if err := c.do(ctx, http.MethodGet, fmt.Sprintf("/ctf/exercise?exerciseId=%d", exerciseID), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// BuildEnv asks the platform to start the exercise environment. The
// operation is async: poll Detail until isNeedCheck=false and endpoints
// are present.
func (c *Client) BuildEnv(ctx context.Context, exerciseID int) error {
	body, err := json.Marshal(map[string]int{"exerciseId": exerciseID})
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPost, "/ctf/build-exercise-env", body, nil)
}

// RecoverEnv releases the exercise environment.
func (c *Client) RecoverEnv(ctx context.Context, exerciseID int) error {
	body, err := json.Marshal(map[string]int{"exerciseId": exerciseID})
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPost, "/ctf/recover-exercise-env", body, nil)
}

// Answer submits a flag for judgement. A wrong flag surfaces as an
// *APIError whose code/message carries the platform's reason; a correct
// one returns isCorrect=true.
func (c *Client) Answer(ctx context.Context, exerciseID int, flag string) (*AnswerResult, error) {
	if n := len(flag); n < MinFlagLen || n > MaxFlagLen {
		return nil, fmt.Errorf("dasctf: flag length %d outside [%d, %d]", n, MinFlagLen, MaxFlagLen)
	}
	body, err := json.Marshal(map[string]any{"exerciseId": exerciseID, "flag": flag})
	if err != nil {
		return nil, err
	}
	var out AnswerResult
	if err := c.do(ctx, http.MethodPost, "/answer-panel/answer", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetOverview returns the current score and rank.
func (c *Client) GetOverview(ctx context.Context) (*Overview, error) {
	var out Overview
	if err := c.do(ctx, http.MethodGet, "/answer-panel/overview", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// do performs one request. Non-2xx responses AND 2xx responses whose
// envelope code != "00000" are returned as *APIError.
func (c *Client) do(ctx context.Context, method, path string, body []byte, out any) error {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return fmt.Errorf("dasctf: build request: %w", err)
	}
	req.Header.Set("X-Agent-AccessKey", c.accessKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("dasctf: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("dasctf: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return newAPIError(resp.StatusCode, raw)
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	// The envelope wraps even 2xx responses; a non-OK code is an error.
	var env struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("dasctf: decode response from %s: %w (%.200s)", path, err, raw)
	}
	if env.Code != "" && env.Code != CodeOK {
		return &APIError{StatusCode: resp.StatusCode, Code: env.Code, Message: env.Message}
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return nil
	}
	if err := json.Unmarshal(env.Data, out); err != nil {
		return fmt.Errorf("dasctf: decode data from %s: %w (%.200s)", path, err, env.Data)
	}
	return nil
}

func newAPIError(status int, raw []byte) error {
	var env struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &env); err == nil && env.Code != "" {
		return &APIError{StatusCode: status, Code: env.Code, Message: env.Message}
	}
	return &APIError{StatusCode: status, Code: fmt.Sprintf("http_%d", status), Message: strings.TrimSpace(string(raw))}
}
