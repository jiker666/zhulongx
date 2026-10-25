// Package pi implements zhulongx's adapter to the Pi coding agent running
// in official RPC mode (`pi --mode rpc`), speaking the JSONL protocol of
// @mariozechner/pi-coding-agent (verified against 0.73.1's bundled
// docs/rpc.md and a live session; see docs/zhulongx/02-architecture.md).
//
// Protocol invariants this adapter relies on:
//   - one JSON object per line on stdin/stdout, LF-terminated (CR tolerated)
//   - the command name rides in the `type` field; commands carry an
//     optional `id`; responses repeat it; responses may arrive out of
//     order → correlate by id, never by position
//   - a successful `prompt` response only means the request was ACCEPTED
//     (started/queued/handled) — completion is the separate `agent_end`
//     event; failures after acceptance surface in the event stream, never
//     as a second response for the same id
//   - tool executions surface as tool_execution_start/update/end events
//     with `toolName` and `args` (e.g. args.command for bash)
//   - stderr is diagnostics-only, never protocol
//   - closing stdin shuts the agent down gracefully
//
// It replaces Cairn's one-shot `--mode json` Pi driver
// (cairn/dispatcher/workers/adapters/pi.py): the old driver re-parsed a
// finished process's stdout; the adapter below is interactive, which is
// what makes timeout→abort and crash→classify handling honest.
package pi

import "encoding/json"

// Event names observed on stdout (session events). pi ≥ 0.73 signals
// completion with agent_end; the agent_settled name from older published
// docs is kept as a tolerated alias so the adapter works with both.
const (
	EventAgentStart     = "agent_start"
	EventAgentEnd       = "agent_end"     // the completion marker (pi ≥ 0.73)
	EventAgentSettled   = "agent_settled" // legacy alias, tolerated
	EventMessageUpdate  = "message_update"
	EventMessageEnd     = "message_end"
	EventToolExecStart  = "tool_execution_start"
	EventToolExecUpdate = "tool_execution_update"
	EventToolExecEnd    = "tool_execution_end"
)

// Command is a stdin record. Exactly one command field is set; Type carries
// the wire name and ID is our correlation key.
type Command struct {
	ID      string         `json:"id,omitempty"`
	Type    string         `json:"type"`
	Message string         `json:"message,omitempty"`
	Body    map[string]any `json:"-"`
}

// wire renders the command as the wire expects: top-level type + fields.
func (c Command) wire() []byte {
	m := map[string]any{"type": c.Type}
	if c.ID != "" {
		m["id"] = c.ID
	}
	for k, v := range c.Body {
		m[k] = v
	}
	if c.Message != "" {
		m["message"] = c.Message
	}
	b, err := json.Marshal(m)
	if err != nil {
		return []byte("{}")
	}
	return b
}

// Record is any stdout line: either a `response` (id-correlated) or an
// event (session-level). Unknown shapes are preserved verbatim.
type Record struct {
	// ID is non-empty for responses.
	ID string `json:"id,omitempty"`
	// Type is "response" or an event name.
	Type    string `json:"type"`
	Command string `json:"command,omitempty"` // for responses: echoed command name
	Success *bool  `json:"success,omitempty"` // for responses
	Error   string `json:"error,omitempty"`
	// Disposition is prompt-response data.disposition (started/queued/handled).
	Disposition string `json:"-"`
	// Text is get_last_assistant_text data.text.
	Text string `json:"-"`
	// Raw keeps the full line for audit/evidence.
	Raw string `json:"-"`
}

func decodeRecord(line string) *Record {
	var probe struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Command string `json:"command"`
		Success *bool  `json:"success"`
		Error   string `json:"error"`
		Data    struct {
			Disposition string `json:"disposition"`
			Text        string `json:"text"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(line), &probe); err != nil {
		return nil
	}
	return &Record{
		ID:          probe.ID,
		Type:        probe.Type,
		Command:     probe.Command,
		Success:     probe.Success,
		Error:       probe.Error,
		Disposition: probe.Data.Disposition,
		Text:        probe.Data.Text,
		Raw:         line,
	}
}
