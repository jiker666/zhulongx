package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"zhulongx/internal/fgs"
)

// findings.go implements Finding review — the FGS trust boundary. Only
// Decide (never Execute) may promote a Finding into a Fact; this is the
// mechanism behind "an agent claiming success is not task success".

const findingCols = `id, goal_id, step_id, content, evidence, status, fact_id, created_at, decided_at`

func scanFinding(row rowScanner) (*fgs.Finding, error) {
	var f fgs.Finding
	var factID sql.NullString
	var decidedAt sql.NullString
	var createdAt string
	if err := row.Scan(&f.ID, &f.GoalID, &f.StepID, &f.Content, &f.Evidence, &f.Status, &factID, &createdAt, &decidedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	f.CreatedAt = parseT(createdAt)
	if factID.Valid {
		f.FactID = factID.String
	}
	if decidedAt.Valid && decidedAt.String != "" {
		t := parseT(decidedAt.String)
		f.DecidedAt = &t
	}
	return &f, nil
}

// ListFindings returns findings for a goal; openOnly filters to status=open.
func (s *Store) ListFindings(ctx context.Context, goalID string, openOnly bool) ([]fgs.Finding, error) {
	q := `SELECT ` + findingCols + ` FROM findings WHERE goal_id = ?`
	if openOnly {
		q += ` AND status = 'open'`
	}
	q += ` ORDER BY created_at, id`
	rows, err := s.db.QueryContext(ctx, q, goalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []fgs.Finding
	for rows.Next() {
		f, err := scanFinding(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

// ReviewFindings promotes and/or discards open findings in one transaction.
// Promotion creates a Fact per finding (content carried over verbatim,
// source records the promotion chain). Unknown or non-open ids fail the
// whole operation — no partial application.
func (s *Store) ReviewFindings(ctx context.Context, goalID string, promoteIDs, discardIDs []string, actor string) (facts []fgs.Fact, err error) {
	seen := map[string]bool{}
	for _, id := range append(append([]string{}, promoteIDs...), discardIDs...) {
		if seen[id] {
			return nil, fmt.Errorf("%w: %s listed twice", ErrFindingNotOpen, id)
		}
		seen[id] = true
	}
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		g, err := s.getGoalForUpdate(tx, goalID)
		if err != nil {
			return err
		}
		if g.Status != fgs.GoalActive {
			return fmt.Errorf("%w: goal is %s", ErrGoalNotActive, g.Status)
		}
		now := nowUTC()
		for _, fid := range promoteIDs {
			row := tx.QueryRow(`SELECT `+findingCols+` FROM findings WHERE goal_id = ? AND id = ?`, goalID, fid)
			f, err := scanFinding(row)
			if err != nil {
				return err
			}
			if f.Status != fgs.FindingOpen {
				return fmt.Errorf("%w: %s is %s", ErrFindingNotOpen, fid, f.Status)
			}
			factID, err := nextID(tx, goalID, "fact", "f_")
			if err != nil {
				return err
			}
			if _, err := tx.Exec(
				`INSERT INTO facts(id, goal_id, content, source, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
				factID, goalID, f.Content, "decide:promote:"+fid, f.Evidence, now,
			); err != nil {
				return err
			}
			if _, err := tx.Exec(
				`UPDATE findings SET status = 'promoted', fact_id = ?, decided_at = ? WHERE goal_id = ? AND id = ?`,
				factID, now, goalID, fid,
			); err != nil {
				return err
			}
			if err := audit(tx, goalID, actor, "finding.promoted", "finding:"+fid, "fact:"+factID); err != nil {
				return err
			}
			facts = append(facts, fgs.Fact{ID: factID, GoalID: goalID, Content: f.Content, Source: "decide:promote:" + fid, Evidence: f.Evidence, CreatedAt: parseT(now)})
		}
		for _, fid := range discardIDs {
			res, err := tx.Exec(
				`UPDATE findings SET status = 'discarded', decided_at = ? WHERE goal_id = ? AND id = ? AND status = 'open'`,
				now, goalID, fid,
			)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return fmt.Errorf("%w: %s", ErrFindingNotOpen, fid)
			}
			if err := audit(tx, goalID, actor, "finding.discarded", "finding:"+fid, ""); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return facts, nil
}

// AddHumanFact lets a human inject a verified fact directly (e.g. after
// manual verification outside the loop).
func (s *Store) AddHumanFact(ctx context.Context, goalID, content, creator string) (*fgs.Fact, error) {
	if err := nonEmpty(content, "content"); err != nil {
		return nil, err
	}
	var out *fgs.Fact
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := s.getGoalForUpdate(tx, goalID); err != nil {
			return err
		}
		fid, err := nextID(tx, goalID, "fact", "f_")
		if err != nil {
			return err
		}
		now := nowUTC()
		if _, err := tx.Exec(
			`INSERT INTO facts(id, goal_id, content, source, created_at) VALUES (?, ?, ?, ?, ?)`,
			fid, goalID, content, "human:"+creator, now,
		); err != nil {
			return err
		}
		if err := audit(tx, goalID, creator, "fact.created", "fact:"+fid, "human"); err != nil {
			return err
		}
		out = &fgs.Fact{ID: fid, GoalID: goalID, Content: content, Source: "human:" + creator, CreatedAt: parseT(now)}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Graph is the full context snapshot handed to prompts (Cairn:
// ProjectDetail + the export YAML written into containers).
type Graph struct {
	Goal     fgs.Goal      `json:"goal" yaml:"goal"`
	Facts    []fgs.Fact    `json:"facts" yaml:"facts"`
	Steps    []fgs.Step    `json:"steps" yaml:"steps"`
	Findings []fgs.Finding `json:"findings" yaml:"findings"`
	Hints    []fgs.Hint    `json:"hints" yaml:"hints"`
}

// LoadGraph assembles the full graph snapshot for a goal.
func (s *Store) LoadGraph(ctx context.Context, goalID string) (*Graph, error) {
	g, err := s.GetGoal(ctx, goalID)
	if err != nil {
		return nil, err
	}
	graph := &Graph{Goal: *g}
	if graph.Facts, err = s.ListFacts(ctx, goalID); err != nil {
		return nil, err
	}
	if graph.Steps, err = s.ListSteps(ctx, goalID); err != nil {
		return nil, err
	}
	if graph.Findings, err = s.ListFindings(ctx, goalID, false); err != nil {
		return nil, err
	}
	if graph.Hints, err = s.ListHints(ctx, goalID); err != nil {
		return nil, err
	}
	return graph, nil
}

// SnapshotCounts feeds the Decide trigger heuristic (Cairn:
// ReasonCheckpoint fact/hint/open-intent counts).
type SnapshotCounts struct {
	Facts     int
	Findings  int
	Hints     int
	OpenSteps int
}

// Snapshot returns the current growth counters for a goal.
func (s *Store) Snapshot(ctx context.Context, goalID string) (SnapshotCounts, error) {
	var sc SnapshotCounts
	err := s.db.QueryRowContext(ctx, `
		SELECT
			(SELECT COUNT(*) FROM facts WHERE goal_id = ?),
			(SELECT COUNT(*) FROM findings WHERE goal_id = ?),
			(SELECT COUNT(*) FROM hints WHERE goal_id = ?),
			(SELECT COUNT(*) FROM steps WHERE goal_id = ? AND status IN ('pending','running'))`,
		goalID, goalID, goalID, goalID,
	).Scan(&sc.Facts, &sc.Findings, &sc.Hints, &sc.OpenSteps)
	return sc, err
}
