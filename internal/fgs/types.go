// Package fgs defines the zhulongx Fact/Goal/Step/Finding domain model,
// the legal state transitions between them, and the audit vocabulary.
//
// It is the Go re-imagining of Cairn's blackboard entities
// (cairn/server/models.py): Project → Goal, Fact → Fact (+Finding split),
// Intent → Step. Transition legality is enforced by the store layer
// (internal/store); this package declares the rules as data so both the
// store and tests can share one source of truth.
package fgs

import "time"

// GoalStatus is the lifecycle of a Goal (Cairn: project.status).
type GoalStatus string

const (
	GoalActive    GoalStatus = "active"
	GoalCompleted GoalStatus = "completed"
	GoalStopped   GoalStatus = "stopped"
)

// StepStatus is the lifecycle of a Step (Cairn: intent open/claimed/concluded
// expressed as worker+to_fact_id columns; here as one explicit column).
type StepStatus string

const (
	StepPending StepStatus = "pending" // declared by Decide, waiting for a runner
	StepRunning StepStatus = "running" // claimed by an engine Execute worker
	StepDone    StepStatus = "done"    // produced a Finding (may still be open)
	StepFailed  StepStatus = "failed"  // attempts exhausted / permanent error
	StepCancel  StepStatus = "cancelled"
)

// FindingStatus is the review lifecycle of a Finding. A Finding is what an
// Execute run produced; it becomes a Fact only after Decide promotes it.
type FindingStatus string

const (
	FindingOpen     FindingStatus = "open"
	FindingPromoted FindingStatus = "promoted" // copied into a Fact
	FindingDiscard  FindingStatus = "discarded"
)

// Goal is the top-level objective (Cairn folded origin/goal into two special
// facts; zhulongx makes them first-class fields).
type Goal struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Origin      string     `json:"origin"`
	Objective   string     `json:"objective"`
	Status      GoalStatus `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

// Step is an executable unit of work declared by Decide (Cairn: Intent).
// DependsOn lists Fact ids that must exist when the Step is created — the
// source-tracking counterpart of Cairn's intent_sources table.
type Step struct {
	ID          string     `json:"id"`
	GoalID      string     `json:"goal_id"`
	Description string     `json:"description"`
	DependsOn   []string   `json:"depends_on"`
	Status      StepStatus `json:"status"`
	Producer    string     `json:"producer"`
	Attempts    int        `json:"attempts"`
	ClaimedBy   string     `json:"claimed_by,omitempty"`
	ClaimedAt   *time.Time `json:"claimed_at,omitempty"`
	HeartbeatAt *time.Time `json:"heartbeat_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
	FindingID   string     `json:"finding_id,omitempty"`
	FactID      string     `json:"fact_id,omitempty"`
	LastError   string     `json:"last_error,omitempty"`
}

// Finding is an unverified observation produced by one Execute run.
type Finding struct {
	ID        string        `json:"id"`
	GoalID    string        `json:"goal_id"`
	StepID    string        `json:"step_id"`
	Content   string        `json:"content"`
	Evidence  string        `json:"evidence,omitempty"`
	Status    FindingStatus `json:"status"`
	FactID    string        `json:"fact_id,omitempty"`
	CreatedAt time.Time     `json:"created_at"`
	DecidedAt *time.Time    `json:"decided_at,omitempty"`
}

// Fact is a verified, append-only conclusion (Cairn: facts table). Once
// written a Fact never changes — steps may only depend on existing Facts.
type Fact struct {
	ID        string    `json:"id"`
	GoalID    string    `json:"goal_id"`
	Content   string    `json:"content"`
	Source    string    `json:"source"`
	Evidence  string    `json:"evidence,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// Hint is human guidance injected into the Decide context (Cairn: hints).
type Hint struct {
	ID        string    `json:"id"`
	GoalID    string    `json:"goal_id"`
	Content   string    `json:"content"`
	Creator   string    `json:"creator"`
	CreatedAt time.Time `json:"created_at"`
}

// Audit is one append-only audit record. Every graph mutation must leave
// exactly one Audit row; recovery and forensics rely on it.
type Audit struct {
	Seq    int64     `json:"seq"`
	GoalID string    `json:"goal_id"`
	Actor  string    `json:"actor"`  // decide | execute | engine | human
	Action string    `json:"action"` // e.g. step.claimed, finding.promoted
	Entity string    `json:"entity"` // e.g. step:s_0002
	Detail string    `json:"detail,omitempty"`
	At     time.Time `json:"at"`
}

// Actor constants used in Audit rows.
const (
	ActorDecide = "decide"
	ActorExec   = "execute"
	ActorEngine = "engine"
	ActorHuman  = "human"
)
