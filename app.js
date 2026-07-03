const DB_NAME = 'rapid-vocab-db';
const DB_VERSION = 1;
const STORE = 'words';
const SETTINGS_KEY = 'rapid-vocab-settings';
const TODAY_KEY = 'rapid-vocab-today';

let db;
let pendingImportRows = [];
let reviewQueue = [];
let currentIndex = 0;
let currentCard = null;
let sessionStats = { again: 0, hard: 0, good: 0, easy: 0, total: 0, introduced: 0 };
let deferredInstallPrompt = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const views = {
  home: $('#homeView'),
  review: $('#reviewView'),
  upload: $('#uploadView'),
  wordlist: $('#wordlistView'),
};

const defaultSettings = {
  dailyNewTarget: 360,
  createdAt: new Date().toISOString(),
};

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeWord(word) {
  return String(word || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function makeId(word) {
  return normalizeWord(word)
    .replace(/[^a-z0-9\u0980-\u09FF]+/gi, '-')
    .replace(/^-+|-+$/g, '') || crypto.randomUUID();
}

function getSettings() {
  try {
    return { ...defaultSettings, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...getSettings(), ...settings }));
}

function getTodayStats() {
  const blank = { date: todayString(), reviewed: 0, introduced: 0 };
  try {
    const stored = JSON.parse(localStorage.getItem(TODAY_KEY));
    if (!stored || stored.date !== todayString()) return blank;
    return { ...blank, ...stored };
  } catch {
    return blank;
  }
}

function saveTodayStats(patch) {
  const stats = { ...getTodayStats(), ...patch };
  localStorage.setItem(TODAY_KEY, JSON.stringify(stats));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('word', 'word', { unique: false });
        store.createIndex('normalizedWord', 'normalizedWord', { unique: true });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('dueAt', 'dueAt', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(mode = 'readonly') {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function getAllWords() {
  return new Promise((resolve, reject) => {
    const request = tx().getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function getWordByNormalized(normalizedWord) {
  return new Promise((resolve, reject) => {
    const request = tx().index('normalizedWord').get(normalizedWord);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function putWord(word) {
  return new Promise((resolve, reject) => {
    const request = tx('readwrite').put(word);
    request.onsuccess = () => resolve(word);
    request.onerror = () => reject(request.error);
  });
}

function deleteWord(id) {
  return new Promise((resolve, reject) => {
    const request = tx('readwrite').delete(id);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

function bulkPut(words) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    words.forEach((word) => store.put(word));
    transaction.oncomplete = () => resolve(words.length);
    transaction.onerror = () => reject(transaction.error);
  });
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(field.trim());
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(field.trim());
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  row.push(field.trim());
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function headerKey(header) {
  return String(header || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function getColumnMap(headers) {
  const map = {};
  headers.forEach((header, index) => {
    const key = headerKey(header);
    if (['word', 'term', 'vocab', 'vocabulary'].includes(key)) map.word = index;
    if (['englishmeaning', 'english', 'engmeaning', 'meaning', 'definition'].includes(key)) map.englishMeaning = index;
    if (['banglameaning', 'bengalimeaning', 'bangla', 'bengali', 'bnmeaning'].includes(key)) map.banglaMeaning = index;
    if (['sentence', 'sentences', 'example', 'examples', 'examplesentence'].includes(key)) map.sentence = index;
  });
  return map;
}

function csvRowsToWords(rows) {
  if (!rows.length) return { words: [], error: 'The CSV file is empty.' };
  const map = getColumnMap(rows[0]);
  const required = ['word', 'englishMeaning', 'banglaMeaning', 'sentence'];
  const missing = required.filter((key) => map[key] === undefined);
  if (missing.length) {
    return {
      words: [],
      error: `Missing required column(s): ${missing.join(', ')}. Use word, englishMeaning, banglaMeaning, sentence.`,
    };
  }

  const now = new Date().toISOString();
  const words = rows.slice(1)
    .map((row) => {
      const word = row[map.word]?.trim();
      if (!word) return null;
      const normalizedWord = normalizeWord(word);
      return {
        id: makeId(word),
        word,
        normalizedWord,
        englishMeaning: row[map.englishMeaning]?.trim() || '',
        banglaMeaning: row[map.banglaMeaning]?.trim() || '',
        sentence: row[map.sentence]?.trim() || '',
        status: 'new',
        createdAt: now,
        dueAt: null,
        lastReviewedAt: null,
        intervalDays: 0,
        repetitions: 0,
        lapses: 0,
        hardCount: 0,
        easyCount: 0,
        reviewCount: 0,
        mastered: false,
      };
    })
    .filter(Boolean);

  const deduped = [];
  const seen = new Set();
  for (const word of words) {
    if (!seen.has(word.normalizedWord)) {
      deduped.push(word);
      seen.add(word.normalizedWord);
    }
  }

  return { words: deduped, error: null };
}

function formatDateTime(value) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not scheduled';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function isDue(word) {
  if (word.status === 'new') return false;
  if (!word.dueAt) return false;
  return new Date(word.dueAt).getTime() <= Date.now();
}

function getLevel(word) {
  if (word.status === 'new') return 'New';
  if (word.mastered) return 'Mastered';
  if ((word.lapses || 0) >= 2 || (word.hardCount || 0) >= 3) return 'Weak';
  if ((word.intervalDays || 0) >= 8) return 'Strong';
  if ((word.intervalDays || 0) >= 2) return 'Familiar';
  return 'Learning';
}

function scheduleWord(word, rating) {
  const now = new Date();
  const previousInterval = Number(word.intervalDays || 0);
  let nextInterval = previousInterval;
  let status = 'learning';

  if (rating === 'again') {
    nextInterval = 0;
    status = 'learning';
    word.lapses = (word.lapses || 0) + 1;
    word.repetitions = 0;
  } else if (rating === 'hard') {
    nextInterval = 1;
    status = 'learning';
    word.hardCount = (word.hardCount || 0) + 1;
    word.repetitions = (word.repetitions || 0) + 1;
  } else if (rating === 'good') {
    nextInterval = previousInterval < 1 ? 2 : Math.ceil(previousInterval * 2);
    status = nextInterval >= 8 ? 'strong' : 'learning';
    word.repetitions = (word.repetitions || 0) + 1;
  } else if (rating === 'easy') {
    nextInterval = previousInterval < 1 ? 4 : Math.ceil(previousInterval * 3);
    status = nextInterval >= 8 ? 'strong' : 'learning';
    word.easyCount = (word.easyCount || 0) + 1;
    word.repetitions = (word.repetitions || 0) + 1;
  }

  if (nextInterval >= 14 && (word.repetitions || 0) >= 3) {
    word.mastered = true;
    status = 'mastered';
  }

  const dueAt = new Date(now);
  if (rating === 'again') {
    dueAt.setMinutes(dueAt.getMinutes() + 5);
  } else {
    dueAt.setDate(dueAt.getDate() + nextInterval);
    dueAt.setHours(5, 0, 0, 0);
  }

  word.status = status;
  word.intervalDays = nextInterval;
  word.dueAt = dueAt.toISOString();
  word.lastReviewedAt = now.toISOString();
  word.reviewCount = (word.reviewCount || 0) + 1;
  return word;
}

async function getDashboardStats() {
  const words = await getAllWords();
  const today = getTodayStats();
  const due = words.filter(isDue).length;
  const fresh = words.filter((w) => w.status === 'new').length;
  const mastered = words.filter((w) => w.mastered || w.status === 'mastered').length;
  const weak = words.filter((w) => getLevel(w) === 'Weak').length;
  return { total: words.length, due, fresh, mastered, weak, reviewedToday: today.reviewed };
}

async function renderHome() {
  const stats = await getDashboardStats();
  const settings = getSettings();
  $('#dailyTargetInput').value = settings.dailyNewTarget;

  const items = [
    ['Total words', stats.total],
    ['Due reviews', stats.due],
    ['New queue', stats.fresh],
    ['Reviewed today', stats.reviewedToday],
    ['Weak words', stats.weak],
    ['Mastered', stats.mastered],
  ];

  const grid = $('#statsGrid');
  grid.innerHTML = '';
  const template = $('#statTemplate');
  items.forEach(([label, value]) => {
    const node = template.content.cloneNode(true);
    node.querySelector('.stat-label').textContent = label;
    node.querySelector('.stat-value').textContent = value;
    grid.appendChild(node);
  });
}

async function buildReviewQueue() {
  const settings = getSettings();
  const words = await getAllWords();
  const dueWords = words
    .filter(isDue)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

  const newWords = words
    .filter((w) => w.status === 'new')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, Number(settings.dailyNewTarget || 360));

  reviewQueue = [...dueWords, ...newWords];
  currentIndex = 0;
  currentCard = null;
  sessionStats = { again: 0, hard: 0, good: 0, easy: 0, total: reviewQueue.length, introduced: newWords.length };
}

function renderCurrentCard() {
  $('#sessionDone').classList.add('hidden');
  $('#reviewCard').classList.remove('hidden');

  if (!reviewQueue.length || currentIndex >= reviewQueue.length) {
    finishSession();
    return;
  }

  currentCard = reviewQueue[currentIndex];
  $('#reviewProgress').textContent = `${currentIndex + 1} / ${reviewQueue.length}`;
  $('#reviewLabel').textContent = getLevel(currentCard);
  $('#questionWord').textContent = currentCard.word;
  $('#englishMeaning').textContent = currentCard.englishMeaning || '—';
  $('#banglaMeaning').textContent = currentCard.banglaMeaning || '—';
  $('#sentenceText').textContent = currentCard.sentence || '—';
  $('#answerBlock').classList.add('hidden');
  $('#ratingBar').classList.add('hidden');
  $('#showAnswerBtn').classList.remove('hidden');
}

function finishSession() {
  $('#reviewProgress').textContent = 'Done';
  $('#reviewCard').classList.add('hidden');
  const panel = $('#sessionDone');
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <h2>Session complete</h2>
    <p class="muted">Reviewed ${sessionStats.again + sessionStats.hard + sessionStats.good + sessionStats.easy} cards. Introduced ${sessionStats.introduced} new words.</p>
    <div class="stats-grid">
      <div class="stat-card"><span class="stat-label">Again</span><strong class="stat-value">${sessionStats.again}</strong></div>
      <div class="stat-card"><span class="stat-label">Hard</span><strong class="stat-value">${sessionStats.hard}</strong></div>
      <div class="stat-card"><span class="stat-label">Good</span><strong class="stat-value">${sessionStats.good}</strong></div>
      <div class="stat-card"><span class="stat-label">Easy</span><strong class="stat-value">${sessionStats.easy}</strong></div>
    </div>
    <button class="primary big" type="button" data-nav="home">Back to Home</button>
  `;
  panel.querySelector('[data-nav="home"]').addEventListener('click', () => navigate('home'));
}

async function startReview() {
  await buildReviewQueue();
  navigate('review', { skipBuild: true });
  if (!reviewQueue.length) {
    $('#reviewProgress').textContent = '0 / 0';
    $('#reviewCard').classList.add('hidden');
    const panel = $('#sessionDone');
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <h2>No cards ready</h2>
      <p class="muted">Upload a CSV file or wait until your scheduled reviews are due.</p>
      <button class="primary big" type="button" data-nav="upload">Upload Words</button>
    `;
    panel.querySelector('[data-nav="upload"]').addEventListener('click', () => navigate('upload'));
    return;
  }
  renderCurrentCard();
}

async function rateCurrentCard(rating) {
  if (!currentCard) return;
  const wasNew = currentCard.status === 'new';
  const updated = scheduleWord({ ...currentCard }, rating);
  await putWord(updated);

  sessionStats[rating] += 1;
  const today = getTodayStats();
  saveTodayStats({
    reviewed: today.reviewed + 1,
    introduced: today.introduced + (wasNew ? 1 : 0),
  });

  if (rating === 'again') {
    reviewQueue.push(updated);
  }

  currentIndex += 1;
  renderCurrentCard();
}

function showAnswer() {
  if (!currentCard) return;
  $('#answerBlock').classList.remove('hidden');
  $('#ratingBar').classList.remove('hidden');
  $('#showAnswerBtn').classList.add('hidden');
}

async function handleCSVUpload(file) {
  if (!file) return;
  const status = $('#uploadStatus');
  status.textContent = 'Reading file...';
  const text = await file.text();
  const rows = parseCSV(text.replace(/^\uFEFF/, ''));
  const parsed = csvRowsToWords(rows);

  if (parsed.error) {
    pendingImportRows = [];
    $('#previewPanel').classList.add('hidden');
    status.textContent = parsed.error;
    return;
  }

  pendingImportRows = parsed.words;
  status.textContent = `${pendingImportRows.length} valid words found.`;
  renderPreview(pendingImportRows);
}

function renderPreview(words) {
  const previewPanel = $('#previewPanel');
  const previewList = $('#previewList');
  previewPanel.classList.remove('hidden');
  $('#previewSummary').textContent = `${words.length} words ready. Existing words will be skipped.`;
  previewList.innerHTML = '';

  words.slice(0, 8).forEach((word) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    item.innerHTML = `
      <strong>${escapeHTML(word.word)}</strong>
      <p>${escapeHTML(word.englishMeaning)}</p>
      <p class="bangla">${escapeHTML(word.banglaMeaning)}</p>
    `;
    previewList.appendChild(item);
  });

  if (words.length > 8) {
    const item = document.createElement('div');
    item.className = 'preview-item muted';
    item.textContent = `+${words.length - 8} more words`;
    previewList.appendChild(item);
  }
}

async function importPendingWords() {
  if (!pendingImportRows.length) return;
  $('#importBtn').disabled = true;
  $('#importBtn').textContent = 'Importing...';

  const toInsert = [];
  let skipped = 0;

  for (const word of pendingImportRows) {
    const existing = await getWordByNormalized(word.normalizedWord);
    if (existing) {
      skipped += 1;
      continue;
    }
    toInsert.push(word);
  }

  await bulkPut(toInsert);
  $('#uploadStatus').textContent = `Imported ${toInsert.length} words. Skipped ${skipped} duplicate(s).`;
  $('#previewPanel').classList.add('hidden');
  $('#csvFileInput').value = '';
  pendingImportRows = [];
  $('#importBtn').disabled = false;
  $('#importBtn').textContent = 'Import Words';
  await renderHome();
}

function escapeHTML(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function renderWordList() {
  const query = normalizeWord($('#wordSearchInput').value);
  const filter = $('#wordFilterSelect').value;
  const words = await getAllWords();

  let filtered = words;
  if (query) {
    filtered = filtered.filter((word) => normalizeWord(`${word.word} ${word.englishMeaning} ${word.banglaMeaning} ${word.sentence}`).includes(query));
  }
  if (filter === 'new') filtered = filtered.filter((word) => word.status === 'new');
  if (filter === 'due') filtered = filtered.filter(isDue);
  if (filter === 'hard') filtered = filtered.filter((word) => getLevel(word) === 'Weak');
  if (filter === 'mastered') filtered = filtered.filter((word) => word.mastered || word.status === 'mastered');

  filtered.sort((a, b) => a.word.localeCompare(b.word));

  const list = $('#wordList');
  list.innerHTML = '';

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No words found.</div>';
    return;
  }

  filtered.forEach((word) => {
    const item = document.createElement('article');
    item.className = 'word-item';
    item.innerHTML = `
      <strong>${escapeHTML(word.word)}</strong>
      <p>${escapeHTML(word.englishMeaning)}</p>
      <p class="bangla">${escapeHTML(word.banglaMeaning)}</p>
      <p>${escapeHTML(word.sentence)}</p>
      <div class="word-meta">
        <span>${getLevel(word)}</span>
        <span>Reviews: ${word.reviewCount || 0}</span>
        <span>Next: ${formatDateTime(word.dueAt)}</span>
      </div>
      <div class="backup-actions" style="margin-top:12px">
        <button class="ghost" type="button" data-delete-id="${escapeHTML(word.id)}">Delete</button>
      </div>
    `;
    list.appendChild(item);
  });

  $$('[data-delete-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-delete-id');
      const confirmed = confirm('Delete this word from local storage?');
      if (!confirmed) return;
      await deleteWord(id);
      await renderWordList();
      await renderHome();
    });
  });
}

async function exportBackup() {
  const words = await getAllWords();
  const payload = {
    app: 'Rapid Vocab',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: getSettings(),
    words,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `rapid-vocab-backup-${todayString()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importBackup(file) {
  if (!file) return;
  const status = $('#uploadStatus');
  try {
    const payload = JSON.parse(await file.text());
    if (!Array.isArray(payload.words)) throw new Error('Backup file does not contain a words array.');

    const words = payload.words
      .filter((word) => word.word)
      .map((word) => ({
        ...word,
        id: word.id || makeId(word.word),
        normalizedWord: word.normalizedWord || normalizeWord(word.word),
      }));

    await bulkPut(words);
    if (payload.settings) saveSettings(payload.settings);
    status.textContent = `Backup imported. Restored ${words.length} words.`;
    await renderHome();
  } catch (error) {
    status.textContent = `Could not import backup: ${error.message}`;
  }
}

async function navigate(target, options = {}) {
  if (!views[target]) return;
  Object.entries(views).forEach(([name, view]) => view.classList.toggle('active', name === target));
  $$('.bottom-nav button').forEach((button) => button.classList.toggle('active', button.dataset.nav === target));

  if (target === 'home') await renderHome();
  if (target === 'review' && !options.skipBuild) await startReview();
  if (target === 'wordlist') await renderWordList();
}

function setupEvents() {
  $$('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.nav));
  });

  $('#startReviewBtn').addEventListener('click', startReview);
  $('#showAnswerBtn').addEventListener('click', showAnswer);

  $$('.rate').forEach((button) => {
    button.addEventListener('click', () => rateCurrentCard(button.dataset.rating));
  });

  $('#dailyTargetInput').addEventListener('change', async (event) => {
    const value = Math.max(1, Math.min(1000, Number(event.target.value || 360)));
    saveSettings({ dailyNewTarget: value });
    await renderHome();
  });

  $('#csvFileInput').addEventListener('change', (event) => handleCSVUpload(event.target.files[0]));
  $('#importBtn').addEventListener('click', importPendingWords);
  $('#wordSearchInput').addEventListener('input', renderWordList);
  $('#wordFilterSelect').addEventListener('change', renderWordList);
  $('#exportJsonBtn').addEventListener('click', exportBackup);
  $('#jsonImportInput').addEventListener('change', (event) => importBackup(event.target.files[0]));

  window.addEventListener('keydown', (event) => {
    if (!views.review.classList.contains('active')) return;
    if (event.target.matches('input, textarea, select')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (!$('#showAnswerBtn').classList.contains('hidden')) showAnswer();
    }
    if (!$('#ratingBar').classList.contains('hidden')) {
      const map = { Digit1: 'again', Digit2: 'hard', Digit3: 'good', Digit4: 'easy' };
      if (map[event.code]) rateCurrentCard(map[event.code]);
    }
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $('#installBtn').classList.remove('hidden');
  });

  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('#installBtn').classList.add('hidden');
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./service-worker.js');
  } catch (error) {
    console.warn('Service worker registration failed:', error);
  }
}

async function init() {
  db = await openDb();
  setupEvents();
  await registerServiceWorker();
  await renderHome();
}

init().catch((error) => {
  document.body.innerHTML = `<main style="padding:24px;color:white;font-family:sans-serif"><h1>Could not start Rapid Vocab</h1><p>${escapeHTML(error.message)}</p></main>`;
});
