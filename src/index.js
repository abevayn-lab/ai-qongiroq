require("dotenv").config();

const { Bot, InputFile } = require("grammy");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { BOT_TOKEN, GROQ_API_KEY, GROQ_MODEL = "openai/gpt-oss-120b", GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.8-flash" } = process.env;

if (!BOT_TOKEN || (!GROQ_API_KEY && !GEMINI_API_KEY)) {
  console.error("BOT_TOKEN va kamida bitta AI API kaliti kerak.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 Assalomu alaykum! Men SLAYD AI.\n\n" +
    "📚 Menga taqdimot mavzusini yozing yoki topshiriq/kitob sahifasining rasmini yuboring.\n" +
    "Men sizga 8 slayddan iborat PDF taqdimot tayyorlayman.\n\n" +
    "Masalan: Sun'iy intellektning ta'limdagi o'rni"
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply("Mavzuni matn ko'rinishida yuboring yoki rasm tashlang. Natija PDF formatida qaytadi.");
});

async function geminiGenerate(contents, generationConfig = {}) {
  if (!GEMINI_API_KEY) throw new Error("Gemini API kaliti sozlanmagan.");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent?key=" + GEMINI_API_KEY;
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig: { temperature: 0.35, ...generationConfig } }),
    signal: AbortSignal.timeout(45000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Gemini API xatosi (" + response.status + "): " + (payload.error?.message || response.statusText));
  const resultText = payload.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
  if (!resultText) throw new Error("Gemini bo'sh javob qaytardi.");
  return resultText;
}

async function groqGenerate(prompt, generationConfig = {}) {
  if (!GROQ_API_KEY) throw new Error("Groq API kaliti sozlanmagan.");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + GROQ_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: "Sen professional o'zbek tilidagi taqdimot muallifisan." },
        { role: "user", content: prompt }
      ],
      temperature: 0.35,
      max_completion_tokens: generationConfig.maxOutputTokens || 3500,
      response_format: generationConfig.responseMimeType === "application/json" ? { type: "json_object" } : undefined
    }),
    signal: AbortSignal.timeout(45000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Groq API xatosi (" + response.status + "): " + (payload.error?.message || response.statusText));
  const result = payload.choices?.[0]?.message?.content?.trim();
  if (!result) throw new Error("Groq bo'sh javob qaytardi.");
  return result;
}

async function generateText(prompt, generationConfig = {}) {
  const errors = [];
  if (GROQ_API_KEY) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log("AI: Groq (" + GROQ_MODEL + "), urinish " + attempt);
        return await groqGenerate(prompt, generationConfig);
      } catch (error) {
        errors.push(error);
        console.error("Groq xatosi:", error.message);
        if (attempt === 1 && /429|500|502|503|504|timeout|timed out|fetch failed|aborted/i.test(error.message)) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          continue;
        }
        break;
      }
    }
  }
  if (GEMINI_API_KEY) {
    try {
      console.log("AI: Groq ishlamadi, Gemini zaxiraga o'tmoqda.");
      return await geminiGenerate([{ role: "user", parts: [{ text: prompt }] }], generationConfig);
    } catch (error) {
      errors.push(error);
      console.error("Gemini zaxira xatosi:", error.message);
    }
  }
  throw new Error("AI xizmatlari javob bermadi: " + errors.map(e => e.message).join(" | "));
}

async function extractImageText(ctx) {
  const photos = ctx.message.photo;
  const photo = photos[photos.length - 1];
  const file = await ctx.api.getFile(photo.file_id);
  const url = "https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + file.file_path;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Rasmni Telegramdan yuklab bo'lmadi.");
  const buffer = Buffer.from(await response.arrayBuffer());
  return await geminiGenerate([{ role: "user", parts: [
    { text: "Rasmdagi matnni o'qib, taqdimot uchun muhim ma'lumotlarni o'zbek tilida ajratib ber." },
    { inlineData: { mimeType: "image/jpeg", data: buffer.toString("base64") } }
  ] }], { maxOutputTokens: 1200 });
}

