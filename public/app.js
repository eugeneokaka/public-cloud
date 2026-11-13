const form = document.getElementById('upload-form');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const notesEl = document.getElementById('notes');
const filterQ = document.getElementById('filter-q');
const filterSemester = document.getElementById('filter-semester');
const filterYear = document.getElementById('filter-year');

let searchTimer = null;

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
}

function setProgress(fraction) {
  if (fraction == null) {
    progressWrap.hidden = true;
    progressBar.style.width = '0%';
    return;
  }
  progressWrap.hidden = false;
  progressBar.style.width = `${Math.round(fraction * 100)}%`;
}

async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function uploadToS3(url, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Storage rejected the upload (${xhr.status}). Check the bucket CORS policy.`));
    };
    xhr.onerror = () => reject(new Error('Network error while uploading to storage.'));
    xhr.send(file);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const file = form.elements.file.files[0];
  if (!file) return setStatus('Choose a document first.', 'error');

  submitBtn.disabled = true;
  setProgress(0);
  setStatus('Preparing upload...');

  try {
    const presign = await readJson(
      await fetch('/api/notes/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.elements.title.value,
          unit: form.elements.unit.value,
          semester: form.elements.semester.value,
          year: form.elements.year.value,
          filename: file.name,
          fileSize: file.size,
        }),
      })
    );

    setStatus('Uploading...');
    await uploadToS3(presign.uploadUrl, file, presign.contentType, setProgress);

    setProgress(1);
    setStatus('Saving...');
    await readJson(await fetch(`/api/notes/${presign.id}/confirm`, { method: 'POST' }));

    form.reset();
    setProgress(null);
    setStatus('Note uploaded.', 'ok');
    loadNotes();
  } catch (err) {
    setProgress(null);
    setStatus(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function formatBytes(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function renderNotes(notes) {
  if (!notes.length) {
    notesEl.innerHTML = '<p class="empty">No notes yet for this filter.</p>';
    return;
  }

  notesEl.innerHTML = notes
    .map(
      (note) => `
      <article class="note">
        <div class="note-main">
          <h3>${escapeHtml(note.title)}</h3>
          <p class="meta">
            <span class="pill">${escapeHtml(note.unit)}</span>
            <span class="pill" title="Year ${escapeHtml(note.year)}, Semester ${escapeHtml(note.semester)}">${escapeHtml(note.year)}.${escapeHtml(note.semester)}</span>
            <span>${formatBytes(note.file_size)}</span>
            <span>${formatDate(note.uploaded_at)}</span>
          </p>
          <p class="filename">${escapeHtml(note.original_name)}</p>
        </div>
        <a class="download" href="/api/notes/${note.id}/download">Download</a>
      </article>`
    )
    .join('');
}

async function loadNotes() {
  const params = new URLSearchParams();
  if (filterQ.value.trim()) params.set('q', filterQ.value.trim());
  if (filterSemester.value) params.set('semester', filterSemester.value);
  if (filterYear.value) params.set('year', filterYear.value);

  try {
    const notes = await readJson(await fetch(`/api/notes?${params}`));
    renderNotes(notes);
  } catch (err) {
    notesEl.innerHTML = `<p class="empty error">${escapeHtml(err.message)}</p>`;
  }
}

filterQ.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadNotes, 300);
});
filterSemester.addEventListener('change', loadNotes);
filterYear.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadNotes, 300);
});

loadNotes();
