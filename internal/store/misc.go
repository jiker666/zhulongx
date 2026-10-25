package store

import (
	"context"
	"database/sql"

	"gopkg.in/yaml.v3"

	"zhulongx/internal/fgs"
)

// misc.go: facts, hints, audit reads, and YAML export.

// ListFacts returns all facts of a goal in creation order (append-only).
func (s *Store) ListFacts(ctx context.Context, goalID string) ([]fgs.Fact, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, goal_id, content, source, evidence, created_at FROM facts WHERE goal_id = ? ORDER BY created_at, id`, goalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []fgs.Fact
	for rows.Next() {
		var f fgs.Fact
		var createdAt string
		if err := rows.Scan(&f.ID, &f.GoalID, &f.Content, &f.Source, &f.Evidence, &createdAt); err != nil {
			return nil, err
		}
		f.CreatedAt = parseT(createdAt)
		out = append(out, f)
	}
	return out, rows.Err()
}

// AddHint records human guidance shown to every Decide round.
func (s *Store) AddHint(ctx context.Context, goalID, content, creator string) (*fgs.Hint, error) {
	if err := nonEmpty(content, "content"); err != nil {
		return nil, err
	}
	if err := nonEmpty(creator, "creator"); err != nil {
		return nil, err
	}
	var out *fgs.Hint
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := s.getGoalForUpdate(tx, goalID); err != nil {
			return err
		}
		hid, err := nextID(tx, goalID, "hint", "h_")
		if err != nil {
			return err
		}
		now := nowUTC()
		if _, err := tx.Exec(
			`INSERT INTO hints(id, goal_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)`,
			hid, goalID, content, creator, now,
		); err != nil {
			return err
		}
		if err := audit(tx, goalID, creator, "hint.created", "hint:"+hid, ""); err != nil {
			return err
		}
		out = &fgs.Hint{ID: hid, GoalID: goalID, Content: content, Creator: creator, CreatedAt: parseT(now)}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ListHints returns hints of a goal in creation order.
func (s *Store) ListHints(ctx context.Context, goalID string) ([]fgs.Hint, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, goal_id, content, creator, created_at FROM hints WHERE goal_id = ? ORDER BY created_at, id`, goalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []fgs.Hint
	for rows.Next() {
		var h fgs.Hint
		var createdAt string
		if err := rows.Scan(&h.ID, &h.GoalID, &h.Content, &h.Creator, &createdAt); err != nil {
			return nil, err
		}
		h.CreatedAt = parseT(createdAt)
		out = append(out, h)
	}
	return out, rows.Err()
}

// ListAudit returns audit entries for a goal (or all goals when goalID=="").
func (s *Store) ListAudit(ctx context.Context, goalID string, limit int) ([]fgs.Audit, error) {
	if limit <= 0 {
		limit = 200
	}
	q := `SELECT seq, goal_id, actor, action, entity, detail, at FROM audit`
	args := []any{}
	if goalID != "" {
		q += ` WHERE goal_id = ?`
		args = append(args, goalID)
	}
	q += ` ORDER BY seq DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []fgs.Audit
	for rows.Next() {
		var a fgs.Audit
		var at string
		if err := rows.Scan(&a.Seq, &a.GoalID, &a.Actor, &a.Action, &a.Entity, &a.Detail, &at); err != nil {
			return nil, err
		}
		a.At = parseT(at)
		out = append(out, a)
	}
	return out, rows.Err()
}

// ExportYAML renders the graph as YAML
// which the dispatcher snapshotted into the container for prompts).
func (s *Store) ExportYAML(ctx context.Context, goalID string) (string, error) {
	g, err := s.LoadGraph(ctx, goalID)
	if err != nil {
		return "", err
	}
	return renderGraphYAML(g)
}

// renderGraphYAML serializes the graph with stable field order.
func renderGraphYAML(g *Graph) (string, error) {
	type yamlFact struct {
		ID        string `yaml:"id"`
		Content   string `yaml:"content"`
		Source    string `yaml:"source"`
		CreatedAt string `yaml:"created_at"`
	}
	type yamlStep struct {
		ID          string   `yaml:"id"`
		Description string   `yaml:"description"`
		DependsOn   []string `yaml:"depends_on,omitempty"`
		Status      string   `yaml:"status"`
		Attempts    int      `yaml:"attempts"`
		CreatedAt   string   `yaml:"created_at"`
	}
	type yamlFinding struct {
		ID        string `yaml:"id"`
		StepID    string `yaml:"step"`
		Content   string `yaml:"content"`
		Status    string `yaml:"status"`
		CreatedAt string `yaml:"created_at"`
	}
	type yamlHint struct {
		ID        string `yaml:"id"`
		Content   string `yaml:"content"`
		Creator   string `yaml:"creator"`
		CreatedAt string `yaml:"created_at"`
	}
	type yamlGraph struct {
		Goal struct {
			ID     string `yaml:"id"`
			Title  string `yaml:"title"`
			Status string `yaml:"status"`
		} `yaml:"goal"`
		Origin    string        `yaml:"origin"`
		Objective string        `yaml:"objective"`
		Facts     []yamlFact    `yaml:"facts"`
		Steps     []yamlStep    `yaml:"steps"`
		Findings  []yamlFinding `yaml:"findings"`
		Hints     []yamlHint    `yaml:"hints"`
	}
	out := yamlGraph{
		Origin:    g.Goal.Origin,
		Objective: g.Goal.Objective,
		Facts:     []yamlFact{},
		Steps:     []yamlStep{},
		Findings:  []yamlFinding{},
		Hints:     []yamlHint{},
	}
	out.Goal.ID = g.Goal.ID
	out.Goal.Title = g.Goal.Title
	out.Goal.Status = string(g.Goal.Status)
	for _, f := range g.Facts {
		out.Facts = append(out.Facts, yamlFact{f.ID, f.Content, f.Source, f.CreatedAt.Format("2006-01-02T15:04:05Z")})
	}
	for _, st := range g.Steps {
		out.Steps = append(out.Steps, yamlStep{st.ID, st.Description, st.DependsOn, string(st.Status), st.Attempts, st.CreatedAt.Format("2006-01-02T15:04:05Z")})
	}
	for _, f := range g.Findings {
		out.Findings = append(out.Findings, yamlFinding{f.ID, f.StepID, f.Content, string(f.Status), f.CreatedAt.Format("2006-01-02T15:04:05Z")})
	}
	for _, h := range g.Hints {
		out.Hints = append(out.Hints, yamlHint{h.ID, h.Content, h.Creator, h.CreatedAt.Format("2006-01-02T15:04:05Z")})
	}
	b, err := yaml.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
