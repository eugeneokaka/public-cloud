# Semester Notes

A small web app for the community to upload and share lecture notes by unit, year of study, and semester. Files are stored in a private Amazon S3 bucket; metadata lives in a Neon Postgres database. There is no login — anyone with the link can upload or download.

## How it works

```
Browser                     Express server                     S3
   |                              |                              |
   |-- POST /api/notes/presign -->|                              |
   |                              |-- INSERT notes (pending) --> DB
   |<-- { id, uploadUrl } --------|                              |
   |                                                             |
   |-- PUT file (presigned URL) -------------------------------->|
   |                                                             |
   |-- POST /api/notes/:id/confirm -->|                          |
   |                              |-- HeadObject -------------->|
   |                              |-- UPDATE status=uploaded --> DB
   |<-- note JSON ----------------|                              |
```

The server never handles file bytes. The browser uploads straight to S3 with a signed URL, so large files do not pass through the EC2 instance. The bucket stays private: listing is served from Postgres, and downloads are short-lived presigned `GET` URLs.

A row is inserted as `pending` before upload, then flipped to `uploaded` only after the object is confirmed to exist. This keeps half-finished uploads out of the list.

## Features

- No accounts or login.
- Accepted files: PDF, DOC, DOCX, PPT, PPTX, TXT, MD, up to 25 MB.
- Metadata: title, unit, year of study (1–6), semester (1–3). Displayed together as `1.1` (Year 1, Semester 1).
- Browse notes with search by title/unit and filters for year and semester.
- View PDF, TXT, Markdown and Office documents (Word/PowerPoint) in the browser, or download any file.
- Upload flow limited to 10 presign requests per minute per IP.

## Project structure

```
server.js            Express app: API, validation, S3 presigning
db.js                pg connection pool and table creation
public/              Static frontend (HTML, CSS, vanilla JS)
deploy/              systemd unit, nginx config, S3 CORS JSON
.env.example         Environment variable template
```

## Data model

One table, created automatically on startup:

```sql
CREATE TABLE notes (
  id              bigserial PRIMARY KEY,
  title           text NOT NULL,
  unit            text NOT NULL,
  semester        smallint NOT NULL,              -- 1 to 3
  year            smallint NOT NULL,              -- year of study, e.g. 1
  s3_key          text NOT NULL UNIQUE,
  original_name   text NOT NULL,
  content_type    text NOT NULL,
  file_size       bigint,
  status          text NOT NULL DEFAULT 'pending',
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);
```

S3 object keys look like `notes/{year}/semester-{semester}/{uuid}-{filename}`.

## API

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/health` | Checks the database connection. |
| `POST` | `/api/notes/presign` | Validates metadata, inserts a `pending` row, returns `{ id, uploadUrl, contentType }`. URL expires in 15 minutes. |
| `POST` | `/api/notes/:id/confirm` | Verifies the object exists in S3, marks the row `uploaded`, returns the note. `409` if the upload is missing. |
| `GET` | `/api/notes` | Lists uploaded notes. Optional query params: `q`, `unit`, `semester`, `year`. Limit 200, newest first. |
| `GET` | `/api/notes/:id/view` | `302` redirect to an inline presigned URL for PDF/TXT/Markdown, or to the Microsoft Office viewer for Word/PowerPoint files. |
| `GET` | `/api/notes/:id/download` | `302` redirect to a presigned GET URL valid for 5 minutes. |

Presign request body:

```json
{
  "title": "Introduction to Cloud Computing",
  "unit": "CSC 3102",
  "semester": 1,
  "year": 2,
  "filename": "notes.pdf",
  "fileSize": 1048576
}
```

Example note returned by the list:

```json
{
  "id": "3",
  "title": "Introduction to Cloud Computing",
  "unit": "CSC 3102",
  "semester": 1,
  "year": 2,
  "original_name": "notes.pdf",
  "content_type": "application/pdf",
  "file_size": "1048576",
  "uploaded_at": "2026-11-13T07:07:01.514Z"
}
```

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env     # then fill in the values
npm start                # http://localhost:3000
```

`npm run dev` starts with auto-reload via `node --watch`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Neon Postgres connection string, including `sslmode=require`. |
| `AWS_REGION` | yes | Bucket region, e.g. `eu-north-1`. |
| `S3_BUCKET` | yes | Bucket name, e.g. `cloudprojectofornotes`. |
| `PORT` | no | Defaults to `3000`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | no | Only for local development. On EC2, omit these and attach an IAM instance role instead. |

## S3 setup

The bucket must remain private (Block Public Access on). The browser needs a CORS policy that allows direct `PUT` uploads. Paste `deploy/s3-cors.json` into S3 → Permissions → Cross-origin resource sharing:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

The app's IAM identity needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::cloudprojectofornotes"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::cloudprojectofornotes/*"
    }
  ]
}
```

`s3:GetObject` also covers the `HeadObject` call used during confirmation.

## Deploy on Ubuntu EC2

1. Launch an Ubuntu 22.04/24.04 instance and allow inbound ports 22 and 80. Provide S3 access through an IAM instance role.
2. Push this repo to GitHub (never commit `.env`).
3. On the instance, install Node.js 22, clone the repo to `/opt/notes`, and run `npm ci --omit=dev`.
4. Create `/opt/notes/.env` with the variables above (`chmod 600`).
5. Start it:

```bash
cd /opt/notes
nohup npm start > app.log 2>&1 &
```

A terminal-started process dies with the SSH session and does not restart after a reboot. For a durable setup, use `deploy/notes.service` with systemd and proxy through `deploy/nginx.conf` so port 3000 is never exposed.

Redeploy after pushing changes:

```bash
cd /opt/notes
git pull --ff-only
npm ci --omit=dev
sudo systemctl restart semester-notes
```

## Known limitations

- Office previews go through Microsoft's online viewer, which needs outbound access to the presigned file URL (15-minute link); it is a third-party service and has file-size limits.
- No authentication: anyone who can reach the site can upload. Rate limiting is per IP and in-memory only.
- No edit or delete UI, and no admin moderation.
- Failed or abandoned uploads leave `pending` rows and orphaned objects; no cleanup job yet.
- No pagination beyond the 200-note list limit.
- `uploaded_at` reflects confirmation time, not the original file timestamp.
