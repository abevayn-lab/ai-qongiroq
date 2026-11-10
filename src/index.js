require("dotenv").config();

const { Bot, InputFile, InlineKeyboard } = require("grammy");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startWebApp } = require("./web");
const { Pool } = require("pg");

const { BOT_TOKEN, GROQ_API_KEY, GROQ_MODEL = "openai/gpt-oss-120b", GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.8-flash", DATABASE_URL, ADMIN_TELEGRAM_ID, WEB_APP_URL } = process.env;

if (!BOT_TOKEN || (!GROQ_API_KEY && !GEMINI_API_KEY)) {
  console.error("BOT_TOKEN va kamida bitta AI API kaliti kerak.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

const db = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

if (!db) console.warn("DATABASE_URL sozlanmagan. Foydalanuvchilar bazaga yozilmaydi.");

async function saveTelegramUser(ctx) {
  if (!db || !ctx.from) return;
  const telegramId = Number(ctx.from.id);
  const adminId = ADMIN_TELEGRAM_ID ? Number(ADMIN_TELEGRAM_ID) : null;
  await db.query(
    `insert into public.slayd_users (telegram_id, username, first_name, last_name, is_admin, last_seen_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (telegram_id) do update set
       username = excluded.username,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       is_admin = public.slayd_users.is_admin or excluded.is_admin,
       last_seen_at = now()`,
    [telegramId, ctx.from.username || null, ctx.from.first_name || null, ctx.from.last_name || null, Boolean(adminId && telegramId === adminId)]
  );
}

bot.use(async (ctx, next) => {
  try { await saveTelegramUser(ctx); }
  catch (error) { console.error("Supabase foydalanuvchi yozuvi xatosi:", error.message); }
  await next();
});

bot.command("admin", async (ctx) => {
  const adminId = ADMIN_TELEGRAM_ID ? Number(ADMIN_TELEGRAM_ID) : null;
  if (!adminId || Number(ctx.from?.id) !== adminId) {
    return ctx.reply("⛔ Bu buyruq faqat administrator uchun.");
  }
  if (!db) return ctx.reply("❌ Baza ulanmagan. DATABASE_URL sozlamasini tekshiring.");
  try {
    const result = await db.query(`
      select
        (select count(*)::int from public.slayd_users) as users_total,
        (select count(*)::int from public.slayd_users where created_at::date = current_date) as users_today,
        (select count(*)::int from public.slayd_projects) as projects_total,
        (select count(*)::int from public.slayd_projects where created_at::date = current_date) as projects_today,
        (select count(*)::int from public.slayd_projects where status = 'completed') as projects_completed,
        (select count(*)::int from public.slayd_projects where status = 'failed') as projects_failed,
        (select coalesce(sum(amount_uzs), 0)::bigint from public.slayd_payments where status = 'paid') as revenue_uzs
    `);
    const s = result.rows[0];
    await ctx.reply(
      "📊 SLAYD AI — ADMIN PANEL\n\n" +
      "👥 Jami foydalanuvchilar: " + s.users_total + "\n" +
      "🆕 Bugun qo‘shilganlar: " + s.users_today + "\n" +
      "📄 Jami buyurtmalar: " + s.projects_total + "\n" +
      "📅 Bugungi buyurtmalar: " + s.projects_today + "\n" +
      "✅ Tayyor PDF: " + s.projects_completed + "\n" +
      "❌ Xatolik: " + s.projects_failed + "\n" +
      "💰 Tasdiqlangan tushum: " + Number(s.revenue_uzs).toLocaleString("uz-UZ") + " so‘m"
    );
  } catch (error) {
    console.error("Admin statistika xatosi:", error);
    await ctx.reply("❌ Statistikani olishda xatolik. Baza jadvallarini tekshiring.");
  }
});

bot.command("id", async (ctx) => {
  await ctx.reply("Telegram ID raqamingiz: " + ctx.from.id + "\nBu raqamni Railway Variables ichida ADMIN_TELEGRAM_ID qiymati sifatida saqlang.");
});

bot.command("start", async (ctx) => {
  const message = "👋 Assalomu alaykum! Men SLAYD AI.\n\n📚 Mavzuni yozing yoki Web App orqali taqdimotni tahrirlang.\n8 slaydli PDF tayyorlayman.";
  if (WEB_APP_URL && /^https:\/\//i.test(WEB_APP_URL)) {
    await ctx.reply(message, { reply_markup: new InlineKeyboard().webApp("🎨 Taqdimot yaratish va tahrirlash", WEB_APP_URL) });
  } else {
    await ctx.reply(message + "\n\n⚙️ Web App uchun Railway Variables ichida WEB_APP_URL kiriting.");
  }
});
bot.command("webapp", async (ctx) => {
  if (!WEB_APP_URL || !/^https:\/\//i.test(WEB_APP_URL)) return ctx.reply("Web App manzili hali sozlanmagan.");
  await ctx.reply("🎨 Taqdimot muharriri:", { reply_markup: new InlineKeyboard().webApp("Web Appni ochish", WEB_APP_URL) });
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
  const requestBody = {
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: "Sen professional o'zbek tilidagi taqdimot muallifisan. JSON so'ralganda faqat bitta to'g'ri JSON obyekt qaytar. Markdown, izoh yoki kod bloki yozma. Barcha kalit va matn qiymatlari qo'shtirnoq ichida bo'lsin." },
      { role: "user", content: prompt }
    ],
    temperature: 0.2,
    max_completion_tokens: generationConfig.maxOutputTokens || 3500,
    ...(generationConfig.responseMimeType === "application/json" ? { response_format: { type: "json_object" } } : {})
  };
  const request = body => fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + GROQ_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000)
  });
  let response = await request(requestBody);
  let payload = await response.json().catch(() => ({}));

  // Ba'zi model urinishlarida Groq JSON rejimi 400 qaytarishi mumkin.
  // Bunday holatda modeldan prompt orqali qat'iy JSON so'rab, JSON rejimisiz qayta urinib ko'ramiz.
  if (!response.ok && response.status === 400 &&
      /failed to generate json/i.test(payload.error?.message || "") &&
      requestBody.response_format) {
    console.warn("Groq JSON rejimi xato berdi; oddiy rejimda qayta urinilmoqda.");
    const retryBody = { ...requestBody };
    delete retryBody.response_format;
    response = await request(retryBody);
    payload = await response.json().catch(() => ({}));
  }

  if (!response.ok) {
    const detail = payload.error?.failed_generation
      ? payload.error.message + " | failed_generation: " + payload.error.failed_generation
      : (payload.error?.message || response.statusText);
    throw new Error("Groq API xatosi (" + response.status + "): " + detail);
  }
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
  const telegramUrl = "https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + file.file_path;
  const response = await fetch(telegramUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("Rasmni Telegramdan yuklab bo'lmadi.");
  const buffer = Buffer.from(await response.arrayBuffer());
  const base64 = buffer.toString("base64");

  if (GROQ_API_KEY) {
    try {
      console.log("Rasm matni: Groq vision orqali o'qilmoqda.");
      const visionResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + GROQ_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen/qwen3.8-27b",
          messages: [{ role: "user", content: [
            { type: "text", text: "Rasmdagi matnni aniq o'qib chiq. Taqdimot uchun muhim ma'lumotlarni o'zbek tilida tartibli yoz. O'qilmagan joyni to'qima." },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64," + base64 } }
          ] }],
          temperature: 0.2,
          max_completion_tokens: 1400
        }),
        signal: AbortSignal.timeout(45000)
      });
      const visionPayload = await visionResponse.json().catch(() => ({}));
      if (!visionResponse.ok) throw new Error("Groq Vision xatosi (" + visionResponse.status + "): " + (visionPayload.error?.message || visionResponse.statusText));
      const visionText = visionPayload.choices?.[0]?.message?.content?.trim();
      if (visionText) return { text: visionText, imageBuffer: buffer };
      throw new Error("Groq Vision bo'sh javob qaytardi.");
    } catch (error) {
      console.error("Groq Vision ishlamadi:", error.message);
    }
  }

  if (GEMINI_API_KEY) {
    console.log("Rasm matni: Gemini zaxira orqali o'qilmoqda.");
    const geminiText = await geminiGenerate([{ role: "user", parts: [
      { text: "Rasmdagi matnni o'qib, taqdimot uchun muhim ma'lumotlarni o'zbek tilida ajratib ber. O'qilmagan joylarni to'qima." },
      { inlineData: { mimeType: "image/jpeg", data: base64 } }
    ] }], { maxOutputTokens: 1400 });
    return { text: geminiText, imageBuffer: buffer };
  }
  throw new Error("Rasmni o'qish uchun Groq Vision va Gemini xizmatlari javob bermadi.");
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
    const doc = new PDFDocument({ size: [960, 540], margin: 0, info: { Title: data.title || "SLAYD AI taqdimoti", Author: "SLAYD AI" } });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    const C = { navy: "#101B35", navy2: "#19294B", blue: "#3977F6", cyan: "#36C5D8", ink: "#18243A", muted: "#65738B", paper: "#F4F7FC", white: "#FFFFFF", line: "#E3EAF4", pale: "#EAF1FF", paleCyan: "#E8F8FA" };
    const safe = v => String(v || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    data.slides.forEach((slide, index) => {
      if (index) doc.addPage({ size: [960, 540], margin: 0 });
      const cover = index === 0;
      doc.rect(0, 0, 960, 540).fill(cover ? C.navy : C.paper);
      if (cover) {
        doc.rect(0, 0, 960, 13).fill(C.cyan);
        doc.circle(830, 110, 170).fill(C.navy2);
        doc.circle(830, 110, 110).lineWidth(2).strokeColor("#31466F").stroke();
        doc.circle(830, 110, 64).fill(C.blue);
        doc.fillColor(C.white).font("Helvetica-Bold").fontSize(12).text("SLAYD AI  /  TAQDIMOT", 68, 54, { characterSpacing: 2 });
        doc.fillColor(C.cyan).font("Helvetica-Bold").fontSize(11).text("BILIM  •  TAHLIL  •  G'OYA", 70, 145);
        doc.fillColor(C.white).font("Helvetica-Bold").fontSize(35).text(safe(slide.title || data.title || "Taqdimot"), 68, 183, { width: slide.imagePath ? 550 : 690, height: 120, ellipsis: true });
        if (slide.imagePath && fs.existsSync(slide.imagePath)) { try { doc.image(slide.imagePath, 675, 245, { fit: [220, 185] }); } catch (e) { console.warn("Cover image:", e.message); } }
        doc.roundedRect(70, 322, 86, 5, 2).fill(C.cyan);
        doc.fillColor("#D5DEEF").font("Helvetica").fontSize(17).text(safe(data.subtitle || "Mavzu bo'yicha tayyorlangan taqdimot"), 70, 348, { width: 690, height: 52, ellipsis: true });
        slide.bullets.slice(0, 3).forEach((item, i) => {
          const y = 425 + i * 25;
          doc.circle(76, y + 7, 3).fill(C.cyan);
          doc.fillColor("#E6ECF7").font("Helvetica").fontSize(12).text(safe(item), 90, y, { width: 650, height: 19, ellipsis: true });
        });
        doc.fillColor("#AAB8D0").font("Helvetica").fontSize(10).text("SLAYD AI  •  8 SLAYD  •  PDF", 70, 500);
        doc.fillColor("#AAB8D0").text("01 / 08", 820, 500, { width: 70, align: "right" });
      } else {
        doc.rect(0, 0, 960, 10).fill(C.blue);
        doc.fillColor(C.blue).font("Helvetica-Bold").fontSize(10).text("SLAYD AI   /   TAQDIMOT", 58, 34, { characterSpacing: 1.5 });
        doc.fillColor(C.muted).font("Helvetica-Bold").fontSize(10).text("BO'LIM  " + String(index).padStart(2, "0"), 790, 34, { width: 110, align: "right" });
        doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(27).text(safe(slide.title), 58, 76, { width: 820, height: 72, ellipsis: true });
        doc.roundedRect(58, 153, 64, 4, 2).fill(C.cyan);
        const bullets = slide.bullets.length ? slide.bullets : ["Ushbu bo'lim bo'yicha qo'shimcha ma'lumot."];
        const top = 185, gap = 12, cardH = Math.min(78, (280 - gap * (bullets.length - 1)) / bullets.length);
        bullets.forEach((item, j) => {
          const y = top + j * (cardH + gap);
          doc.roundedRect(58, y, 844, cardH, 12).fill(C.white);
          doc.roundedRect(58, y, 5, cardH, 2).fill(j % 2 ? C.cyan : C.blue);
          doc.circle(91, y + cardH / 2, 12).fill(j % 2 ? C.paleCyan : C.pale);
          doc.fillColor(C.blue).font("Helvetica-Bold").fontSize(10).text(String(j + 1).padStart(2, "0"), 82, y + cardH / 2 - 4, { width: 18, align: "center" });
          doc.fillColor(C.ink).font("Helvetica").fontSize(cardH < 52 ? 13 : 15).text(safe(item), 119, y + 12, { width: slide.imagePath ? 485 : 750, height: cardH - 18, ellipsis: true, lineGap: 3 });
        });
        if (slide.imagePath && fs.existsSync(slide.imagePath)) { try { doc.image(slide.imagePath, 650, 190, { fit: [235, 235] }); } catch (e) { console.warn("Slide image:", e.message); } }
        doc.moveTo(58, 492).lineTo(902, 492).strokeColor(C.line).lineWidth(1).stroke();
        doc.fillColor(C.muted).font("Helvetica").fontSize(9).text("SLAYD AI  •  O'QUV TAQDIMOTI", 58, 505);
        doc.fillColor(C.muted).font("Helvetica-Bold").fontSize(10).text(String(index + 1).padStart(2, "0") + " / " + String(data.slides.length).padStart(2, "0"), 820, 503, { width: 80, align: "right" });
      }
    });
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
    doc.end();
  });
}

