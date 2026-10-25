package pi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Errors surfaced to the engine for classification (retry vs permanent).
var (
	// ErrProcessExit: pi exited (crash or non-zero exit) before finishing.
	ErrProcessExit = errors.New("pi: process exited")
	// ErrProtocol: response arrived with success=false.
	ErrProtocol = errors.New("pi: command failed")
	// ErrTimeout: the caller's deadline expired before agent_end.
	ErrTimeout = errors.New("pi: deadline exceeded before agent_end")
	// ErrPolicyViolation: the agent ran a command matched by the blocked
	// tool policy; the run is aborted mid-flight.
	ErrPolicyViolation = errors.New("pi: tool policy violation")
	// ErrClosed: adapter already closed.
	ErrClosed = errors.New("pi: adapter closed")
)

// LaunchConfig describes how to start the pi process.
type LaunchConfig struct {
	// Command is the executable, e.g. "pi" or a test mock. Required.
	Command string
	// Args are extra args appended after the fixed RPC flags.
	Args []string
	// Dir is the working directory for the agent. Empty = inherit.
	Dir string
	// Env additions (KEY=VALUE). The agent's model/provider config stays
	// under the user's own pi configuration — zhulongx never injects one.
	Env []string
	// Policy (optional) aborts the run when a bash command matches a
	// blocked pattern. nil = allow everything.
	Policy *ToolPolicy
}

// fixed RPC flags: deterministic, stateless by default.
func (c LaunchConfig) argv() []string {
	argv := []string{"--mode", "rpc", "--no-session"}
	return append(argv, c.Args...)
}

// PromptResult is the outcome of one completed prompt.
type PromptResult struct {
	Disposition string   // started | queued | handled
	Text        string   // final assistant text (get_last_assistant_text)
	ToolCalls   int      // observed tool/bash executions
	Events      []string // raw event lines (capped), for evidence
}

const maxEvents = 64

// Adapter owns one running pi RPC process.
type Adapter struct {
	cfg LaunchConfig
	cmd *exec.Cmd

	stdin  io.WriteCloser
	stdout io.ReadCloser

	mu      sync.Mutex
	closed  bool
	seq     int
	waiters map[string]chan *Record
	// settledCh fires (once per agent turn) on agent_end (agent_settled legacy).
	settledCh chan struct{}
	// violationCh carries the first tool-policy violation of the current
	// turn, waking Prompt before the agent settles.
	violationCh chan string
	// streamText accumulates assistant text deltas as a fallback when
	// get_last_assistant_text is unavailable.
	streamText strings.Builder
	toolCalls  int
	events     []string

	stderrTail ringBuffer
	exited     chan struct{} // closed when the process is gone
	exitErr    error
}

// Start launches the pi process in RPC mode.
func Start(cfg LaunchConfig) (*Adapter, error) {
	if cfg.Command == "" {
		return nil, fmt.Errorf("pi: LaunchConfig.Command is required")
	}
	cmd := exec.Command(cfg.Command, cfg.argv()...)
	if cfg.Dir != "" {
		cmd.Dir = cfg.Dir
	}
	if len(cfg.Env) > 0 {
		cmd.Env = append(os.Environ(), cfg.Env...)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("pi: start %s: %w", cfg.Command, err)
	}
	a := &Adapter{
		cfg:         cfg,
		cmd:         cmd,
		stdin:       stdin,
		stdout:      stdout,
		waiters:     map[string]chan *Record{},
		settledCh:   make(chan struct{}, 1),
		violationCh: make(chan string, 1),
		exited:      make(chan struct{}),
	}
	go a.drainStderr(stderr)
	go a.readLoop()
	go a.watchExit()
	return a, nil
}

// Prompt sends a prompt and blocks until the agent settles, then fetches
// the final assistant text. ctx cancellation aborts the run and kills the
// process after a grace period; a tool-policy violation aborts the same
// way but preserves its diagnostic message.
func (a *Adapter) Prompt(ctx context.Context, message string) (*PromptResult, error) {
	res, err := a.prompt(ctx, message)
	if err != nil {
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			// best-effort graceful abort, then hard kill
			abortCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_, _ = a.send(abortCtx, Command{Type: "abort"})
			cancel()
			_ = a.Close()
			return nil, ErrTimeout
		case errors.Is(err, ErrPolicyViolation):
			// the run is poisoned: no graceful drain, kill immediately
			a.killNow()
		}
		return nil, err
	}
	return res, nil
}

