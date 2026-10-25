package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"zhulongx/internal/fgs"
)

// steps.go implements the Step lifecycle: creation with dependency
// validation, CAS-style claim, heartbeat, finish-with-finding, failure
// classification, and reclaim (crash recovery).
//
// claim/heartbeat/conclude semantics with lease-expiry reclaim
// (crash recovery) and best-effort release paths.

const stepCols = `id, goal_id, description, status, producer, attempts, claimed_by,
	claimed_at, heartbeat_at, created_at, finished_at, finding_id, fact_id, last_error`

type rowScanner interface{ Scan(dest ...any) error }

func scanStep(row rowScanner, q queryer, goalID string) (*fgs.Step, error) {
	var st fgs.Step
	var claimedBy sql.NullString
	var claimedAt, heartbeatAt, finishedAt sql.NullString
	var findingID, factID, lastErr sql.NullString
	var createdAt string
	if err := row.Scan(&st.ID, &st.GoalID, &st.Description, &st.Status, &st.Producer, &st.Attempts,
		&claimedBy, &claimedAt, &heartbeatAt, &createdAt, &finishedAt, &findingID, &factID, &lastErr); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	st.CreatedAt = parseT(createdAt)
	setTime := func(dst **time.Time, src sql.NullString) {
		if src.Valid && src.String != "" {
			t := parseT(src.String)
			*dst = &t
		}
	}
	setTime(&st.ClaimedAt, claimedAt)
	setTime(&st.HeartbeatAt, heartbeatAt)
	setTime(&st.FinishedAt, finishedAt)
	if claimedBy.Valid {
		st.ClaimedBy = claimedBy.String
	}
	if findingID.Valid {
		st.FindingID = findingID.String
	}
	if factID.Valid {
		st.FactID = factID.String
	}
	if lastErr.Valid {
		st.LastError = lastErr.String
	}
	if q != nil {
		st.DependsOn = scanDeps(q, goalID, st.ID)
	}
	return &st, nil
}

type queryer interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func scanDeps(q queryer, goalID, stepID string) []string {
	rows, err := q.Query(`SELECT fact_id FROM step_deps WHERE goal_id = ? AND step_id = ? ORDER BY fact_id`, goalID, stepID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var fid string
		if err := rows.Scan(&fid); err != nil {
			return out
		}
		out = append(out, fid)
	}
	return out
}

// CreateStep declares a new pending step. Every depends-on fact must already
// exist.
func (s *Store) CreateStep(ctx context.Context, goalID, description string, dependsOn []string, producer string) (*fgs.Step, error) {
	if err := nonEmpty(description, "description"); err != nil {
		return nil, err
	}
	var st fgs.Step
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		g, err := s.getGoalForUpdate(tx, goalID)
		if err != nil {
			return err
		}
		if g.Status != fgs.GoalActive {
			return fmt.Errorf("%w: goal is %s", ErrGoalNotActive, g.Status)
		}
		for _, fid := range dependsOn {
			if err := factExists(tx, goalID, fid); err != nil {
				return err
			}
		}
		id, err := nextID(tx, goalID, "step", "s_")
		if err != nil {
			return err
		}
		now := nowUTC()
		if _, err := tx.Exec(
			`INSERT INTO steps(id, goal_id, description, status, producer, created_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
			id, goalID, description, producer, now,
		); err != nil {
			return err
		}
		for _, fid := range dependsOn {
			if _, err := tx.Exec(`INSERT INTO step_deps(goal_id, step_id, fact_id) VALUES (?, ?, ?)`, goalID, id, fid); err != nil {
				return err
			}
		}
		detail, _ := json.Marshal(map[string]any{"depends_on": dependsOn})
		if err := audit(tx, goalID, producer, "step.created", "step:"+id, string(detail)); err != nil {
			return err
		}
		st = fgs.Step{ID: id, GoalID: goalID, Description: description, Status: fgs.StepPending, Producer: producer, DependsOn: dependsOn, CreatedAt: parseT(now)}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &st, nil
}

// ClaimNextStep claims the oldest pending step for claimer. The compare-and-
// swap UPDATE makes double-claiming impossible even across processes.
// Returns ErrNothingToClaim when the goal has no pending steps.
func (s *Store) ClaimNextStep(ctx context.Context, goalID, claimer string) (*fgs.Step, error) {
	var st *fgs.Step
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		g, err := s.getGoalForUpdate(tx, goalID)
		if err != nil {
			return err
		}
		if g.Status != fgs.GoalActive {
			return fmt.Errorf("%w: goal is %s", ErrGoalNotActive, g.Status)
		}
		// One running step per goal: a goal's steps are sequential probes
		// (later ones build on earlier findings), so a second concurrent
		// slot on the same goal wastes the global execute budget. The
		// engine treats this like an empty queue and moves to the next
		// goal, spreading slots across goals.
		var running int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM steps WHERE goal_id = ? AND status = 'running'`, goalID).Scan(&running); err != nil {
			return err
		}
		if running > 0 {
			return ErrNothingToClaim
		}
		row := tx.QueryRow(`SELECT `+stepCols+` FROM steps WHERE goal_id = ? AND status = 'pending' ORDER BY created_at, id LIMIT 1`, goalID)
		candidate, err := scanStep(row, tx, goalID)
		if errors.Is(err, ErrNotFound) {
			return ErrNothingToClaim // no pending rows: the normal empty-queue case
		}
		if err != nil {
			return err
		}
		now := nowUTC()
		res, err := tx.Exec(
			`UPDATE steps SET status = 'running', claimed_by = ?, claimed_at = ?, heartbeat_at = ?, attempts = attempts + 1
			 WHERE goal_id = ? AND id = ? AND status = 'pending'`,
			claimer, now, now, goalID, candidate.ID,
		)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return ErrNothingToClaim
		}
		if err := audit(tx, goalID, claimer, "step.claimed", "step:"+candidate.ID, ""); err != nil {
			return err
		}
		candidate.Status = fgs.StepRunning
		candidate.ClaimedBy = claimer
		candidate.Attempts++
		st = candidate
		return nil
	})
	if err != nil {
		return nil, err
	}
	return st, nil
}