async function makeSlides(topic) {
  const prompt = "Mavzu bo'yicha professional taqdimot tayyorla. Faqat o'zbek tilida va faqat JSON qaytar: " +
    '{"title":"...","subtitle":"...","slides":[{"title":"...","bullets":["...","...","..."],"speaker_notes":"..."}]}. ' +
    "Aynan 8 ta slayd bo'lsin, har birida 3-5 ta mazmunli va takrorlanmaydigan qisqa bullet bo'lsin. " +
    "Tuzilma: kirish, asosiy tushunchalar, amaliy misollar, ahamiyat, muammolar/istiqbollar, xulosa. " +
    "Ishonchsiz statistika va faktlarni to'qib chiqarmagin. Har slayd uchun 1-2 gaplik speaker_notes yoz. Mavzu: " + topic;
  const raw = await generateText(prompt, { responseMimeType: "application/json", maxOutputTokens: 3500 });
  let cleaned = raw.replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "").trim();
  const first = cleaned.indexOf("{"), last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  const data = JSON.parse(cleaned);
  if (!Array.isArray(data.slides) || data.slides.length < 6) throw new Error("AI slaydlar tuzilmasini noto'g'ri qaytardi.");
  data.slides = data.slides.slice(0, 8).map((slide, i) => ({
    title: String(slide.title || "Slayd " + (i + 1)),
    bullets: (Array.isArray(slide.bullets) ? slide.bullets : []).slice(0, 5).map(String),
    speaker_notes: String(slide.speaker_notes || "")
  }));
  return data;
}

function createPdf(data, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [960, 540], margin: 54, info: { Title: data.title || "SLAYD AI taqdimoti", Author: "SLAYD AI" } });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const navy = "#14213D";
    const blue = "#2563EB";
    const ink = "#202B3C";
    const muted = "#667085";

    data.slides.forEach((slide, index) => {
      if (index > 0) doc.addPage({ size: [960, 540], margin: 54 });
      doc.rect(0, 0, 960, 540).fill("#F5F7FB");
      doc.rect(0, 0, 960, 12).fill(blue);
      doc.fillColor(blue).font("Helvetica-Bold").fontSize(12).text("SLAYD AI  /  TAQDIMOT", 58, 38, { characterSpacing: 1.2 });
      doc.fillColor(navy).font("Helvetica-Bold").fontSize(index === 0 ? 34 : 28)
        .text(slide.title || data.title || "Taqdimot", 58, index === 0 ? 125 : 88, { width: 820, height: 90 });

      if (index === 0 && data.subtitle) {
        doc.fillColor(muted).font("Helvetica").fontSize(17).text(data.subtitle, 60, 225, { width: 790 });
      }

      const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
      let y = index === 0 ? 290 : 185;
      const available = index === 0 ? 175 : 285;
      const lineGap = Math.min(58, available / Math.max(bullets.length, 1));
      bullets.forEach((bullet) => {
        doc.circle(72, y + 9, 5).fill(blue);
        doc.fillColor(ink).font("Helvetica").fontSize(17)
          .text(String(bullet), 92, y, { width: 790, height: lineGap - 4, ellipsis: true });
        y += lineGap;
      });

      doc.moveTo(58, 485).lineTo(902, 485).strokeColor("#DCE2EC").lineWidth(1).stroke();
      doc.fillColor(muted).font("Helvetica").fontSize(10).text("SLAYD AI — AI yordamida tayyorlandi", 58, 498);
      doc.text(`${index + 1} / ${data.slides.length}`, 850, 498, { width: 52, align: "right" });
    });

    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

async function generateAndSend(ctx, source) {
  const status = await ctx.reply("⏳ Taqdimotingiz tayyorlanmoqda. Biroz kuting...");
  const outputPath = path.join(os.tmpdir(), `slayd-ai-${ctx.from.id}-${Date.now()}.pdf`);
  try {
    console.log("Taqdimot: Groq asosiy, Gemini zaxira AI so'rovi boshlandi.");
    const data = await makeSlides(source);
    console.log("Taqdimot: Gemini javobi olindi, PDF tayyorlanmoqda.");
    await createPdf(data, outputPath);
    console.log("Taqdimot: PDF tayyor.");
    await ctx.replyWithDocument(new InputFile(outputPath, "slayd-ai-taqdimot.pdf"), {
      caption: "✅ Taqdimotingiz tayyor! SLAYD AI orqali yaratildi."
    });
  } finally {
    try { await ctx.api.deleteMessage(ctx.chat.id, status.message_id); } catch (_) {}
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
}

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  if (text.length < 4) return ctx.reply("Mavzuni biroz batafsilroq yozing.");
  try {
    await generateAndSend(ctx, text);
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Taqdimot yaratishda xatolik bo'ldi. Qayta urinib ko'ring.");
  }
});

bot.on("message:photo", async (ctx) => {
  try {
    const extracted = await extractImageText(ctx);
    const caption = ctx.message.caption || "";
    await generateAndSend(ctx, [caption, extracted].filter(Boolean).join("\n\n"));
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Rasmni o'qishda yoki taqdimot yaratishda xatolik bo'ldi. Aniqroq rasm yuboring.");
  }
});

bot.catch((error) => console.error("Bot xatosi:", error));
bot.start();
console.log("SLAYD AI bot ishga tushdi.");
