package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"zhulongx/internal/fgs"
)

// goals.go implements Goal lifecycle mutations.
//
// Cairn reference: server/routers/projects.py (create_project writes origin +
// goal facts; complete_project flips status and records from-facts;
// reopen_project un-completes with an external feedback fact).

const goalCols = `id, title, origin, objective, status, created_at, completed_at`

func scanGoal(row interface{ Scan(...any) error }) (*fgs.Goal, error) {
	var g fgs.Goal
	var createdAt, completedAt sql.NullString
	if err := row.Scan(&g.ID, &g.Title, &g.Origin, &g.Objective, &g.Status, &createdAt, &completedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, ErrNotFound
		}
		return nil, err
	}
	g.CreatedAt = parseT(createdAt.String)
	if completedAt.Valid && completedAt.String != "" {
		t := parseT(completedAt.String)
		g.CompletedAt = &t
	}
	return &g, nil
}

// CreateGoal creates an active goal. Cairn equivalent: POST /projects.
func (s *Store) CreateGoal(ctx context.Context, title, origin, objective string) (*fgs.Goal, error) {
	for _, c := range []struct{ val, name string }{{title, "title"}, {origin, "origin"}, {objective, "objective"}} {
		if err := nonEmpty(c.val, c.name); err != nil {
			return nil, err
		}
	}
	var g fgs.Goal
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		id, err := nextID(tx, "global", "goal", "goal_")
		if err != nil {
			return err
		}
		now := nowUTC()
		if _, err := tx.Exec(
			`INSERT INTO goals(id, title, origin, objective, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
			id, title, origin, objective, now,
		); err != nil {
			return err
		}
		detail, _ := json.Marshal(map[string]string{"title": title})
		if err := audit(tx, id, fgs.ActorHuman, "goal.created", "goal:"+id, string(detail)); err != nil {
			return err
		}
		g = fgs.Goal{ID: id, Title: title, Origin: origin, Objective: objective, Status: fgs.GoalActive, CreatedAt: parseT(now)}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// GetGoal fetches one goal.
func (s *Store) GetGoal(ctx context.Context, goalID string) (*fgs.Goal, error) {
	return scanGoal(s.db.QueryRowContext(ctx, `SELECT `+goalCols+` FROM goals WHERE id = ?`, goalID))
}

// ListGoals lists all goals in creation order.
func (s *Store) ListGoals(ctx context.Context) ([]fgs.Goal, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+goalCols+` FROM goals ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []fgs.Goal
	for rows.Next() {
		g, err := scanGoal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *g)
	}
	return out, rows.Err()
}

func (s *Store) getGoalForUpdate(tx *sql.Tx, goalID string) (*fgs.Goal, error) {
	return scanGoal(tx.QueryRow(`SELECT `+goalCols+` FROM goals WHERE id = ?`, goalID))
}

// CompleteGoal marks the goal completed. Cairn equivalent: complete_project —
// fromFacts must all exist; the verdict description is preserved in the audit
// trail (Cairn stored it on a synthetic intent pointing at 'goal').
func (s *Store) CompleteGoal(ctx context.Context, goalID string, fromFacts []string, description, actor string) error {
	if err := nonEmpty(description, "description"); err != nil {
		return err
	}
	if len(fromFacts) == 0 {
		return fmt.Errorf("%w: complete requires at least one source fact", ErrFactNotFound)
	}
	return s.withTx(ctx, func(tx *sql.Tx) error {
		g, err := s.getGoalForUpdate(tx, goalID)
		if err != nil {
			return err
		}
		if g.Status != fgs.GoalActive {
			return fmt.Errorf("%w: goal is %s", ErrGoalNotActive, g.Status)
		}
		for _, fid := range fromFacts {
			if err := factExists(tx, goalID, fid); err != nil {
				return err
			}
		}
		now := nowUTC()
		if _, err := tx.Exec(`UPDATE goals SET status = 'completed', completed_at = ? WHERE id = ?`, now, goalID); err != nil {
			return err
		}
		detail, _ := json.Marshal(map[string]any{"from": fromFacts, "description": description})
		return audit(tx, goalID, actor, "goal.completed", "goal:"+goalID, string(detail))
	})
}

// SetGoalStatus stops or resumes a goal (Cairn: PUT status). Stopping
// releases claims on running steps so a later resume can pick them up again.
func (s *Store) SetGoalStatus(ctx context.Context, goalID string, target fgs.GoalStatus, actor string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		g, err := s.getGoalForUpdate(tx, goalID)
		if err != nil {
			return err
		}
		if g.Status == target {
			return nil
		}
		// Completion must go through CompleteGoal (which validates source
		// facts); the human-facing toggle only stops/resumes.
		if target == fgs.GoalCompleted {
			return fmt.Errorf("%w: goal completion requires CompleteGoal", ErrIllegalTrans)
		}
		if !fgs.CanTransitionGoal(g.Status, target) {
			return fmt.Errorf("%w: goal %s → %s", ErrIllegalTrans, g.Status, target)
		}
		if target == fgs.GoalStopped {
			if _, err := tx.Exec(
				`UPDATE steps SET status = 'pending', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
				 WHERE goal_id = ? AND status = 'running'`, goalID,
			); err != nil {
				return err
			}
		}
		var completedAt any
		if target == fgs.GoalActive {
			completedAt = nil
		} else {
			completedAt = nowUTC()
		}
		if _, err := tx.Exec(`UPDATE goals SET status = ?, completed_at = ? WHERE id = ?`, target, completedAt, goalID); err != nil {
			return err
		}
		return audit(tx, goalID, actor, "goal."+string(target), "goal:"+goalID, "")
	})
}

// ReopenGoal brings a completed goal back to active and records the external
// feedback as a Fact (Cairn: reopen_project writes an 'external_feedback'
// intent + fact pair; zhulongx keeps just the fact plus audit).
func (s *Store) ReopenGoal(ctx context.Context, goalID, feedback, creator string) error {
	if err := nonEmpty(feedback, "feedback"); err != nil {
		return err
	}
	return s.withTx(ctx, func(tx *sql.Tx) error {
		g, err := s.getGoalForUpdate(tx, goalID)
		if err != nil {
			return err
		}
		if g.Status != fgs.GoalCompleted {
			return fmt.Errorf("%w: reopen requires completed goal, got %s", ErrIllegalTrans, g.Status)
		}
		fid, err := nextID(tx, goalID, "fact", "f_")
		if err != nil {
			return err
		}
		now := nowUTC()
		if _, err := tx.Exec(
			`INSERT INTO facts(id, goal_id, content, source, created_at) VALUES (?, ?, ?, 'human:reopen', ?)`,
			fid, goalID, feedback, now,
		); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE goals SET status = 'active', completed_at = NULL WHERE id = ?`, goalID); err != nil {
			return err
		}
		if err := audit(tx, goalID, creator, "fact.created", "fact:"+fid, "reopen feedback"); err != nil {
			return err
		}
		return audit(tx, goalID, creator, "goal.active", "goal:"+goalID, "reopened")
	})
}

func factExists(tx *sql.Tx, goalID, factID string) error {
	var one int
	err := tx.QueryRow(`SELECT 1 FROM facts WHERE goal_id = ? AND id = ?`, goalID, factID).Scan(&one)
	if err == sql.ErrNoRows {
		return fmt.Errorf("%w: %s", ErrFactNotFound, factID)
	}
	return err
}
