// mockpi is a test double for the real `pi` binary speaking the documented
// RPC JSONL protocol. Behavior is driven by MOCK_SCENARIO so adapter tests
// can exercise every failure mode without the real agent.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

func emit(v any) {
	b, _ := json.Marshal(v)
	fmt.Fprintln(os.Stdout, string(b))
}

func resp(id, command string, success bool, data map[string]any, errText string) {
	m := map[string]any{"id": id, "type": "response", "command": command, "success": success}
	if data != nil {
		m["data"] = data
	}
	if errText != "" {
		m["error"] = errText
	}
	emit(m)
}

func main() {
	scenario := os.Getenv("MOCK_SCENARIO")
	finalText := os.Getenv("MOCK_FINAL_TEXT")
	if finalText == "" {
		finalText = `{"accepted":true,"data":{"finding":{"content":"mock finding","evidence":"mock session"}}}`
	}
	delay := 15 * time.Millisecond
	if d := os.Getenv("MOCK_DELAY_MS"); d != "" {
		var ms int
		fmt.Sscanf(d, "%d", &ms)
		delay = time.Duration(ms) * time.Millisecond
	}

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var cmd struct {
			ID      string `json:"id"`
			Type    string `json:"type"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal([]byte(line), &cmd); err != nil {
			resp("", "parse", false, nil, "invalid json: "+err.Error())
			continue
		}
		switch cmd.Type {
		case "prompt":
			if scenario == "flow" {
				// Content-routed script for the E2E closed loop:
				//   Execute prompt → finding JSON
				//   Decide prompt that lists a real open finding ("fd_0001 [open]",
				//     rendered in the graph dump — the decide.md template mentions
				//     fd_0001 only inside a JSON example, which must not route
				//     here) → promote + complete
				//   fresh Decide prompt → declare one step from f_0001
				switch {
				case strings.Contains(cmd.Message, "Execute mode"):
					finalText = `{"accepted":true,"data":{"finding":{"content":"e2e observed the objective is reachable","evidence":"mock tool output: ok"}}}`
				case strings.Contains(cmd.Message, "fd_0001 [open]"):
					finalText = `{"accepted":true,"data":{"findings":{"promote":["fd_0001"],"discard":[]},"complete":{"from":["f_0002"],"description":"e2e objective met"}}}`
				default:
					finalText = `{"accepted":true,"data":{"steps":[{"from":["f_0001"],"description":"e2e explore the target"}]}}`
				}
			}
			switch scenario {
			case "garbage":
				fmt.Fprintln(os.Stdout, "this is { not json")
			case "crash":
				fmt.Fprintln(os.Stderr, "mockpi: simulated crash")
				os.Exit(3)
			case "cmd_fail":
				resp(cmd.ID, "prompt", false, nil, "model unavailable")
				continue
			case "no_settled":
				resp(cmd.ID, "prompt", true, map[string]any{"disposition": "started"}, "")
				continue // never settles
			case "exit_late":
				resp(cmd.ID, "prompt", true, map[string]any{"disposition": "started"}, "")
				time.Sleep(delay)
				os.Exit(0)
			case "handled":
				// settled fires BEFORE the response; adapter must cope
				emit(map[string]any{"type": "agent_settled"})
				resp(cmd.ID, "prompt", true, map[string]any{"disposition": "handled"}, "")
				continue
			case "policy_violation":
				// a banned command runs first; settled only much later —
				// a policy-aware adapter must abort without waiting for it
				resp(cmd.ID, "prompt", true, map[string]any{"disposition": "started"}, "")
				emit(map[string]any{
					"type": "bash_execution_update", "command": "rm -rf /data", "exitCode": 0,
				})
				time.Sleep(2 * time.Second)
				emit(map[string]any{"type": "agent_settled"})
				continue
			case "stderr_noise":
				fmt.Fprintln(os.Stderr, "diag: irrelevant stderr chatter")
			}
			resp(cmd.ID, "prompt", true, map[string]any{"disposition": "started"}, "")
			time.Sleep(delay)
			emit(map[string]any{"type": "agent_start"})
			if scenario == "tool_use" {
				emit(map[string]any{
					"type": "bash_execution_update", "command": "nmap -sV target",
					"output": "22/tcp open", "exitCode": 0,
				})
			}
			emit(map[string]any{
				"type":                  "message_update",
				"assistantMessageEvent": map[string]any{"type": "text_delta", "delta": strings.Repeat("x", 10)},
			})
			emit(map[string]any{
				"type": "message_end",
				"message": map[string]any{
					"role":    "assistant",
					"content": []map[string]any{{"type": "text", "text": finalText}},
				},
			})
			emit(map[string]any{"type": "agent_end"})
			emit(map[string]any{"type": "agent_settled"})
		case "abort":
			resp(cmd.ID, "abort", true, nil, "")
			emit(map[string]any{"type": "agent_settled"})
		case "get_last_assistant_text":
			if scenario == "no_text" {
				resp(cmd.ID, "get_last_assistant_text", true, map[string]any{"text": ""}, "")
			} else {
				resp(cmd.ID, "get_last_assistant_text", true, map[string]any{"text": finalText}, "")
			}
		default:
			resp(cmd.ID, cmd.Type, true, nil, "")
		}
	}
	// stdin closed → graceful exit
	os.Exit(0)
}
