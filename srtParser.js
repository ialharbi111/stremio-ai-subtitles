/**
 * تحليل ملف SRT إلى مصفوفة عناصر منظمة، وإعادة بنائه لاحقاً.
 * هذه الوحدة هي "خط الدفاع" الحقيقي لحماية التوقيت:
 * نحن لا نرسل التوقيت إلى Gemini إطلاقاً، بل نرسل النصوص فقط،
 * ثم نعيد تركيب ملف الـ SRT بالتوقيت الأصلي 100%.
 */

function parseSrt(srtContent) {
  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const blocks = normalized.split(/\n\s*\n/);

  const entries = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length >= 0);
    if (lines.length < 2) continue;

    let idx = 0;
    // السطر الأول عادة رقم الترتيب
    const indexLine = lines[idx].trim();
    let index = indexLine;
    if (/^\d+$/.test(indexLine)) {
      idx++;
    }

    const timeLine = lines[idx];
    if (!timeLine || !timeLine.includes('-->')) continue;
    idx++;

    const textLines = lines.slice(idx);
    const text = textLines.join('\n').trim();

    entries.push({
      index,
      time: timeLine.trim(),
      text,
    });
  }
  return entries;
}

function buildSrt(entries) {
  return entries
    .map((e, i) => {
      const num = /^\d+$/.test(e.index) ? e.index : String(i + 1);
      return `${num}\n${e.time}\n${e.text}`;
    })
    .join('\n\n') + '\n';
}

module.exports = { parseSrt, buildSrt };
