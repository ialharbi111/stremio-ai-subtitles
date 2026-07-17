const { GoogleGenerativeAI } = require('@google/generative-ai');
const { parseSrt, buildSrt } = require('./srtParser');
const { getGlossaryForSeries, upsertGlossaryTerms, getStyleNotes } = require('./db');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL_NAME = 'gemini-flash-latest'; // alias يتحدّث تلقائياً لأحدث نموذج Flash متوفر من Google
const BATCH_SIZE = 90; // عدد أسطر الحوار في كل طلب - يوازن بين السرعة وحجم الاستجابة

/**
 * دالة مساعدة لعمل تأخير (Delay) بالملي ثانية
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// متغير عالمي لحفظ وقت آخر طلب تم إرساله لـ Gemini على مستوى السيرفر بالكامل
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 5000; // 5 ثوانٍ كحد أدنى بين أي طلبين لـ Gemini (أمان تام لـ Free Tier)

/**
 * منظم الطلبات العالمي: يضمن عدم خروج أي طلب لـ Gemini قبل مرور 5 ثوانٍ على الطلب السابق
 */
async function throttledGenerateContent(model, prompt) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    await delay(waitTime);
  }
  
  // تحديث وقت الطلب فوراً لحجز الدور للطلب التالي
  lastRequestTime = Date.now();
  
  return await model.generateContent(prompt);
}

function buildSystemInstruction({ glossary, styleNotes }) {
  let glossaryBlock = '';
  if (glossary && glossary.length > 0) {
    const lines = glossary.map((g) => `- "${g.term_en}" => "${g.term_ar}"`).join('\n');
    glossaryBlock = `
قائمة مصطلحات وأسماء يجب الالتزام الحرفي بترجمتها كما وردت (تم اعتمادها في حلقات سابقة من نفس المسلسل):
${lines}
`;
  }

  const styleBlock = styleNotes ? `\nملاحظات أسلوبية إضافية: ${styleNotes}\n` : '';

  return `أنت مترجم محترف متخصص في ترجمة الأفلام والمسلسلات من الإنجليزية إلى العربية الفصحى السلسة والمناسبة للمشاهدة (ليست عربية أكاديمية جامدة، بل لغة فصحى طبيعية تصلح للحوار الدرامي).

قواعد صارمة يجب الالتزام بها دائماً:
1. تُرجم فقط، لا تضف أي شرح أو تعليق أو ملاحظات خارج النص المترجم.
2. حافظ على المعنى والنبرة (فكاهي، جاد، عاطفي...) بما يناسب السياق.
3. لا تترجم حرفياً كلمة بكلمة؛ اجعل الجملة تبدو طبيعية بالعربية.
4. حافظ على علامات الترقيم المناسبة للعربية.
5. إذا كان النص يحتوي على اسم علم (شخصية) لم يرد في القائمة أدناه, اختر نقحرة عربية ثابتة له والتزم بها.
6. أعد النتيجة بصيغة JSON فقط (مصفوفة نصوص) بنفس عدد وترتيب العناصر المُدخلة، دون أي نص إضافي قبلها أو بعدها.
${glossaryBlock}${styleBlock}`;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function extractJsonArray(rawText) {
  const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}

/**
 * ترجمة الدفعة مع آلية إعادة المحاولة الذكية والمستقلة (حتى 3 محاولات)
 */
async function translateBatchWithRetry({ batch, systemInstruction, maxAttempts = 3 }) {
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
    },
  });

  const prompt = JSON.stringify(batch);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // إرسال الطلب عبر المنظم العالمي المفرمل للسرعة
      const result = await throttledGenerateContent(model, prompt);
      const rawText = result.response.text();
      const translated = extractJsonArray(rawText);

      if (Array.isArray(translated) && translated.length === batch.length) {
        return translated;
      }
      throw new Error("الترجمة المستلمة لا تطابق عدد الأسطر الأصلي أو ليست مصفوفة صالحة.");
    } catch (err) {
      console.error(`⚠️ فشلت الدفعة (محاولة ${attempt}/${maxAttempts}) بسبب: ${err.message}`);
      if (attempt < maxAttempts) {
        const cooldown = attempt * 6000; // فترة نقاهة تزيد تصاعدياً (6 ثوانٍ، ثم 12 ثانية)
        console.log(`😴 الانتظار لمدة ${cooldown / 1000} ثانية كفترة نقاهة قبل إعادة المحاولة...`);
        await delay(cooldown);
      }
    }
  }

  console.warn('❌ فشلت جميع المحاولات لهذه الدفعة، سيتم استخدام النص الأصلي كملجأ أخير.');
  return batch;
}

