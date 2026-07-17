const axios = require('axios');

const OS_BASE = 'https://api.opensubtitles.com/api/v1';

let cachedToken = null;

function getHeaders(token) {
  const headers = {
    'Api-Key': process.env.OPENSUBTITLES_API_KEY,
    'Content-Type': 'application/json',
    'User-Agent': 'stremio-ai-arabic-subtitles v1.0.0',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// تسجيل الدخول اختياري (يرفع الحد اليومي للتحميل من OpenSubtitles)
async function loginIfNeeded() {
  if (cachedToken) return cachedToken;
  if (!process.env.OPENSUBTITLES_USERNAME || !process.env.OPENSUBTITLES_PASSWORD) {
    return null;
  }
  try {
    const res = await axios.post(
      `${OS_BASE}/login`,
      {
        username: process.env.OPENSUBTITLES_USERNAME,
        password: process.env.OPENSUBTITLES_PASSWORD,
      },
      { headers: getHeaders() }
    );
    cachedToken = res.data.token;
    return cachedToken;
  } catch (err) {
    console.warn('OpenSubtitles login failed, continuing anonymously:', err.message);
    return null;
  }
}

/**
 * يبحث أولاً بمطابقة الـ moviehash (الأدق لضمان توافق التوقيت مع النسخة المشغلة)،
 * وإن لم يجد نتيجة يرجع لمطابقة عادية عبر IMDB ID.
 */
async function searchSubtitles({ imdbId, season, episode, videoHash }) {
  const token = await loginIfNeeded();
  const cleanImdb = imdbId.replace('tt', '');

  const baseParams = {
    languages: 'en',
    imdb_id: cleanImdb,
  };
  if (season) baseParams.season_number = season;
  if (episode) baseParams.episode_number = episode;

  // 1) محاولة المطابقة بالـ hash أولاً (الأكثر دقة لتوافق التوقيت)
  if (videoHash) {
    try {
      const res = await axios.get(`${OS_BASE}/subtitles`, {
        headers: getHeaders(token),
        params: { ...baseParams, moviehash: videoHash },
      });
      const hashMatches = (res.data.data || []).filter(
        (item) => item.attributes && item.attributes.moviehash_match === true
      );
      if (hashMatches.length > 0) {
        return sortByBestMatch(hashMatches)[0];
      }
    } catch (err) {
      console.warn('Hash-based search failed:', err.message);
    }
  }

  // 2) fallback: مطابقة عادية عبر IMDB ID فقط
  try {
    const res = await axios.get(`${OS_BASE}/subtitles`, {
      headers: getHeaders(token),
      params: baseParams,
    });
    const results = res.data.data || [];
    if (results.length === 0) return null;
    return sortByBestMatch(results)[0];
  } catch (err) {
    console.error('OpenSubtitles search failed:', err.message);
    return null;
  }
}

function sortByBestMatch(items) {
  // نفضّل: أعلى تقييم (ratings) ثم أعلى عدد تحميلات (download_count)
  return [...items].sort((a, b) => {
    const ra = a.attributes.ratings || 0;
    const rb = b.attributes.ratings || 0;
    if (rb !== ra) return rb - ra;
    return (b.attributes.download_count || 0) - (a.attributes.download_count || 0);
  });
}

async function downloadSubtitleContent(subtitleItem) {
  const token = await loginIfNeeded();
  const fileId = subtitleItem.attributes.files[0].file_id;

  const downloadRes = await axios.post(
    `${OS_BASE}/download`,
    { file_id: fileId },
    { headers: getHeaders(token) }
  );

  const fileUrl = downloadRes.data.link;
  const fileRes = await axios.get(fileUrl, { responseType: 'text' });
  return fileRes.data;
}

async function getEnglishSubtitle({ imdbId, season, episode, videoHash }) {
  const best = await searchSubtitles({ imdbId, season, episode, videoHash });
  if (!best) return null;
  const content = await downloadSubtitleContent(best);
  return content;
}

module.exports = { getEnglishSubtitle, searchSubtitles, downloadSubtitleContent };