// HeartbeatStep refreshes the claim lease. Returns ErrClaimLost when the
// step is no longer running or is claimed by someone else (lost-claim
// race → task aborts immediately).
func (s *Store) HeartbeatStep(ctx context.Context, goalID, stepID, claimer string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.Exec(
			`UPDATE steps SET heartbeat_at = ? WHERE goal_id = ? AND id = ? AND status = 'running' AND claimed_by = ?`,
			nowUTC(), goalID, stepID, claimer,
		)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrClaimLost
		}
		return nil
	})
}

// FinishStepWithFinding completes a step and records its output as an open
// Finding in one transaction (the Finding is inserted atomically and
// Decide later promotes it to a Fact, so an agent's claim of success never
// becomes graph
// truth on its own).
func (s *Store) FinishStepWithFinding(ctx context.Context, goalID, stepID, claimer, findingContent, evidence string) (*fgs.Finding, error) {
	if err := nonEmpty(findingContent, "finding content"); err != nil {
		return nil, err
	}
	var out *fgs.Finding
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		g, err := s.getGoalForUpdate(tx, goalID)
		if err != nil {
			return err
		}
		if g.Status != fgs.GoalActive {
			return fmt.Errorf("%w: goal is %s", ErrGoalNotActive, g.Status)
		}
		st, err := loadStepForUpdate(tx, goalID, stepID)
		if err != nil {
			return err
		}
		if st.Status != fgs.StepRunning || st.ClaimedBy != claimer {
			return ErrClaimLost
		}
		fid, err := nextID(tx, goalID, "finding", "fd_")
		if err != nil {
			return err
		}
		now := nowUTC()
		if _, err := tx.Exec(
			`INSERT INTO findings(id, goal_id, step_id, content, evidence, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
			fid, goalID, stepID, findingContent, evidence, now,
		); err != nil {
			return err
		}
		if _, err := tx.Exec(
			`UPDATE steps SET status = 'done', finished_at = ?, finding_id = ?, last_error = '' WHERE goal_id = ? AND id = ?`,
			now, fid, goalID, stepID,
		); err != nil {
			return err
		}
		if err := audit(tx, goalID, claimer, "finding.created", "finding:"+fid, "step:"+stepID); err != nil {
			return err
		}
		if err := audit(tx, goalID, claimer, "step.done", "step:"+stepID, "finding:"+fid); err != nil {
			return err
		}
		out = &fgs.Finding{ID: fid, GoalID: goalID, StepID: stepID, Content: findingContent, Evidence: evidence, Status: fgs.FindingOpen, CreatedAt: parseT(now)}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// FailStep records a failed attempt. Retryable errors return the step to
// pending while attempts remain below maxAttempts; otherwise (or for
// permanent errors such as permission denial) the step fails for good.
func (s *Store) FailStep(ctx context.Context, goalID, stepID, claimer, errMsg string, retryable bool, maxAttempts int) (fgs.StepStatus, error) {
	var final fgs.StepStatus
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		st, err := loadStepForUpdate(tx, goalID, stepID)
		if err != nil {
			return err
		}
		if st.Status != fgs.StepRunning {
			return ErrClaimLost
		}
		if st.ClaimedBy != "" && st.ClaimedBy != claimer {
			return ErrClaimLost
		}
		target := fgs.StepFailed
		if retryable && st.Attempts < maxAttempts {
			target = fgs.StepPending
		}
		if !fgs.CanTransitionStep(fgs.StepRunning, target) {
			return fmt.Errorf("%w: step running → %s", ErrIllegalTrans, target)
		}
		now := nowUTC()
		if target == fgs.StepPending {
			if _, err := tx.Exec(
				`UPDATE steps SET status = 'pending', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, last_error = ? WHERE goal_id = ? AND id = ?`,
				errMsg, goalID, stepID,
			); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(
				`UPDATE steps SET status = 'failed', finished_at = ?, claimed_by = NULL, last_error = ? WHERE goal_id = ? AND id = ?`,
				now, errMsg, goalID, stepID,
			); err != nil {
				return err
			}
		}
		detail, _ := json.Marshal(map[string]any{"retryable": retryable, "attempts": st.Attempts, "error": truncate(errMsg, 400)})
		if err := audit(tx, goalID, claimer, "step."+string(target), "step:"+stepID, string(detail)); err != nil {
			return err
		}
		final = target
		return nil
	})
	return final, err
}

// ReclaimStaleSteps returns running steps whose heartbeat is older than ttl
// (or never set) to pending. Used when an engine instance died mid-run;
// single-process zhulongx calls it on startup.
func (s *Store) ReclaimStaleSteps(ctx context.Context, ttl time.Duration, reason string) (int, error) {
	cutoff := time.Now().UTC().Add(-ttl).Format(timeLayout)
	reclaimed := 0
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.Query(
			`SELECT id, goal_id FROM steps WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
			cutoff,
		)
		if err != nil {
			return err
		}
		type pair struct{ id, goal string }
		var stale []pair
		for rows.Next() {
			var p pair
			if err := rows.Scan(&p.id, &p.goal); err != nil {
				rows.Close()
				return err
			}
			stale = append(stale, p)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, p := range stale {
			if _, err := tx.Exec(
				`UPDATE steps SET status = 'pending', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL WHERE goal_id = ? AND id = ?`,
				p.goal, p.id,
			); err != nil {
				return err
			}
			if err := audit(tx, p.goal, fgs.ActorEngine, "step.reclaimed", "step:"+p.id, reason); err != nil {
				return err
			}
			reclaimed++
		}
		return nil
	})
	return reclaimed, err
}

