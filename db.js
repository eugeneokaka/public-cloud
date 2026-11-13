const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected database error', err);
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id              bigserial PRIMARY KEY,
      title           text NOT NULL,
      unit            text NOT NULL,
      semester        smallint NOT NULL CHECK (semester BETWEEN 1 AND 2),
      year            smallint NOT NULL,
      s3_key          text NOT NULL UNIQUE,
      original_name   text NOT NULL,
      content_type    text NOT NULL,
      file_size       bigint,
      status          text NOT NULL DEFAULT 'pending',
      uploaded_at     timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS notes_filter_idx
      ON notes (year, semester, status, uploaded_at DESC);

    CREATE INDEX IF NOT EXISTS notes_title_idx
      ON notes (lower(title));
  `);
}

module.exports = { pool, init };
