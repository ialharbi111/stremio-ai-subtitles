const path = require('path');
const fs = require('fs');

/**
 * تخزين بسيط بصيغة JSON بدل SQLite (better-sqlite3).
 * السبب: better-sqlite3 وحدة native تحتاج تجميع (compile) وقت التثبيت،
 * وهذا يفشل أحياناً على منصات الاستضافة المجانية مثل Render.
 * ملف JSON يعمل في أي مكان دون أي تجميع، وكافٍ تماماً لحجم بيانات هذه الإضافة.
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILES_DIR = path.join(__dirname, '..', 'cache_files');
const DB_FILE = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CACHE_FILES_DIR)) fs.mkdirSync(CACHE_FILES_DIR, { recursive: true });

function loadStore() {
  if (!fs.existsSync(DB_FILE)) {
    return { cache: {}, glossary: {}, seriesStyle: {} };
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      cache: parsed.cache || {},
      glossary: parsed.glossary || {},
      seriesStyle: parsed.seriesStyle || {},
    };
  } catch (err) {
    console.warn('تعذّرت قراءة ملف قاعدة البيانات، سيتم البدء من جديد:', err.message);
    return { cache: {}, glossary: {}, seriesStyle: {} };
  }
}

function saveStore(store) {
  // كتابة عبر ملف مؤقت ثم استبدال، لتفادي تلف الملف عند انقطاع مفاجئ
  const tmpFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

let store = loadStore();

function buildCacheKey({ imdbId, season, episode, videoHash }) {
  const s = season || '0';
  const e = episode || '0';
  const h = videoHash || 'nohash';
  return `${imdbId}:${s}:${e}:${h}`;
}

function getCachedTranslation({ imdbId, season, episode, videoHash }) {
  let entry = store.cache[buildCacheKey({ imdbId, season, episode, videoHash })];

  // إن لم نجد تطابقاً بالـ hash، نجرّب بدون hash كخطة بديلة
  if (!entry && videoHash) {
    entry = store.cache[buildCacheKey({ imdbId, season, episode, videoHash: null })];
  }

  if (!entry) return null;

  const filePath = path.join(CACHE_FILES_DIR, entry.fileName);
  if (!fs.existsSync(filePath)) return null;

  const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:7000').replace(/\/$/, '');
  return { fileUrl: `${baseUrl}/subtitles-files/${entry.fileName}` };
}

function saveCachedTranslation({ imdbId, season, episode, videoHash, arabicSrt }) {
  const key = buildCacheKey({ imdbId, season, episode, videoHash });
  const fileName = `${imdbId}_${season || '0'}_${episode || '0'}_${Date.now()}.srt`;
  const filePath = path.join(CACHE_FILES_DIR, fileName);

  fs.writeFileSync(filePath, arabicSrt, 'utf8');

  store.cache[key] = {
    imdbId,
    season: season || null,
    episode: episode || null,
    videoHash: videoHash || null,
    fileName,
    createdAt: Date.now(),
  };
  saveStore(store);

  const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:7000').replace(/\/$/, '');
  return { fileUrl: `${baseUrl}/subtitles-files/${fileName}` };
}

// ---- ذاكرة المصطلحات (Glossary) ----

function getGlossaryForSeries(imdbId, limit = 60) {
  const terms = store.glossary[imdbId] || {};
  return Object.entries(terms)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, limit)
    .map(([term_en, v]) => ({ term_en, term_ar: v.term_ar }));
}

function upsertGlossaryTerms(imdbId, terms) {
  if (!store.glossary[imdbId]) store.glossary[imdbId] = {};
  for (const t of terms) {
    if (!t.en || !t.ar) continue;
    store.glossary[imdbId][t.en.trim()] = {
      term_ar: t.ar.trim(),
      updatedAt: Date.now(),
    };
  }
  saveStore(store);
}

function getStyleNotes(imdbId) {
  return store.seriesStyle[imdbId] || null;
}

function setStyleNotes(imdbId, notes) {
  store.seriesStyle[imdbId] = notes;
  saveStore(store);
}

module.exports = {
  getCachedTranslation,
  saveCachedTranslation,
  getGlossaryForSeries,
  upsertGlossaryTerms,
  getStyleNotes,
  setStyleNotes,
};
