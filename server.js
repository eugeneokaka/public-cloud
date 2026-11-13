require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { pool, init } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.AWS_REGION;
const MAX_BYTES = 25 * 1024 * 1024;

if (!BUCKET || !REGION) {
  throw new Error('S3_BUCKET and AWS_REGION must be set');
}

const s3 = new S3Client({
  region: REGION,
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }
    : {}),
});

const ALLOWED_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
]);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function int(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function rateLimit({ windowMs, max }) {
  const buckets = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now - entry.start > windowMs) buckets.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || now - entry.start > windowMs) {
      buckets.set(key, { start: now, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many uploads, please wait a minute.' });
    }
    next();
  };
}

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 10 });

app.get(
  '/api/health',
  asyncHandler(async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  })
);

app.post(
  '/api/notes/presign',
  uploadLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const title = text(body.title, 200);
    const unit = text(body.unit, 120);
    const semester = int(body.semester, 1, 2);
    const year = int(body.year, 1, 6);
    const filename = text(body.filename, 255);
    const size = int(body.fileSize, 1, MAX_BYTES);

    if (!title) throw httpError(400, 'Title is required.');
    if (!unit) throw httpError(400, 'Unit is required.');
    if (!semester) throw httpError(400, 'Semester must be 1 or 2.');
    if (!year) throw httpError(400, 'Year of study must be between 1 and 6.');
    if (!filename) throw httpError(400, 'File name is required.');
    if (!size) throw httpError(400, `File size must be between 1 byte and ${MAX_BYTES / 1024 / 1024} MB.`);

    const ext = path.extname(filename).slice(1).toLowerCase();
    const contentType = ALLOWED_TYPES.get(ext);
    if (!contentType) {
      throw httpError(400, `Unsupported file type. Allowed: ${[...ALLOWED_TYPES.keys()].join(', ')}.`);
    }

    const safeName = path
      .basename(filename, path.extname(filename))
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'file';

    const id = crypto.randomUUID();
    const s3Key = `notes/${year}/semester-${semester}/${id}-${safeName}.${ext}`;

    const { rows } = await pool.query(
      `INSERT INTO notes (title, unit, semester, year, s3_key, original_name, content_type, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [title, unit, semester, year, s3Key, filename, contentType, size]
    );

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        ContentType: contentType,
        ContentLength: size,
      }),
      { expiresIn: 900 }
    );

    res.status(201).json({ id: rows[0].id, uploadUrl, contentType });
  })
);

app.post(
  '/api/notes/:id/confirm',
  asyncHandler(async (req, res) => {
    const id = int(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) throw httpError(400, 'Invalid note id.');

    const found = await pool.query('SELECT id, s3_key, content_type FROM notes WHERE id = $1', [id]);
    if (!found.rows.length) throw httpError(404, 'Note not found.');
    const note = found.rows[0];

    let head;
    try {
      head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: note.s3_key }));
    } catch {
      throw httpError(409, 'Upload was not found in storage. Try uploading again.');
    }

    const { rows } = await pool.query(
      `UPDATE notes
          SET status = 'uploaded',
              file_size = COALESCE($2, file_size),
              content_type = COALESCE($3, content_type),
              uploaded_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, title, unit, semester, year, original_name, file_size, uploaded_at`,
      [id, head.ContentLength ?? null, head.ContentType ?? null]
    );

    if (!rows.length) {
      // Already confirmed, return current state.
      const existing = await pool.query(
        `SELECT id, title, unit, semester, year, original_name, file_size, uploaded_at
           FROM notes WHERE id = $1`,
        [id]
      );
      return res.json(existing.rows[0]);
    }

    res.json(rows[0]);
  })
);

app.get(
  '/api/notes',
  asyncHandler(async (req, res) => {
    const clauses = ["status = 'uploaded'"];
    const values = [];

    const semester = req.query.semester ? int(req.query.semester, 1, 2) : null;
    if (req.query.semester && !semester) throw httpError(400, 'Invalid semester filter.');

    const year = req.query.year ? int(req.query.year, 1, 6) : null;
    if (req.query.year && !year) throw httpError(400, 'Invalid year filter.');

    const unit = text(req.query.unit, 120);
    const q = text(req.query.q, 120);

    if (semester) {
      values.push(semester);
      clauses.push(`semester = $${values.length}`);
    }
    if (year) {
      values.push(year);
      clauses.push(`year = $${values.length}`);
    }
    if (unit) {
      values.push(unit);
      clauses.push(`lower(unit) = lower($${values.length})`);
    }
    if (q) {
      values.push(`%${q}%`);
      clauses.push(`(title ILIKE $${values.length} OR unit ILIKE $${values.length})`);
    }

    const { rows } = await pool.query(
      `SELECT id, title, unit, semester, year, original_name, content_type, file_size, uploaded_at
         FROM notes
        WHERE ${clauses.join(' AND ')}
        ORDER BY uploaded_at DESC
        LIMIT 200`,
      values
    );

    res.json(rows);
  })
);

app.get(
  '/api/notes/:id/download',
  asyncHandler(async (req, res) => {
    const id = int(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) throw httpError(400, 'Invalid note id.');

    const { rows } = await pool.query(
      "SELECT s3_key, original_name FROM notes WHERE id = $1 AND status = 'uploaded'",
      [id]
    );
    if (!rows.length) throw httpError(404, 'Note not found.');

    const safeName = rows[0].original_name.replace(/["\r\n]/g, '');
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: rows[0].s3_key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
      }),
      { expiresIn: 300 }
    );

    res.redirect(302, url);
  })
);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
});

async function start() {
  await init();
  app.listen(PORT, () => {
    console.log(`Notes app listening on http://localhost:${PORT} (bucket: ${BUCKET}, region: ${REGION})`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