// ListSteps returns all steps for a goal in creation order.
//
// NOTE: deps are fetched only AFTER the first result set is closed — the
// store runs on a single connection, so a nested Query would deadlock.
func (s *Store) ListSteps(ctx context.Context, goalID string) ([]fgs.Step, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+stepCols+` FROM steps WHERE goal_id = ? ORDER BY created_at, id`, goalID)
	if err != nil {
		return nil, err
	}
	var out []fgs.Step
	for rows.Next() {
		st, err := scanStep(rows, nil, goalID)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, *st)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for i := range out {
		out[i].DependsOn = scanDeps(s.db, goalID, out[i].ID)
	}
	return out, nil
}

// OpenStepCount returns pending+running step counts for Decide scheduling.
func (s *Store) OpenStepCount(ctx context.Context, goalID string) (pending, running int, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT
			COALESCE(SUM(status = 'pending'), 0),
			COALESCE(SUM(status = 'running'), 0)
		 FROM steps WHERE goal_id = ?`, goalID,
	).Scan(&pending, &running)
	return
}

func loadStepForUpdate(tx *sql.Tx, goalID, stepID string) (*fgs.Step, error) {
	row := tx.QueryRow(`SELECT `+stepCols+` FROM steps WHERE goal_id = ? AND id = ?`, goalID, stepID)
	return scanStep(row, nil, "")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// RecoverAllRunning resets every running step to pending — deterministic
// startup recovery for a single-process engine: on boot nobody can hold a
// valid claim, so all in-flight attempts go back to the queue (attempts
// counters are preserved so crash-looping steps still exhaust).
func (s *Store) RecoverAllRunning(ctx context.Context, reason string) (int, error) {
	reclaimed := 0
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT id, goal_id FROM steps WHERE status = 'running'`)
		if err != nil {
			return err
		}
		type pair struct{ id, goal string }
		var stale []pair
		for rows.Next() {
			var p pair
			if err := rows.Scan(&p.id, &p.goal); err != nil {
				rows.Close()
				return err
			}
			stale = append(stale, p)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, p := range stale {
			if _, err := tx.Exec(
				`UPDATE steps SET status = 'pending', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL WHERE goal_id = ? AND id = ?`,
				p.goal, p.id,
			); err != nil {
				return err
			}
			if err := audit(tx, p.goal, fgs.ActorEngine, "step.reclaimed", "step:"+p.id, reason); err != nil {
				return err
			}
			reclaimed++
		}
		return nil
	})
	return reclaimed, err
}
