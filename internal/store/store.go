// Package store is zhulongx's SQLite persistence layer for the FGS graph.
//
// It is an embedded store: no HTTP, one process, direct SQL with
// transactional graph mutations and an audit log.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver (no cgo, Windows-friendly)
)

// Sentinel errors mirroring classic HTTP error classes.
var (
	ErrNotFound       = errors.New("zhulongx: not found")
	ErrGoalNotActive  = errors.New("zhulongx: goal is not active")
	ErrIllegalTrans   = errors.New("zhulongx: illegal state transition")
	ErrClaimLost      = errors.New("zhulongx: claim lost or held by another worker")
	ErrFactNotFound   = errors.New("zhulongx: source fact not found")
	ErrNothingToClaim = errors.New("zhulongx: no claimable step")
	ErrFindingNotOpen = errors.New("zhulongx: finding is not open")
	ErrEmptyText      = errors.New("zhulongx: text must not be empty")
)

const schemaV1 = `
CREATE TABLE IF NOT EXISTS goals (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    origin      TEXT NOT NULL,
    objective   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','stopped')),
    created_at  TEXT NOT NULL,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS facts (
    id         TEXT NOT NULL,
    goal_id    TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    source     TEXT NOT NULL,
    evidence   TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (goal_id, id)
);

CREATE TABLE IF NOT EXISTS steps (
    id          TEXT NOT NULL,
    goal_id     TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','done','failed','cancelled')),
    producer    TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    claimed_by  TEXT,
    claimed_at  TEXT,
    heartbeat_at TEXT,
    created_at  TEXT NOT NULL,
    finished_at TEXT,
    finding_id  TEXT,
    fact_id     TEXT,
    last_error  TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (goal_id, id)
);

CREATE TABLE IF NOT EXISTS step_deps (
    goal_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (goal_id, step_id, fact_id),
    FOREIGN KEY (goal_id, step_id) REFERENCES steps(goal_id, id) ON DELETE CASCADE,
    FOREIGN KEY (goal_id, fact_id) REFERENCES facts(goal_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS findings (
    id         TEXT NOT NULL,
    goal_id    TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    step_id    TEXT NOT NULL,
    content    TEXT NOT NULL,
    evidence   TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','promoted','discarded')),
    fact_id    TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    PRIMARY KEY (goal_id, id),
    FOREIGN KEY (goal_id, step_id) REFERENCES steps(goal_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hints (
    id         TEXT NOT NULL,
    goal_id    TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    creator    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (goal_id, id)
);

CREATE TABLE IF NOT EXISTS audit (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id TEXT NOT NULL,
    actor   TEXT NOT NULL,
    action  TEXT NOT NULL,
    entity  TEXT NOT NULL,
    detail  TEXT NOT NULL DEFAULT '',
    at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_goal ON audit(goal_id, seq);

CREATE TABLE IF NOT EXISTS counters (
    goal_id TEXT NOT NULL,
    kind    TEXT NOT NULL,
    value   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (goal_id, kind)
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
`

// Store wraps a SQLite database holding FGS state.
type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the database at path and applies the schema.
// A single writer connection avoids SQLITE_BUSY without external locking.
func Open(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)", strings.TrimPrefix(path, "file:"))
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %s: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaV1); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &Store{db: db}, nil
}

// OpenMemory opens an in-process database for tests.
func OpenMemory() (*Store, error) {
	db, err := sql.Open("sqlite", "file::memory:?_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaV1); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the underlying database.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

const timeLayout = time.RFC3339Nano

func nowUTC() string          { return time.Now().UTC().Format(timeLayout) }
func fmtT(t time.Time) string { return t.UTC().Format(timeLayout) }

func parseT(s string) time.Time {
	t, err := time.Parse(timeLayout, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

func nextID(tx *sql.Tx, goalID, kind, prefix string) (string, error) {
	if _, err := tx.Exec(`INSERT OR IGNORE INTO counters(goal_id, kind, value) VALUES (?, ?, 0)`, goalID, kind); err != nil {
		return "", err
	}
	if _, err := tx.Exec(`UPDATE counters SET value = value + 1 WHERE goal_id = ? AND kind = ?`, goalID, kind); err != nil {
		return "", err
	}
	var v int
	if err := tx.QueryRow(`SELECT value FROM counters WHERE goal_id = ? AND kind = ?`, goalID, kind).Scan(&v); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s%04d", prefix, v), nil
}

func audit(tx *sql.Tx, goalID, actor, action, entity, detail string) error {
	_, err := tx.Exec(
		`INSERT INTO audit(goal_id, actor, action, entity, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
		goalID, actor, action, entity, detail, nowUTC(),
	)
	return err
}

func nonEmpty(text, what string) error {
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("%w: %s", ErrEmptyText, what)
	}
	return nil
}
