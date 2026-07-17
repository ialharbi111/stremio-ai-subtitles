const { GoogleGenerativeAI } = require('@google/generative-ai');
const { parseSrt, buildSrt } = require('./srtParser');
const { getGlossaryForSeries, upsertGlossaryTerms, getStyleNotes } = require('./db');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL_NAME = 'gemini-flash-latest'; 
const BATCH_SIZE = 80; // حجم الدفعة المثالي لضمان ثبات الاستجابة بالـ IDs

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 4000; // 4 ثوانٍ فقط (سريع وآمن جداً)

async function throttledGenerateContent(model, prompt) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    await delay(waitTime);
  }
  
  lastRequestTime = Date.now();
  return await model.generateContent(prompt);
}

function buildSystemInstruction({ glossary, styleNotes }) {
  let glossaryBlock = '';
  if (glossary && glossary.length > 0) {
    const lines = glossary.map((g) => `- "${g.term_en}" => "${g.term_ar}"`).join('\n');
    glossaryBlock = `
قائمة مصطلحات وأسماء يجب الالتزام الحرفي بترجمتها:
${lines}
`;
  }

  const styleBlock = styleNotes ? `\nملاحظات أسلوبية إضافية: ${styleNotes}\n` : '';

  return `أنت مترجم محترف متخصص في ترجمة الأفلام والمسلسلات من الإنجليزية إلى العربية الفصحى السلسة والمناسبة للمشاهدة.

ستتلقى مصفوفة كائنات بصيغة JSON تحتوي على معرف "id" ونص "text".
مهمتك ترجمة حقل "text" فقط إلى العربية الفصحى السلسة، وإرجاع مصفوفة JSON بنفس المعرفات (id) تماماً.

مثال للمدخلات:
[{"id": 1, "text": "Go home."}, {"id": 2, "text": "No way!"}]

مثال للمخرجات المتوقعة منك:
[{"id": 1, "text": "اذهب إلى المنزل."}, {"id": 2, "text": "مستحيل!"}]

قواعد صارمة:
1. تُرجم فقط النص، ولا تضف أي شرح أو تعليق خارج الـ JSON.
2. حافظ على الـ "id" الخاص بكل سطر كما هو دون تعديل أو حذف.
3. لا تترجم حرفياً؛ اجعل الصياغة طبيعية ودرامية ممتازة للمشاهدة بالعربية.
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
 * ترجمة دفعة تعتمد على نظام الـ IDs لضمان مطابقة التوقيت بنسبة 100%
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

  // نرسل مصفوفة تحتوي على الـ id والـ text لتفادي أي لبطة أو ترحيل بالتوقيت
  const payload = batch.map(item => ({ id: item.id, text: item.text }));
  const prompt = JSON.stringify(payload);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await throttledGenerateContent(model, prompt);
      const rawText = result.response.text();
      const translatedList = extractJsonArray(rawText);

      if (Array.isArray(translatedList)) {
        // نصنع خريطة Map للترجمات المستلمة لتسهيل مطابقتها بالـ ID
        const translatedMap = new Map();
        translatedList.forEach(item => {
          if (item && item.id !== undefined) {
            translatedMap.set(item.id, item.text);
          }
        });
        return translatedMap;
      }
      throw new Error("الترجمة المستلمة ليست مصفوفة JSON صالحة.");
    } catch (err) {
      console.error(`⚠️ فشلت الدفعة (محاولة ${attempt}/${maxAttempts}) بسبب: ${err.message}`);
      if (attempt < maxAttempts) {
        const cooldown = attempt * 5000;
        console.log(`😴 الانتظار لمدة ${cooldown / 1000} ثوانٍ قبل إعادة المحاولة...`);
        await delay(cooldown);
      }
    }
  }

  console.warn('❌ فشلت المحاولات، سيتم الإبقاء على النص الأصلي لهذه الدفعة حفاظاً على المزامنة.');
  return new Map(); // نرجع خريطة فارغة في حال الفشل التام ليبقى النص الأصلي مكانه بدقة
}

/**
 * الدالة الرئيسية
 */
async function translateSrt({ srtContent, imdbId, season }) {
  const entries = parseSrt(srtContent);
  console.log(`🔍 عدد الأسطر المستخرجة من ملف الـ SRT = ${entries.length}`);

  // نربط كل سطر بالـ Index (الترتيب) الخاص به كـ ID فريد
  const itemsToTranslate = entries.map((e, index) => ({
    id: index,
    text: e.text
  }));

  const seriesKey = imdbId; 
  const glossary = getGlossaryForSeries(seriesKey);
  const styleNotes = getStyleNotes(seriesKey);
  const systemInstruction = buildSystemInstruction({ glossary, styleNotes });

  const batches = chunkArray(itemsToTranslate, BATCH_SIZE);
  console.log(`📦 تم تقسيم الملف إلى ${batches.length} دفعة للترجمة.`);

  const allTranslationsMap = new Map();

  for (let i = 0; i < batches.length; i++) {
    console.log(`⏳ جاري ترجمة الدفعة ${i + 1} من أصل ${batches.length}...`);
    
    const translatedBatchMap = await translateBatchWithRetry({ batch: batches[i], systemInstruction });
    
    // دمج الترجمات الناجحة في الخريطة الكبرى
    for (const [id, text] of translatedBatchMap.entries()) {
      allTranslationsMap.set(id, text);
    }
    
    console.log(`✅ انتهت معالجة الدفعة ${i + 1}.`);
  }

  // دمج الترجمات بملف الـ SRT الأصلي بالاعتماد على الـ ID (المطابقة المستحيل تخطئ)
  entries.forEach((entry, index) => {
    if (allTranslationsMap.has(index)) {
      entry.text = allTranslationsMap.get(index);
    }
  });

  const arabicSrt = buildSrt(entries);

  // استخراج الكلمات المفتاحية في الخلفية (كود كلاود بكامل قوته)
  const texts = entries.map(e => e.text);
  const originalTexts = itemsToTranslate.map(e => e.text);
  updateGlossaryInBackground({ imdbId: seriesKey, texts: originalTexts, translatedTexts: texts }).catch((err) => {
    console.warn('تعذّر تحديث ذاكرة المصطلحات:', err.message);
  });

  return arabicSrt;
}

async function updateGlossaryInBackground({ imdbId, texts, translatedTexts }) {
  const sampleSize = Math.min(120, texts.length);
  const step = Math.max(1, Math.floor(texts.length / sampleSize));
  const pairs = [];
  for (let i = 0; i < texts.length; i += step) {
    pairs.push({ en: texts[i], ar: translatedTexts[i] });
  }

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: `مهمتك استخراج أسماء الأعلام والتعبيرات المتكررة المهمة فقط من أزواج الجمل التالية، وإرجاعها كمصفوفة JSON بالشكل: [{"en": "...", "ar": "..."}]. لا تضف أي شرح خارجي.`,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  });

  try {
    const result = await throttledGenerateContent(model, JSON.stringify(pairs));
    const rawText = result.response.text();
    const terms = extractJsonArray(rawText);

    if (Array.isArray(terms) && terms.length > 0) {
      upsertGlossaryTerms(imdbId, terms);
      console.log('✨ تم تحديث ذاكرة المصطلحات للمسلسل بنجاح في الخلفية.');
    }
  } catch (err) {
    console.warn('⚠️ تعذر استخراج المصطلحات في الخلفية:', err.message);
  }
}

module.exports = { translateSrt };