async function generateAndSend(ctx, source, options = {}) {
  const status = await ctx.reply("⏳ Taqdimotingiz tayyorlanmoqda. Biroz kuting...");
  const jobId = String(ctx.from.id) + "-" + Date.now() + "-" + Math.random().toString(36).slice(2,8);
  const outputPath = path.join(os.tmpdir(), "slayd-ai-" + jobId + ".pdf");
  let sourceImagePath = null;
  try {
    console.log("Taqdimot: Groq asosiy, Gemini zaxira AI so'rovi boshlandi.");
    const data = await makeSlides(source);
    if (options.imageBuffer) {
      sourceImagePath = path.join(os.tmpdir(), "slayd-ai-source-" + jobId + ".jpg");
      fs.writeFileSync(sourceImagePath, options.imageBuffer, { flag: "wx" });
      data.slides[0].imagePath = sourceImagePath;
    }
    console.log("Taqdimot: AI javobi olindi, PDF tayyorlanmoqda.");
    await createPdf(data, outputPath);
    console.log("Taqdimot: PDF tayyor.");
    await ctx.replyWithDocument(new InputFile(outputPath, "slayd-ai-taqdimot.pdf"), {
      caption: "✅ Taqdimotingiz tayyor! SLAYD AI orqali yaratildi."
    });
  } finally {
    try { await ctx.api.deleteMessage(ctx.chat.id, status.message_id); } catch (_) {}
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    if (sourceImagePath && fs.existsSync(sourceImagePath)) fs.unlinkSync(sourceImagePath);
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
    await generateAndSend(ctx, [caption, extracted.text].filter(Boolean).join("\n\n"), { imageBuffer: extracted.imageBuffer });
  } catch (error) {
    console.error(error);
    await ctx.reply("❌ Rasmni o'qishda yoki taqdimot yaratishda xatolik bo'ldi. Aniqroq rasm yuboring.");
  }
});

bot.catch((error) => console.error("Bot xatosi:", error));
startWebApp({ bot, db, makeSlides, createPdf, InputFile, botToken: BOT_TOKEN });
bot.start();
console.log("SLAYD AI bot ishga tushdi.");