/**
 * الدالة الرئيسية: تأخذ ملف SRT إنجليزي كامل وتُعيد نسخته العربية
 */
async function translateSrt({ srtContent, imdbId, season }) {
  const entries = parseSrt(srtContent);
  console.log(`🔍 تشخيص: طول محتوى SRT المستلم = ${srtContent ? srtContent.length : 0} حرف`);
  console.log(`🔍 تشخيص: عدد الأسطر المستخرجة من الملف = ${entries.length}`);
  if (entries.length === 0 && srtContent) {
    console.log('🔍 أول 300 حرف من الملف المستلم (لفحص الصيغة):');
    console.log(srtContent.slice(0, 300));
  }

  const texts = entries.map((e) => e.text);

  const seriesKey = imdbId; 
  const glossary = getGlossaryForSeries(seriesKey);
  const styleNotes = getStyleNotes(seriesKey);
  const systemInstruction = buildSystemInstruction({ glossary, styleNotes });

  const batches = chunkArray(texts, BATCH_SIZE);
  console.log(`📦 تم تقسيم الملف إلى ${batches.length} دفعة للترجمة.`);

  const translatedBatches = [];

  // معالجة الدفعات بالتوالي وبشكل منظم وآمن تماماً
  for (let i = 0; i < batches.length; i++) {
    console.log(`⏳ جاري ترجمة الدفعة ${i + 1} من أصل ${batches.length}...`);
    
    const translatedBatch = await translateBatchWithRetry({ batch: batches[i], systemInstruction });
    translatedBatches.push(translatedBatch);
    
    console.log(`✅ انتهت معالجة الدفعة ${i + 1}.`);
  }

  const translatedTexts = translatedBatches.flat();

  entries.forEach((entry, i) => {
    entry.text = translatedTexts[i] || entry.text;
  });

  const arabicSrt = buildSrt(entries);

  // تحديث ذاكرة المصطلحات في الخلفية (تم تمريرها عبر المنظم لتفادي تعارض الـ Rate Limit)
  updateGlossaryInBackground({ imdbId: seriesKey, texts, translatedTexts }).catch((err) => {
    console.warn('تعذّر تحديث ذاكرة المصطلحات:', err.message);
  });

  return arabicSrt;
}

/**
 * يستخرج أسماء الشخصيات والمصطلحات المتكررة من هذه الحلقة ويحفظها
 */
async function updateGlossaryInBackground({ imdbId, texts, translatedTexts }) {
  const sampleSize = Math.min(120, texts.length);
  const step = Math.max(1, Math.floor(texts.length / sampleSize));
  const pairs = [];
  for (let i = 0; i < texts.length; i += step) {
    pairs.push({ en: texts[i], ar: translatedTexts[i] });
  }

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: `مهمتك استخراج أسماء الأعلام (شخصيات، أماكن، ألقاب) والتعبيرات المتكررة المهمة فقط من أزواج الجمل (إنجليزي/عربي) التالية، وإرجاعها كمصفوفة JSON بالشكل: [{"en": "...", "ar": "..."}]. تجاهل الجمل العادية. أرجع مصفوفة فارغة [] إن لم تجد شيئاً مهماً. لا تُرجع أي نص خارج الـ JSON.`,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  });

  try {
    // إرسال طلب المصطلحات عبر منظم البوابة الموحد لعدم تخطي الـ Rate Limit
    const result = await throttledGenerateContent(model, JSON.stringify(pairs));
    const rawText = result.response.text();
    const terms = extractJsonArray(rawText);

    if (Array.isArray(terms) && terms.length > 0) {
      upsertGlossaryTerms(imdbId, terms);
      console.log('✨ تم تحديث ذاكرة المصطلحات للمسلسل بنجاح في الخلفية.');
    }
  } catch (err) {
    console.warn('⚠️ تعذر استخراج المصطلحات في الخلفية بسبب تعارض بالـ Rate Limit:', err.message);
  }
}

module.exports = { translateSrt };
