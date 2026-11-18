package ctfy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Client talks the read-only REST surface the driver itself needs. All
// mutating calls (submissions, patches, reports) stay with the agent, which
// derives their exact routes from the per-run README — the driver never
// guesses a write schema.
type Client struct {
	base string
	hc   *http.Client
}

// API is the client seam the driver depends on (mocked in tests).
type API interface {
	// ChallengeRefresh re-reads the challenge record; on gated challenges
	// correct answers unlock question prompts that did not exist at start.
	ChallengeRefresh(ctx context.Context, id string) ([]Question, int, error)
	// CompetitionState reports the session clock (AWD lifetime).
	CompetitionState(ctx context.Context, id string) (CompetitionInfo, error)
	// AWDTargets lists the match field (addresses + which box is ours).
	AWDTargets(ctx context.Context, compID string) ([]AWDTarget, error)
}

// AWDTarget is one team box in an AWD match (GET /api/v1/competitions/{id}/awd/targets).
type AWDTarget struct {
	Address string `json:"address"`
	Team    string `json:"team,omitempty"`
	IsOwn   bool   `json:"is_own"`
}

// CompetitionInfo is the play-clock projection of GET /api/v1/competitions/{id}.
type CompetitionInfo struct {
	PlayOpen             bool   `json:"play_open"`
	CurrentSessionEndsAt string `json:"current_session_ends_at"`
	NextSessionStartsAt  string `json:"next_session_starts_at"`
}

// challengeRecord carries only the fields the driver merges back in.
type challengeRecord struct {
	Questions      []Question `json:"questions"`
	GatedQuestions int        `json:"gated_questions"`
}

func NewClient(base, token string) *Client {
	return &Client{
		base: stringURL(base),
		hc: &http.Client{
			Timeout: 30 * time.Second,
			// the bearer rides every request; never logged
			Transport: &authTransport{token: token, rt: http.DefaultTransport},
		},
	}
}

func stringURL(base string) string {
	if base == "" {
		return ""
	}
	return base
}

type authTransport struct {
	token string
	rt    http.RoundTripper
}

func (a *authTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if a.token != "" {
		req.Header.Set("Authorization", "Bearer "+a.token)
	}
	rt := a.rt
	if rt == nil {
		rt = http.DefaultTransport
	}
	return rt.RoundTrip(req)
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	if c.base == "" {
		return fmt.Errorf("ctfy: no platform url")
	}
	u := c.base + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ctfy: GET %s: http %d", redactPath(path), resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("ctfy: GET %s: decode: %w", redactPath(path), err)
	}
	return nil
}

func redactPath(p string) string {
	if u, err := url.Parse(p); err == nil {
		return u.Path
	}
	return p
}

// ChallengeRefresh implements API.
func (c *Client) ChallengeRefresh(ctx context.Context, id string) ([]Question, int, error) {
	var rec challengeRecord
	if err := c.get(ctx, "/api/v1/challenges/"+url.PathEscape(id), &rec); err != nil {
		return nil, 0, err
	}
	return rec.Questions, rec.GatedQuestions, nil
}

// CompetitionState implements API.
func (c *Client) CompetitionState(ctx context.Context, id string) (CompetitionInfo, error) {
	var info CompetitionInfo
	err := c.get(ctx, "/api/v1/competitions/"+url.PathEscape(id), &info)
	return info, err
}

// AWDTargets implements API. The response is wrapped under "targets" (the
// record shape of GET /api/v1/competitions/{id}/awd/targets); a bare array
// is also accepted defensively.
func (c *Client) AWDTargets(ctx context.Context, compID string) ([]AWDTarget, error) {
	var rec struct {
		Targets []AWDTarget `json:"targets"`
	}
	if err := c.get(ctx, "/api/v1/competitions/"+url.PathEscape(compID)+"/awd/targets", &rec); err != nil {
		return nil, err
	}
	if len(rec.Targets) == 0 {
		var bare []AWDTarget
		_ = c.get(ctx, "/api/v1/competitions/"+url.PathEscape(compID)+"/awd/targets", &bare)
		if len(bare) > 0 {
			return bare, nil
		}
	}
	return rec.Targets, nil
}

// Ping verifies the token with the cheapest authenticated read
// (GET /api/v1/me). Failure is advisory: a deployment that hides /me
// must not cost the run.
func (c *Client) Ping(ctx context.Context) error {
	return c.get(ctx, "/api/v1/me", nil)
}