func (a *Adapter) prompt(ctx context.Context, message string) (*PromptResult, error) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil, ErrClosed
	}
	a.seq++
	id := fmt.Sprintf("zhx-%d", a.seq)
	a.settledCh = make(chan struct{}, 1) // fresh per turn
	a.violationCh = make(chan string, 1)
	a.streamText.Reset()
	a.toolCalls = 0
	a.events = a.events[:0]
	a.mu.Unlock()

	// 1. send prompt, await its response (acceptance, NOT completion)
	resp, err := a.send(ctx, Command{ID: id, Type: "prompt", Message: message})
	if err != nil {
		return nil, err
	}
	if resp.Success == nil || !*resp.Success {
		return nil, fmt.Errorf("%w: prompt: %s", ErrProtocol, resp.Error)
	}

	// 2. wait for agent_end — the actual completion marker. If the
	// disposition was "handled" (no run started) the settled event may
	// already have fired before the response; the channel buffer covers it.
	select {
	case <-a.settledCh:
	case v := <-a.violationCh:
		return nil, fmt.Errorf("%w: command matched %s", ErrPolicyViolation, v)
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-a.exited:
		return nil, fmt.Errorf("%w: during run: %v", ErrProcessExit, a.exitState())
	}

	// 3. fetch final text; fall back to streamed deltas if unavailable.
	a.mu.Lock()
	streamed := a.streamText.String()
	toolCalls := a.toolCalls
	events := append([]string(nil), a.events...)
	a.mu.Unlock()

	text := streamed
	if resp2, err := a.send(ctx, Command{Type: "get_last_assistant_text"}); err == nil &&
		resp2.Success != nil && *resp2.Success && strings.TrimSpace(resp2.Text) != "" {
		text = resp2.Text
	}

	return &PromptResult{
		Disposition: resp.Disposition,
		Text:        text,
		ToolCalls:   toolCalls,
		Events:      events,
	}, nil
}

// send writes a command and waits for its id-correlated response.
func (a *Adapter) send(ctx context.Context, cmd Command) (*Record, error) {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil, ErrClosed
	}
	var ch chan *Record
	hasID := cmd.ID != ""
	if hasID {
		ch = make(chan *Record, 1)
		a.waiters[cmd.ID] = ch
	}
	line := append(cmd.wire(), '\n')
	_, werr := a.stdin.Write(line)
	a.mu.Unlock()
	if werr != nil {
		if hasID {
			a.mu.Lock()
			delete(a.waiters, cmd.ID)
			a.mu.Unlock()
		}
		return nil, fmt.Errorf("%w: stdin write: %v", ErrProcessExit, werr)
	}
	if !hasID {
		// fire-and-forget commands (abort) need no response
		return &Record{Success: boolPtr(true)}, nil
	}

	select {
	case rec := <-ch:
		if rec == nil {
			// channel closed by shutdownWaiters — the process died while we
			// were waiting; surface the real exit state
			return nil, fmt.Errorf("%w: waiter dropped: %v", ErrProcessExit, a.exitState())
		}
		return rec, nil
	case <-ctx.Done():
		a.mu.Lock()
		delete(a.waiters, cmd.ID)
		a.mu.Unlock()
		return nil, ctx.Err()
	case <-a.exited:
		return nil, fmt.Errorf("%w: awaiting response: %v", ErrProcessExit, a.exitState())
	}
}

// readLoop consumes stdout lines forever. Malformed JSON lines are counted
// and skipped (the protocol also emits a parse-error response; we do not
// need it).
func (a *Adapter) readLoop() {
	scanner := bufio.NewScanner(a.stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		rec := decodeRecord(line)
		if rec == nil {
			a.pushEvent("unparseable: " + truncate(line, 200))
			continue
		}
		a.dispatch(rec)
	}
	// Deliberately no shutdownWaiters() here: the process exit (watchExit)
	// is the only legitimate reason to drop waiters, and it must happen
	// AFTER exitErr is recorded so send() can surface the exit state.
}

