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

// طابور عالمي يضمن عدم تداخل أي طلبات لـ Gemini من أي مكان في التطبيق
let globalQueue = Promise.resolve();

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
5. إذا كان النص يحتوي على اسم علم (شخصية) لم يرد في القائمة أدناه، اختر نقحرة عربية ثابتة له والتزم بها.
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
 * دالة الترجمة الأساسية للـ Batch الواحد
 */
async function translateBatch({ batch, systemInstruction, attempt = 1 }) {
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
    },
  });

  const prompt = JSON.stringify(batch);
  const result = await model.generateContent(prompt);
  const rawText = result.response.text();

  let translated;
  try {
    translated = extractJsonArray(rawText);
  } catch (err) {
    if (attempt < 2) {
      return translateBatch({ batch, systemInstruction, attempt: attempt + 1 });
    }
    console.warn('فشل تحليل رد Gemini كـ JSON، سيتم إبقاء النص الأصلي لهذه الدفعة');
    return batch;
  }

  if (!Array.isArray(translated) || translated.length !== batch.length) {
    if (attempt < 2) {
      return translateBatch({ batch, systemInstruction, attempt: attempt + 1 });
    }
    console.warn('عدد العناصر المُترجمة لا يطابق الأصل، سيتم إبقاء النص الأصلي لهذه الدفعة');
    return batch;
  }

  return translated;
}

/**
 * دالة وسيطة تجبر الطلبات على المرور عبر "الطابور الموحد" وتفرض تأخير أمن جداً بين كل عملية وأخرى
 */
function queuedTranslateBatch({ batch, systemInstruction }) {
  return new Promise((resolve, reject) => {
    // نربط الطلب الحالي بنهاية الطابور العالمي
    globalQueue = globalQueue.then(async () => {
      // ننتظر 8 ثوانٍ كاملة (8000ms) للأمان القصوى لضمان عدم تخطي الـ Rate Limit
      await delay(8000);
      try {
        const res = await translateBatch({ batch, systemInstruction });
        resolve(res);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * الدالة الرئيسية للترجمة
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

  // نمر على الدفعات ونرسلها عبر الطابور الموحد بالتتالي
  for (let i = 0; i < batches.length; i++) {
    console.log(`⏳ [طابور الانتظار] تجهيز الدفعة ${i + 1} من أصل ${batches.length}...`);
    
    try {
      const translatedBatch = await queuedTranslateBatch({ batch: batches[i], systemInstruction });
      translatedBatches.push(translatedBatch);
      console.log(`✅ تم ترجمة الدفعة ${i + 1} بنجاح.`);
    } catch (err) {
      console.log(`⚠️ فشلت الدفعة ${i + 1}، سيتم إعادة المحاولة بعد فترة نقاهة (15 ثانية)...`);
      await delay(15000); // فترة نقاهة أطول عند الفشل
      try {
        const translatedBatch = await queuedTranslateBatch({ batch: batches[i], systemInstruction });
        translatedBatches.push(translatedBatch);
        console.log(`✅ تم ترجمة الدفعة ${i + 1} في محاولة الإعادة.`);
      } catch (retryErr) {
        console.error(`❌ فشلت المحاولة الثانية للدفعة ${i + 1}، سيتم استخدام النص الأصلي.`);
        translatedBatches.push(batches[i]);
      }
    }
  }

  const translatedTexts = translatedBatches.flat();

  entries.forEach((entry, i) => {
    entry.text = translatedTexts[i] || entry.text;
  });

  const arabicSrt = buildSrt(entries);

  // تم إلغاء تحديث المصطلحات بالخلفية مؤقتاً لتوفير الـ Quota للترجمة الفعلية

  return arabicSrt;
}

module.exports = { translateSrt };
