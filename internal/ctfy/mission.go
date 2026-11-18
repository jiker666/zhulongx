package ctfy

import (
	"fmt"
	"strings"
	"time"
)

// AWDView is the driver-synced match state shown in an awd mission: the
// field roster and the tick clock (flags die at each rollover, so timing
// beats depth).
type AWDView struct {
	Targets        []AWDTarget
	CurrentTick    int
	TotalTicks     int
	TickSeconds    int
	NextRolloverIn time.Duration // 0 = clock unknown
	MatchEndsIn    time.Duration // 0 = unknown
}

// MissionOptions is the per-session snapshot the mission renders from.
type MissionOptions struct {
	Mode          string
	Round         int // session number within this container run
	SessionsCap   int // 0 = no fixed cap
	TargetURL     string
	TargetInst    string
	Endpoints     []Endpoint
	Attachments   []Attachment
	Scope         []string
	Rules         []string
	Deliverable   string
	CompetitionID string
	ChallengeID   string
	AWD           *AWDView
	README        string
	Doctrine      string
}

// BuildMission renders the full session prompt. The README is included
// verbatim and FIRST: it is the platform's authoritative per-round
// instruction (fresh verdicts every round), and everything else is
// scaffolding around it.
func BuildMission(qs []Question, st *State, o MissionOptions) string {
	var b strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }

	line("# CTFY dispatch — mode=%s — round %d", o.Mode, o.Round)
	if o.SessionsCap > 0 {
		line("# session budget: %d (soft); sessions used so far: %d", o.SessionsCap, st.Sessions)
	}
	line("")

	if o.README != "" {
		line("## Platform briefing (README.md — authoritative, re-read every round)")
		line("```")
		b.WriteString(strings.TrimRight(o.README, "\n"))
		line("```")
		line("")
	}

	line("## Questions now visible (%d)", len(qs))
	if len(qs) == 0 && o.Mode != "engagement" && o.Mode != "awd" {
		line("(none listed — for gated challenges the driver refreshes the list after each correct answer)")
	}
	for _, q := range qs {
		verdict := "unanswered"
		switch {
		case st.IsSolved(q.ID):
			nw := st.Wrong[q.ID]
			if nw > 0 {
				verdict = fmt.Sprintf("CORRECT (after %d wrong)", nw)
			} else {
				verdict = "CORRECT"
			}
		case st.Wrong[q.ID] > 0:
			verdict = fmt.Sprintf("%d wrong attempts recorded — re-derive from evidence before trying again", st.Wrong[q.ID])
		case st.Answers[q.ID] != "":
			verdict = "submitted, verdict unknown — re-check the platform's answer before resubmitting"
		}
		line("- %s [%s]", q.ID, verdict)
		line("  prompt: %s", oneLine(q.Prompt, 400))
	}
	line("")

	if o.Mode == "instance" || o.Mode == "defence" {
		line("## Target")
		if o.TargetInst != "" {
			line("- instance: %s (already running — never try to start or stop it)", o.TargetInst)
		}
		if o.TargetURL != "" {
			line("- web endpoint: %s", o.TargetURL)
		}
		for _, ep := range o.Endpoints {
			line("- %s (%s): %s", ep.Label, ep.Type, ep.URL)
		}
		if len(o.Attachments) > 0 {
			line("- attachments:")
			for _, a := range o.Attachments {
				if a.Path != nil {
					line("  - %s (%d bytes) at %s", a.Name, a.Size, *a.Path)
				} else {
					line("  - %s (%d bytes) not copied — fetch: GET /api/v1/instances/%s/attachments/%s", a.Name, a.Size, o.TargetInst, a.Name)
				}
			}
		}
		line("")
	}
	if o.Mode == "awd" {
		line("## AWD field")
		if o.AWD != nil && len(o.AWD.Targets) > 0 {
			own := ""
			for _, t := range o.AWD.Targets {
				if t.IsOwn {
					own = t.Address
					break
				}
			}
			for _, t := range o.AWD.Targets {
				marker := "rival"
				if t.IsOwn {
					marker = "OURS — defend first, never take it down"
				}
				if t.Team != "" {
					line("- %s (%s) — %s", t.Address, t.Team, marker)
				} else {
					line("- %s — %s", t.Address, marker)
				}
			}
			if own != "" {
				line("our box: %s (check liveness from OUTSIDE every session; repair before attacking)", own)
			}
		} else {
			line("(target roster not synced — fetch it yourself: the README's awd section)")
		}
		if o.AWD != nil && o.AWD.TickSeconds > 0 {
			total := ""
			if o.AWD.TotalTicks > 0 {
				total = fmt.Sprintf("/%d", o.AWD.TotalTicks)
			}
			line("tick clock: now in tick %d%s, %ds per tick; next rollover in ~%s",
				o.AWD.CurrentTick, total, o.AWD.TickSeconds, durShort(o.AWD.NextRolloverIn))
			line("flags on every box die at each rollover: bank captures IMMEDIATELY, replay")
			line("capture scripts every tick — the same exploit scores again on the new round.")
			if o.AWD.MatchEndsIn > 0 {
				line("match ends in ~%s — never exit before then (early exit = incomplete).", durShort(o.AWD.MatchEndsIn))
			}
		} else {
			line("tick clock unknown — derive it from the match info the README names, then time captures to rollovers.")
		}
		line("ssh credentials expire within minutes and are per-connection: fetch fresh, use at once, never cache.")
		line("")
	}
	if o.Mode == "engagement" {
		line("## Scope (stay inside it)")
		for _, s := range o.Scope {
			line("- %s", s)
		}
		if len(o.Rules) > 0 {
			line("## Rules of engagement")
			for _, r := range o.Rules {
				line("- %s", r)
			}
		}
		line("")
	}
	if o.Deliverable != "" {
		line("Deliverable: %s", o.Deliverable)
		line("")
	}

	line("## Persistent state (survives this container — the next round may be a fresh one)")
	line("- state/state.json — driver bookkeeping (submissions, verdicts) — do not edit")
	line("- attack/<question-id>/work.md — YOUR ledger per question: surfaces tried and their verdicts,")
	line("  footholds and re-entry recipes, falsified hypotheses and WHY, next cheapest leads.")
	line("  Keep it complete at the end of EVERY session; a restarted round reads ONLY these files.")
	line("- notes.md — your running campaign notes across questions (topology, creds, transferable tricks).")
	line("Read them first; write them before you finish.")
	line("")

	if o.Doctrine != "" {
		line("## Doctrine")
		b.WriteString(o.Doctrine)
		line("")
	}

	line("## This session")
	line("Work the questions (or the engagement/awd objective) with real tools. Submit every answer")
	line("yourself as you derive it, exactly the way the README above specifies, and record the")
	line("platform's verdict. When every visible question is answered, capped, or blocked — or no")
	line("cheap untested lead remains — stop tool work and reply.")
	line("")
	line("Your FINAL message must be exactly one JSON object (no fences, no prose after it):")
	line(`{"summary":"one tight paragraph of what this session established",`)
	line(` "submitted":[{"question_id":"...","answer":"...","verdict":"correct|wrong|unknown"}],`)
	if o.Mode == "awd" {
		line(` "flags":[{"value":"ctfy{...}","host":"10.0.0.5"}],`)
	}
	line(` "more_work":true|false,`)
	line(` "match_over":false}`)
	line("(match_over only applies on awd: set true when the platform says the match has ended.")
	if o.Mode == "awd" {
		line("flags lists every flag value you captured THIS session even if you already submitted it")
		line("yourself — the driver banks anything you missed; submitted carries any question-mode answers.)")
	} else {
		line("submitted lists answers you handed over THIS session, with the verdict the platform returned.)")
	}
	return b.String()
}

func durShort(d time.Duration) string {
	if d <= 0 {
		return "?"
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	return fmt.Sprintf("%dm", int(d.Minutes()))
}

func oneLine(s string, max int) string {
	s = strings.TrimSpace(s)
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}
