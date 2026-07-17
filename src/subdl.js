const axios = require('axios');
const JSZip = require('jszip');

/**
 * مصدر ترجمة بديل/أساسي عبر SubDL.
 * ملاحظة: SubDL لا يدعم المطابقة عبر moviehash مثل OpenSubtitles،
 * لذلك هذا المصدر يبحث فقط عبر IMDB ID + الموسم/الحلقة.
 * لضمان أفضل تطابق ممكن للتوقيت، الأولوية تبقى لـ OpenSubtitles عند توفر hash.
 */

const SUBDL_API_BASE = 'https://api.subdl.com/api/v1';
const SUBDL_DOWNLOAD_BASE = 'https://dl.subdl.com';

async function searchSubtitles({ imdbId, season, episode }) {
  if (!process.env.SUBDL_API_KEY) return null;

  const params = {
    api_key: process.env.SUBDL_API_KEY,
    imdb_id: imdbId,
    languages: 'EN',
    type: season ? 'tv' : 'movie',
  };
  if (season) params.season_number = season;
  if (episode) params.episode_number = episode;

  const res = await axios.get(`${SUBDL_API_BASE}/subtitles`, { params });

  if (!res.data.status || !Array.isArray(res.data.subtitles) || res.data.subtitles.length === 0) {
    return null;
  }

  const subs = res.data.subtitles;
  // نفضّل ملف حلقة مفردة على حزمة موسم كاملة (full_season) لضمان دقة أعلى
  const singleEpisode = subs.find((s) => !s.full_season);
  return singleEpisode || subs[0];
}

async function downloadAndExtractSrt(subtitleEntry) {
  const url = subtitleEntry.url.startsWith('http')
    ? subtitleEntry.url
    : `${SUBDL_DOWNLOAD_BASE}${subtitleEntry.url}`;

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  const buffer = Buffer.from(res.data);

  // معظم ملفات SubDL تُرجع كأرشيف zip، نفكه ونطلع أول ملف srt بداخله
  if (url.toLowerCase().endsWith('.zip')) {
    const zip = await JSZip.loadAsync(buffer);
    const srtFileName = Object.keys(zip.files).find((name) => name.toLowerCase().endsWith('.srt'));
    if (!srtFileName) {
      throw new Error('لا يوجد ملف srt داخل الأرشيف المضغوط من SubDL');
    }
    return zip.files[srtFileName].async('string');
  }

  // ملف srt مباشر (raw) بدون ضغط
  return buffer.toString('utf8');
}

async function getEnglishSubtitle({ imdbId, season, episode }) {
  const best = await searchSubtitles({ imdbId, season, episode });
  if (!best) return null;
  return downloadAndExtractSrt(best);
}

module.exports = { getEnglishSubtitle };
