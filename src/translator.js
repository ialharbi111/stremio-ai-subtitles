const { GoogleGenerativeAI } = require('@google/generative-ai');
const { parseSrt, buildSrt } = require('./srtParser');
const { getGlossaryForSeries, upsertGlossaryTerms, getStyleNotes } = require('./db');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL_NAME = 'gemini-flash-latest'; // alias يتحدّث تلقائياً لأحدث نموذج Flash متوفر من Google
const BATCH_SIZE = 90; // عدد أسطر الحوار في كل طلب - يوازن بين السرعة وحجم الاستجابة

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
  // Gemini قد يحيط الرد بـ ```json ... ``` أحياناً رغم التوجيه، نزيلها احتياطاً
  const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}

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
      // إعادة محاولة واحدة عند فشل تحليل الـ JSON
      return translateBatch({ batch, systemInstruction, attempt: attempt + 1 });
    }
    console.warn('فشل تحليل رد Gemini كـ JSON، سيتم إبقاء النص الأصلي لهذه الدفعة');
    return batch; // كحل أخير، لا نفقد السطر بل نرجع النص الإنجليزي
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
 * الدالة الرئيسية: تأخذ ملف SRT إنجليزي كامل وتُعيد نسخته العربية
 * مع الحفاظ الكامل على التوقيت والترقيم (لأننا لا نرسلهما لـ Gemini أصلاً).
 */
async function translateSrt({ srtContent, imdbId, season }) {
  const entries = parseSrt(srtContent);
  const texts = entries.map((e) => e.text);

  const seriesKey = imdbId; // يمكن تعديلها لاحقاً لتكون خاصة بالموسم إن رغبت
  const glossary = getGlossaryForSeries(seriesKey);
  const styleNotes = getStyleNotes(seriesKey);
  const systemInstruction = buildSystemInstruction({ glossary, styleNotes });

  const batches = chunkArray(texts, BATCH_SIZE);

  const translatedBatches = await Promise.all(
    batches.map((batch) => translateBatch({ batch, systemInstruction }))
  );

  const translatedTexts = translatedBatches.flat();

  entries.forEach((entry, i) => {
    entry.text = translatedTexts[i] || entry.text;
  });

  const arabicSrt = buildSrt(entries);

  // تحديث ذاكرة المصطلحات في الخلفية دون تأخير الاستجابة للمستخدم
  updateGlossaryInBackground({ imdbId: seriesKey, texts, translatedTexts }).catch((err) => {
    console.warn('تعذّر تحديث ذاكرة المصطلحات:', err.message);
  });

  return arabicSrt;
}

/**
 * يستخرج أسماء الشخصيات والمصطلحات المتكررة من هذه الحلقة ويحفظها
 * لتُستخدم في ترجمة الحلقات القادمة من نفس المسلسل (اتساق الأسلوب).
 */
async function updateGlossaryInBackground({ imdbId, texts, translatedTexts }) {
  // نأخذ عينة من الأزواج بدل إرسال الحلقة كاملة مرة أخرى لتوفير الوقت والتكلفة
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

  const result = await model.generateContent(JSON.stringify(pairs));
  const rawText = result.response.text();
  const terms = extractJsonArray(rawText);

  if (Array.isArray(terms) && terms.length > 0) {
    upsertGlossaryTerms(imdbId, terms);
  }
}

module.exports = { translateSrt };
