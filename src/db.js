import Database from "better-sqlite3";
import path from "node:path";

const dbFile = path.join(process.cwd(), "data.sqlite");
export const db = new Database(dbFile);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    payment_status INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Backfill schema for existing databases created before payment_status existed.
try {
  db.exec("ALTER TABLE users ADD COLUMN payment_status INTEGER NOT NULL DEFAULT 0;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN name TEXT;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_submission_score INTEGER;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_submission_text TEXT;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_submission_sentiment TEXT;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_submission_is_on_topic INTEGER;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_submission_completed INTEGER NOT NULL DEFAULT 0;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_submission_submitted_at TEXT;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_score_relevance INTEGER;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_score_creativity INTEGER;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_score_clarity INTEGER;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_score_metaphor INTEGER;");
} catch {
  // ignore if column already exists
}
try {
  db.exec("ALTER TABLE users ADD COLUMN creative_score_impact INTEGER;");
} catch {
  // ignore if column already exists
}
db.exec(`
  CREATE TABLE IF NOT EXISTS email_otps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    otp TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    attempt_index INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
    score INTEGER NOT NULL DEFAULT 0,
    current_question_index INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, attempt_index)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS attempt_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    question_index INTEGER NOT NULL,
    answer_given TEXT NOT NULL,
    is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
    answered_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (attempt_id) REFERENCES quiz_attempts(id),
    UNIQUE(attempt_id, question_index)
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_id
  ON quiz_attempts(user_id);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_status
  ON quiz_attempts(user_id, status);
`);