func (a *Adapter) dispatch(rec *Record) {
	if rec.ID != "" && rec.Type == "response" {
		a.mu.Lock()
		ch, ok := a.waiters[rec.ID]
		delete(a.waiters, rec.ID)
		a.mu.Unlock()
		if ok {
			ch <- rec
		}
		return
	}
	switch rec.Type {
	case EventAgentSettled, EventAgentEnd:
		// completion marker: agent_end on pi ≥ 0.73 (verified against the
		// bundled docs/rpc.md); agent_settled tolerated from older builds
		select {
		case a.settledCh <- struct{}{}:
		default:
		}
	case EventMessageUpdate, EventMessageEnd:
		a.captureAssistantText(rec)
	case EventToolExecStart, EventToolExecUpdate:
		a.mu.Lock()
		a.toolCalls++
		a.mu.Unlock()
		if a.cfg.Policy != nil {
			// tool_execution_* shape: {"toolName":"bash","args":{"command":...}}
			var probe struct {
				ToolName string `json:"toolName"`
				Args     struct {
					Command string `json:"command"`
				} `json:"args"`
			}
			if json.Unmarshal([]byte(rec.Raw), &probe) == nil &&
				probe.ToolName == "bash" && probe.Args.Command != "" {
				if v := a.cfg.Policy.Violation(probe.Args.Command); v != "" {
					select { // wake Prompt mid-run; buffer 1, first hit wins
					case a.violationCh <- v:
					default:
					}
				}
			}
		}
	}
	a.pushEvent(truncate(rec.Raw, 400))
}

// captureAssistantText pulls text deltas out of message events:
// assistantMessageEvent.text_delta on message_update, or the message
// content blocks on message_end.
func (a *Adapter) captureAssistantText(rec *Record) {
	var probe struct {
		AssistantMessageEvent struct {
			Type  string `json:"type"`
			Delta string `json:"delta"`
		} `json:"assistantMessageEvent"`
		Message struct {
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(rec.Raw), &probe); err != nil {
		return
	}
	if probe.AssistantMessageEvent.Type == "text_delta" {
		a.mu.Lock()
		a.streamText.WriteString(probe.AssistantMessageEvent.Delta)
		a.mu.Unlock()
		return
	}
	if probe.Message.Role == "assistant" && len(probe.Message.Content) > 0 {
		var sb strings.Builder
		for _, c := range probe.Message.Content {
			if c.Type == "text" {
				sb.WriteString(c.Text)
			}
		}
		if sb.Len() > 0 {
			a.mu.Lock()
			a.streamText.Reset()
			a.streamText.WriteString(sb.String())
			a.mu.Unlock()
		}
	}
}

func (a *Adapter) pushEvent(line string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.events) < maxEvents {
		a.events = append(a.events, line)
	}
}

func (a *Adapter) watchExit() {
	err := a.cmd.Wait()
	a.exitErr = err
	close(a.exited)
	a.shutdownWaiters()
}

func (a *Adapter) shutdownWaiters() {
	a.mu.Lock()
	waiters := a.waiters
	a.waiters = map[string]chan *Record{}
	a.mu.Unlock()
	for _, ch := range waiters {
		close(ch)
	}
}

func (a *Adapter) drainStderr(r io.ReadCloser) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 16*1024), 256*1024)
	for sc.Scan() {
		a.stderrTail.write(sc.Text())
	}
}

func (a *Adapter) exitState() string {
	code := 0
	if a.exitErr != nil {
		var ee *exec.ExitError
		if errors.As(a.exitErr, &ee) {
			code = ee.ExitCode()
		} else {
			return a.exitErr.Error() + "; stderr: " + a.stderrTail.tail(3)
		}
	}
	return fmt.Sprintf("exit=%d; stderr: %s", code, a.stderrTail.tail(3))
}

// killNow terminates the process with no grace period — a policy-violating
// run must not be trusted to drain its remaining work.
func (a *Adapter) killNow() {
	a.mu.Lock()
	already := a.closed
	a.closed = true
	a.mu.Unlock()
	if !already {
		_ = a.cmd.Process.Kill()
	}
	<-a.exited // closed chan: safe even after Close()
}

// Close shuts the agent down: close stdin (graceful), then kill after grace.
func (a *Adapter) Close() error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil
	}
	a.closed = true
	a.mu.Unlock()
	_ = a.stdin.Close()
	select {
	case <-a.exited:
	case <-time.After(5 * time.Second):
		_ = a.cmd.Process.Kill()
		<-a.exited
	}
	return nil
}

// StderrTail returns the last n stderr lines (diagnostics only).
func (a *Adapter) StderrTail(n int) string { return a.stderrTail.tail(n) }

// --- small helpers ---

func boolPtr(b bool) *bool { return &b }

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ringBuffer keeps the last 16 stderr lines.
type ringBuffer struct {
	mu    sync.Mutex
	lines []string
}

func (r *ringBuffer) write(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, s)
	if len(r.lines) > 16 {
		r.lines = r.lines[len(r.lines)-16:]
	}
}

func (r *ringBuffer) tail(n int) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n > len(r.lines) {
		n = len(r.lines)
	}
	return strings.Join(r.lines[len(r.lines)-n:], " | ")
}
