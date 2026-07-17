require('dotenv').config();
const path = require('path');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const { getEnglishSubtitle: getFromSubDL } = require('./src/subdl');
const { getEnglishSubtitle: getFromOpenSubtitles } = require('./src/opensubtitles');
const { translateSrt } = require('./src/translator');
const { getCachedTranslation, saveCachedTranslation } = require('./src/db');

if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes('ضع_مفتاح')) {
  console.error('❌ خطأ: يجب وضع GEMINI_API_KEY في ملف .env قبل التشغيل');
  process.exit(1);
}
if (
  (!process.env.OPENSUBTITLES_API_KEY || process.env.OPENSUBTITLES_API_KEY.includes('ضع_مفتاح')) &&
  !process.env.SUBDL_API_KEY
) {
  console.error('❌ خطأ: يجب وضع SUBDL_API_KEY أو OPENSUBTITLES_API_KEY (أو كليهما) في ملف .env قبل التشغيل');
  process.exit(1);
}

/**
 * يجرّب SubDL أولاً (أبسط وغالباً أسرع)، وإن لم يجد نتيجة أو فشل
 * يرجع تلقائياً إلى OpenSubtitles (الذي يدعم مطابقة hash للتوقيت الدقيق).
 */
async function getEnglishSubtitle(args) {
  try {
    const fromSubDL = await getFromSubDL(args);
    if (fromSubDL) {
      console.log('✅ تم العثور على الترجمة عبر SubDL');
      return fromSubDL;
    }
    console.log('ℹ️ لا توجد نتيجة من SubDL، الانتقال إلى OpenSubtitles...');
  } catch (err) {
    console.warn('⚠️ فشل SubDL، الانتقال إلى OpenSubtitles:', err.message);
  }

  try {
    const fromOS = await getFromOpenSubtitles(args);
    if (fromOS) console.log('✅ تم العثور على الترجمة عبر OpenSubtitles');
    return fromOS;
  } catch (err) {
    console.error('❌ فشل OpenSubtitles أيضاً:', err.message);
    return null;
  }
}

const manifest = {
  id: 'org.stremio.ai-arabic-subtitles',
  version: '1.0.0',
  name: 'ترجمة عربية بالذكاء الاصطناعي (Gemini)',
  description:
    'تجلب الترجمة الإنجليزية المتوافقة مع نسخة الفيديو المشغّلة (عبر hash) وتترجمها فوراً إلى العربية الفصحى باستخدام Gemini، مع الحفاظ التام على التوقيت وذاكرة مصطلحات لكل مسلسل لضمان اتساق الترجمة بين الحلقات.',
  logo: 'https://i.imgur.com/8Z8Z8Z8.png',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    configurable: false,
  },
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async (args) => {
  const { id, extra } = args;
  console.log('📥 طلب ترجمة:', id, extra);

  const parts = id.split(':');
  const imdbId = parts[0];
  const season = parts[1] || null;
  const episode = parts[2] || null;

  const videoHash = extra && extra.videoHash ? extra.videoHash : null;
  const videoSize = extra && extra.videoSize ? extra.videoSize : null;

  try {
    // 1) التحقق من الكاش أولاً - يظهر فوراً إن وُجد
    const cached = getCachedTranslation({ imdbId, season, episode, videoHash });
    if (cached) {
      console.log('⚡ الترجمة موجودة في الكاش، يتم الإرجاع الفوري');
      return {
        subtitles: [
          {
            id: `ai-ar-${imdbId}-${season || 0}-${episode || 0}`,
            lang: 'ara',
            url: cached.fileUrl,
          },
        ],
      };
    }

    // 2) جلب الترجمة الإنجليزية المتوافقة (hash أولاً، ثم fallback)
    console.log('🔎 جاري البحث عن ترجمة إنجليزية متوافقة...');
    const englishSrt = await getEnglishSubtitle({ imdbId, season, episode, videoHash, videoSize });

    if (!englishSrt) {
      console.log('⚠️ لم يتم العثور على ترجمة إنجليزية مناسبة');
      return { subtitles: [] };
    }

    // 3) الترجمة عبر Gemini مع الحفاظ على التوقيت والاتساق
    console.log('🤖 جاري الترجمة عبر Gemini...');
    const startTime = Date.now();
    const arabicSrt = await translateSrt({ srtContent: englishSrt, imdbId, season });
    console.log(`✅ اكتملت الترجمة خلال ${(Date.now() - startTime) / 1000} ثانية`);

    // 4) حفظ في الكاش
    const record = saveCachedTranslation({ imdbId, season, episode, videoHash, arabicSrt });

    return {
      subtitles: [
        {
          id: `ai-ar-${imdbId}-${season || 0}-${episode || 0}`,
          lang: 'ara',
          url: record.fileUrl,
        },
      ],
    };
  } catch (err) {
    console.error('❌ خطأ أثناء معالجة الترجمة:', err);
    return { subtitles: [] };
  }
});

const app = express();

// دمج راوتر الإضافة (manifest.json + subtitles.json) مع سيرفر Express عادي
app.use(getRouter(builder.getInterface()));

// تقديم ملفات الترجمة العربية الجاهزة كملفات ثابتة
app.use('/subtitles-files', express.static(path.join(__dirname, 'cache_files')));

app.get('/', (req, res) => {
  res.send('✅ إضافة الترجمة العربية بالذكاء الاصطناعي تعمل. أضف /manifest.json في Stremio.');
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`🚀 الإضافة تعمل على المنفذ ${PORT}`);
  console.log(`📋 رابط الـ manifest: ${process.env.BASE_URL || `http://127.0.0.1:${PORT}`}/manifest.json`);
});
