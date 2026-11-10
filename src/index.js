require("dotenv").config();

const { Bot, InputFile, InlineKeyboard } = require("grammy");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startWebApp } = require("./web");
const { Pool } = require("pg");

const { BOT_TOKEN, GROQ_API_KEY, GROQ_MODEL = "openai/gpt-oss-120b", GEMINI_API_KEY, GEMINI_MODEL = "gemini-3.8-flash", GEMINI_IMAGE_MODEL = "gemini-3.1-flash-lite-image", DATABASE_URL, ADMIN_TELEGRAM_ID, WEB_APP_URL: WEB_APP_URL_RAW, REQUIRED_CHANNEL, REQUIRED_CHANNEL_URL, FREE_TESTER_IDS = "", CLICK_SERVICE_ID, CLICK_MERCHANT_ID, CLICK_MERCHANT_USER_ID, CLICK_SECRET_KEY, SLIDE_PRICE_UZS } = process.env;
const WEB_APP_URL = WEB_APP_URL_RAW || "https://ai-qongiroq-production.up.railway.app";

if (!BOT_TOKEN || (!GROQ_API_KEY && !GEMINI_API_KEY)) {
  console.error("BOT_TOKEN va kamida bitta AI API kaliti kerak.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

class Semaphore {
  constructor(concurrency, maxQueued) {
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
    this.active = 0;
    this.waiters = [];
  }
  async run(task) {
    if (this.active >= this.concurrency) {
      if (this.waiters.length >= this.maxQueued) throw new Error("Serverda navbat to'ldi. Birozdan keyin qayta urinib ko'ring.");
      await new Promise(resolve => this.waiters.push(resolve));
    }
    this.active++;
    try { return await task(); }
    finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}
const textQueue = new Semaphore(2, 40);
const imageQueue = new Semaphore(2, 40);

function validWebAppUrl(value) {
  try {
    const u = new URL(String(value || ""));
    return u.protocol === "https:" && !/your-railway-domain|example\.com/i.test(u.hostname);
  } catch (_) { return false; }
}


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

const freeTesterIds = new Set(FREE_TESTER_IDS.split(",").map(x => x.trim()).filter(Boolean));
const adminInputState = new Map();
function isFreeTester(userId) {
  return Number(userId) === Number(ADMIN_TELEGRAM_ID) || freeTesterIds.has(String(userId));
}
async function isChannelMember(userId) {
  if (!REQUIRED_CHANNEL) return true;
  try {
    const member = await bot.api.getChatMember(REQUIRED_CHANNEL, userId);
    return ["creator", "administrator", "member"].includes(member.status) || (member.status === "restricted" && member.is_member === true);
  } catch (error) {
    console.error("Kanal obunasini tekshirish xatosi:", error.message);
    return false;
  }
}
async function requireAccess(ctx) {
  if (!(await isChannelMember(ctx.from.id))) {
    const url = REQUIRED_CHANNEL_URL || (REQUIRED_CHANNEL.startsWith("@") ? "https://t.me/" + REQUIRED_CHANNEL.slice(1) : "");
    const keyboard = new InlineKeyboard();
    if (url) keyboard.url("📢 Kanalga obuna bo'lish", url).row();
    keyboard.text("🔄 Obunani tekshirish", "check_subscription");
    await ctx.reply("Davom etish uchun kanalga obuna bo'ling, keyin tekshirish tugmasini bosing.", { reply_markup: keyboard });
    return false;
  }
  return true;
}
bot.callbackQuery("check_subscription", async (ctx) => {
  if (await isChannelMember(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Obuna tasdiqlandi. Endi botdan foydalanishingiz mumkin." });
    await ctx.reply("✅ Obuna tasdiqlandi. Mavzuni yuboring yoki /webapp buyrug'ini bosing.");
  } else {
    await ctx.answerCallbackQuery({ text: "Kanalga obuna bo'lish hali aniqlanmadi.", show_alert: true });
  }
});


bot.callbackQuery(/^cfg:(payment_card_number|payment_card_holder|payment_price_uzs|payment_review_chat_id)$/, async ctx => {
  if(Number(ctx.from.id)!==Number(ADMIN_TELEGRAM_ID)) return ctx.answerCallbackQuery({text:'Faqat admin.',show_alert:true});
  const key=ctx.match[1]; adminInputState.set(String(ctx.from.id),key); await ctx.answerCallbackQuery();
  const prompts={payment_card_number:'Karta raqamini yuboring:',payment_card_holder:'Karta egasining ism-familiyasini yuboring:',payment_price_uzs:'Narxni so‘mda raqam bilan yuboring:',payment_review_chat_id:'Chek kanali postini menga forward qiling:'};
  await ctx.reply(prompts[key]);
});
bot.on('message:text', async (ctx,next)=>{
  const key=adminInputState.get(String(ctx.from?.id));
  if(!key||Number(ctx.from?.id)!==Number(ADMIN_TELEGRAM_ID)||ctx.message.text.startsWith('/')) return next();
  const value=ctx.message.text.trim();
  if(key==='payment_price_uzs'&&(!/^\d+$/.test(value)||Number(value)<=0)) return ctx.reply('Narxni musbat raqamda kiriting.');
  if(key==='payment_card_number'&&!/^[0-9 ]{12,25}$/.test(value)) return ctx.reply('Karta raqamini tekshirib qayta yuboring.');
  if(key==='payment_review_chat_id') return next();
  await db.query('insert into public.slayd_settings(setting_key,setting_value,updated_by,updated_at) values($1,$2,$3,now()) on conflict(setting_key) do update set setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=now()',[key,value,Number(ctx.from.id)]);
  adminInputState.delete(String(ctx.from.id)); await ctx.reply('Saqlandi. /admin orqali davom eting.');
});

bot.command("stats", async (ctx) => {
  const adminId = ADMIN_TELEGRAM_ID ? Number(ADMIN_TELEGRAM_ID) : null;
  if (!adminId || Number(ctx.from?.id) !== adminId) {
    return ctx.reply("⛔ Bu buyruq faqat administrator uchun.");
  }
  if (!db) return ctx.reply("❌ Baza ulanmagan. DATABASE_URL sozlamasini tekshiring.");
  try {
    const result = await db.query(`
      select
        (select count(*)::int from public.slayd_users) as users_total,
        (select count(*)::int from public.slayd_users where (created_at at time zone 'Asia/Tashkent')::date = (now() at time zone 'Asia/Tashkent')::date) as users_today,
        (select count(*)::int from public.slayd_projects) as projects_total,
        (select count(*)::int from public.slayd_projects where (created_at at time zone 'Asia/Tashkent')::date = (now() at time zone 'Asia/Tashkent')::date) as projects_today,
        (select count(*)::int from public.slayd_projects where status = 'completed') as projects_completed,
        (select count(*)::int from public.slayd_projects where status = 'failed') as projects_failed,
        (select count(*)::int from public.slayd_projects where status = 'awaiting_payment') as projects_awaiting_payment,
        (select count(*)::int from public.slayd_payments where status = 'pending') as payments_pending,
        (select count(*)::int from public.slayd_payments where status = 'paid') as payments_paid,
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
      "💳 Kutilayotgan buyurtmalar: " + s.projects_awaiting_payment + "\n" +
      "⏳ Kutilayotgan tolovlar: " + s.payments_pending + "\n" +
      "💵 Tasdiqlangan tolovlar: " + s.payments_paid + "\n" +
      "💰 Tasdiqlangan tushum: " + Number(s.revenue_uzs).toLocaleString("uz-UZ") + " so‘m"
    );
  } catch (error) {
    console.error("Admin statistika xatosi:", error);
    await ctx.reply("❌ Statistikani olishda xatolik. Baza jadvallarini tekshiring.");
  }
});



bot.command("admin", async ctx => {
 if(Number(ctx.from?.id)!==Number(ADMIN_TELEGRAM_ID)) return ctx.reply("Faqat administrator uchun.");
 const r=await db.query("select setting_key,setting_value from public.slayd_settings");
 const v=Object.fromEntries(r.rows.map(x=>[x.setting_key,x.setting_value]));
 const kb=new InlineKeyboard().text("Karta raqami","cfg:payment_card_number").row().text("Karta egasi","cfg:payment_card_holder").row().text("Narx","cfg:payment_price_uzs").row().text("Chek kanali","cfg:payment_review_chat_id");
 await ctx.reply("ADMIN PANEL\nKarta: "+(v.payment_card_number||"yo‘q")+"\nEgasi: "+(v.payment_card_holder||"yo‘q")+"\nNarx: "+(v.payment_price_uzs||"yo‘q")+" so‘m\nChek kanali: "+(v.payment_review_chat_id||"yo‘q"),{reply_markup:kb});
});

bot.command('payment', async ctx => {
 if(Number(ctx.from?.id)!==Number(ADMIN_TELEGRAM_ID)) return ctx.reply('Faqat admin uchun.');
 const kb=new InlineKeyboard().text('Karta raqami','cfg:payment_card_number').row().text('Karta egasi','cfg:payment_card_holder').row().text('Narx','cfg:payment_price_uzs').row().text('Chek kanali','cfg:payment_review_chat_id');
 const r=await db.query('select setting_key,setting_value from public.slayd_settings');
 const v=Object.fromEntries(r.rows.map(x=>[x.setting_key,x.setting_value]));
 await ctx.reply('TO‘LOV SOZLAMALARI\\nKarta: '+(v.payment_card_number||'yo‘q')+'\\nEgasi: '+(v.payment_card_holder||'yo‘q')+'\\nNarx: '+(v.payment_price_uzs||'yo‘q')+' so‘m\\nChek kanali: '+(v.payment_review_chat_id||'yo‘q'),{reply_markup:kb});
});

bot.command("status", async (ctx) => {
  if (!ADMIN_TELEGRAM_ID || Number(ctx.from?.id) !== Number(ADMIN_TELEGRAM_ID)) {
    return ctx.reply("⛔ Bu buyruq faqat administrator uchun.");
  }
  let database = "❌ ulanmagan";
  if (db) {
    try { await db.query("select 1"); database = "✅ ulangan"; }
    catch (error) { database = "❌ xato: " + String(error.message).slice(0, 120); }
  }
  const missingClick = [
    !CLICK_SERVICE_ID && "CLICK_SERVICE_ID",
    !CLICK_MERCHANT_ID && "CLICK_MERCHANT_ID",
    !CLICK_SECRET_KEY && "CLICK_SECRET_KEY",
    !(Number.isSafeInteger(Number(SLIDE_PRICE_UZS)) && Number(SLIDE_PRICE_UZS) > 0) && "SLIDE_PRICE_UZS"
  ].filter(Boolean);
  await ctx.reply(
    "🔎 SLAYD AI — TEXNIK HOLAT\n\n" +
    "🌐 Web App URL: " + (validWebAppUrl(WEB_APP_URL) ? "✅ sozlangan" : "❌ WEB_APP_URL kerak") + "\n" +
    "🗄 Supabase: " + database + "\n" +
    "🤖 AI: " + ((GROQ_API_KEY || GEMINI_API_KEY) ? "✅ kalit bor" : "❌ kalit yo‘q") + "\n" +
    "🖼 AI rasm modeli: " + (GEMINI_API_KEY ? "Gemini" : "❌ Gemini rasm API kaliti kerak") + "\n" +
    "💳 Click: " + (missingClick.length ? "❌ " + missingClick.join(", ") : "✅ sozlangan") + "\n" +
    "📢 Majburiy kanal: " + (REQUIRED_CHANNEL ? "yoqilgan" : "o‘chirilgan") + "\n" +
    "🧪 Bepul testerlar: " + freeTesterIds.size
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply("Telegram ID raqamingiz: " + ctx.from.id + "\nBu raqamni Railway Variables ichida ADMIN_TELEGRAM_ID qiymati sifatida saqlang.");
});

// Admin kanal postini botga forward qilsa, maxfiy kanal ID sini ko'rsatadi.
bot.on("message", async (ctx, next) => {
  const origin = ctx.message?.forward_origin;
  if (origin?.type === "channel" && Number(ctx.from?.id) === Number(ADMIN_TELEGRAM_ID)) {
    adminInputState.delete(String(ctx.from.id));
    await db.query("insert into public.slayd_settings(setting_key,setting_value,updated_by,updated_at) values('payment_review_chat_id',$1,$2,now()) on conflict(setting_key) do update set setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=now()",[String(origin.chat.id),Number(ctx.from.id)]);
    await ctx.reply("Chek kanali ulandi: "+(origin.chat.title||"Kanal")+" | ID: "+origin.chat.id);
    return;
  }
  await next();
});

bot.command("start", async (ctx) => {
  if (!(await requireAccess(ctx))) return;
  const message = "👋 Assalomu alaykum! Men SLAYD AI.\n\n🎨 Taqdimot yaratish uchun Web App tugmasini bosing.\nMavzu kiriting, 8 slaydni tahrirlang, rasmlarni joylashtiring va PDFni Telegramda oling.";
  if (validWebAppUrl(WEB_APP_URL)) {
    await ctx.reply(message, { reply_markup: new InlineKeyboard().webApp("🎨 Taqdimot yaratish va tahrirlash", WEB_APP_URL) });
  } else {
    await ctx.reply(message + "\n\n⚙️ Web App uchun Railway Variables ichida WEB_APP_URL kiriting.");
  }
});
bot.command("webapp", async (ctx) => {
  if (!(await requireAccess(ctx))) return;
  if (!validWebAppUrl(WEB_APP_URL)) return ctx.reply("❌ Web App manzili sozlanmagan yoki noto‘g‘ri. Railway → Variables bo‘limida WEB_APP_URL qiymatiga xizmatning haqiqiy HTTPS domenini kiriting (masalan, https://slayd-ai-production.up.railway.app).");
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

async function generateTextUnqueued(prompt, generationConfig = {}) {
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

async function generateText(prompt, generationConfig = {}) {
  return textQueue.run(() => generateTextUnqueued(prompt, generationConfig));
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
      const visionText = await imageQueue.run(async () => {
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
        const resultText = visionPayload.choices?.[0]?.message?.content?.trim();
        if (!resultText) throw new Error("Groq Vision bo'sh javob qaytardi.");
        return resultText;
      });
      return { text: visionText, imageBuffer: buffer };
    } catch (error) {
      console.error("Groq Vision ishlamadi:", error.message);
    }
  }

  if (GEMINI_API_KEY) {
    console.log("Rasm matni: Gemini zaxira orqali o'qilmoqda.");
    const geminiText = await textQueue.run(() => geminiGenerate([{ role: "user", parts: [
      { text: "Rasmdagi matnni o'qib, taqdimot uchun muhim ma'lumotlarni o'zbek tilida ajratib ber. O'qilmagan joylarni to'qima." },
      { inlineData: { mimeType: "image/jpeg", data: base64 } }
    ] }], { maxOutputTokens: 1400 }));
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
  if (!Array.isArray(data.slides) || data.slides.length !== 8) throw new Error("AI aynan 8 ta slayd qaytarmadi. Qayta urinib ko'ring.");
  data.slides = data.slides.slice(0, 8).map((slide, i) => ({
    title: String(slide.title || "Slayd " + (i + 1)),
    bullets: (Array.isArray(slide.bullets) ? slide.bullets : []).slice(0, 5).map(String),
    speaker_notes: String(slide.speaker_notes || "")
  }));
  return data;
}


async function generateSlideImages(data, outputDir) {
  const targets=[0,2,4,6].filter(i=>data.slides[i]&&!data.slides[i].imagePath&&!data.slides[i].imageData);
  if(!targets.length)return {generated:0,failed:0};
  if(!GEMINI_API_KEY)throw new Error("Gemini rasm yaratish uchun GEMINI_API_KEY sozlanmagan.");
  let cursor=0,generated=0,failed=0;const errors=[];
  async function worker(){while(cursor<targets.length){
    const index=targets[cursor++],slide=data.slides[index];
    const prompt=[
      "Create one premium visual asset for a modern university presentation.",
      "STYLE: clean editorial student-slide references; pure white paper-like slide background, generous whitespace, restrained navy/royal-blue and teal accents, crisp geometric composition, elegant minimal art direction.",
      "This is an image asset placed inside a white 16:9 slide, NOT a complete slide or poster.",
      "Create a realistic editorial photograph or refined 3D/editorial illustration that directly explains the subject.",
      "No text, letters, numbers, captions, logos, watermark, borders or collage.",
      "Topic: "+String(data.title||"Education"),"Slide heading: "+slide.title,
      "Key ideas: "+(slide.bullets||[]).join("; "),
      "Wide landscape 16:9 composition, balanced negative space, professional lighting, clear focal subject."
    ].join("\n");
    try{await imageQueue.run(async()=>{
      const response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+GEMINI_IMAGE_MODEL+":generateContent",{
        method:"POST",headers:{"x-goog-api-key":GEMINI_API_KEY,"Content-Type":"application/json"},
        body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseModalities:["TEXT","IMAGE"]}}),
        signal:AbortSignal.timeout(90000)
      });
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error("Gemini Image API ("+response.status+"): "+(payload.error?.message||response.statusText));
      const part=(payload.candidates?.[0]?.content?.parts||[]).find(x=>x.inlineData?.data);
      if(!part)throw new Error("Gemini rasm modeli rasm qaytarmadi.");
      const mime=part.inlineData.mimeType||"image/png",bytes=Buffer.from(part.inlineData.data,"base64");
      const imagePath=path.join(outputDir,"ai-slide-"+(index+1)+(mime.includes("jpeg")?".jpg":".png"));
      fs.writeFileSync(imagePath,bytes,{flag:"wx"});slide.imagePath=imagePath;slide.imageData=bytes;slide.imageMime=mime;
      generated++;console.log("Slayd "+(index+1)+": Gemini rasmi yaratildi.");
    });}catch(error){failed++;errors.push("Slayd "+(index+1)+": "+error.message);console.error("Gemini rasm xatosi:",error.message);}
  }}
  await Promise.all([worker(),worker()]);
  console.log("Gemini rasm natijasi: "+generated+"/"+targets.length);
  if(!generated)throw new Error("Gemini slayd rasmlarini yarata olmadi. "+(errors[0]||"Rasm API kvotasi yoki modelni tekshiring."));
  return {generated,failed,errors};
}

function createPdf(data, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [960, 540], margin: 0, info: { Title: data.title || "Taqdimot", Author: "Taqdimot" } });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    const C = { ink:"#182230", muted:"#667085", blue:"#315EFB", teal:"#16A6A6", paper:"#FFFFFF", soft:"#F4F7FC", line:"#E7ECF3", pale:"#EEF3FF", paleTeal:"#EAF8F7", white:"#FFFFFF" };
    const safe = v => String(v || "").replace(/[ʻʼ‘’]/g, "'").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[\u{1F300}-\u{1FAFF}]/gu, "");
    const hasImage = slide => Boolean(slide.imagePath && fs.existsSync(slide.imagePath));
    const addImage = (slide,x,y,w,h) => {
      if (!hasImage(slide)) return false;
      try {
        doc.save().roundedRect(x,y,w,h,16).clip();
        doc.image(slide.imagePath,x,y,{fit:[w,h],align:"center",valign:"center"});
        doc.restore();
        return true;
      } catch(e) { doc.restore(); console.warn("PDF image:",e.message); return false; }
    };
    data.slides.forEach((slide,index) => {
      if(index) doc.addPage({size:[960,540],margin:0});
      doc.rect(0,0,960,540).fill(C.paper);
      const cover=index===0;
      if(cover) {
        doc.rect(0,0,12,540).fill(C.blue);
        doc.fillColor(C.blue).font("Helvetica-Bold").fontSize(11).text("TAQDIMOT",64,52,{characterSpacing:1.7});
        doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(39).text(safe(slide.title||data.title||"Taqdimot"),64,116,{width:hasImage(slide)?475:720,height:150,ellipsis:true,lineGap:5});
        doc.roundedRect(65,284,78,5,2).fill(C.teal);
        doc.fillColor(C.muted).font("Helvetica").fontSize(17).text(safe(data.subtitle||"Mavzu bo'yicha tayyorlangan taqdimot"),65,310,{width:hasImage(slide)?440:680,height:55,ellipsis:true});
        (slide.bullets||[]).slice(0,3).forEach((v,i)=>{
          const y=390+i*30;
          doc.circle(72,y+7,3).fill(i%2?C.teal:C.blue);
          doc.fillColor(C.muted).font("Helvetica").fontSize(12).text(safe(v),87,y,{width:hasImage(slide)?420:690,height:20,ellipsis:true});
        });
        if(hasImage(slide)) addImage(slide,575,105,315,300);
        doc.moveTo(64,485).lineTo(896,485).strokeColor(C.line).lineWidth(1).stroke();
        doc.fillColor(C.muted).font("Helvetica").fontSize(10).text("TAQDIMOT",64,502);
        doc.text("01 / 08",820,502,{width:76,align:"right"});
      } else {
        const image=hasImage(slide);
        const imageLeft=image&&slide.imagePosition==="left";
        doc.fillColor(C.blue).font("Helvetica-Bold").fontSize(10).text("TAQDIMOT",58,34,{characterSpacing:1.4});
        doc.fillColor(C.muted).font("Helvetica-Bold").fontSize(10).text("BO'LIM  "+String(index).padStart(2,"0"),790,34,{width:110,align:"right"});
        doc.fillColor(C.ink).font("Helvetica-Bold").fontSize(29).text(safe(slide.title),58,75,{width:844,height:70,ellipsis:true});
        doc.roundedRect(58,151,68,4,2).fill(index%2?C.teal:C.blue);
        const bullets=(slide.bullets||[]).filter(Boolean).slice(0,5);
        const list=bullets.length?bullets:["Ushbu bo'lim bo'yicha qo'shimcha ma'lumot."];
        const cardX=image?(imageLeft?330:58):58;
        const cardW=image?572:844;
        const top=184,gap=11,cardH=Math.min(76,(278-gap*(list.length-1))/list.length);
        list.forEach((item,j)=>{
          const y=top+j*(cardH+gap);
          doc.roundedRect(cardX,y,cardW,cardH,12).fill(j%2?C.soft:C.pale);
          doc.circle(cardX+30,y+cardH/2,12).fill(j%2?C.paleTeal:"#DDE7FF");
          doc.fillColor(j%2?C.teal:C.blue).font("Helvetica-Bold").fontSize(9).text(String(j+1).padStart(2,"0"),cardX+21,y+cardH/2-3,{width:18,align:"center"});
          doc.fillColor(C.ink).font("Helvetica").fontSize(cardH<53?12:14).text(safe(item),cardX+55,y+11,{width:cardW-75,height:cardH-16,ellipsis:true,lineGap:3});
        });
        if(image) addImage(slide,imageLeft?58:650,184,242,278);
        doc.moveTo(58,492).lineTo(902,492).strokeColor(C.line).lineWidth(1).stroke();
        doc.fillColor(C.muted).font("Helvetica").fontSize(9).text("O‘QUV TAQDIMOTI",58,505);
        doc.fillColor(C.muted).font("Helvetica-Bold").fontSize(10).text(String(index+1).padStart(2,"0")+" / "+String(data.slides.length).padStart(2,"0"),820,503,{width:80,align:"right"});
      }
    });
    stream.on("finish",resolve);
    stream.on("error",reject);
    doc.on("error",reject);
    doc.end();
  });
}

async function generateAndSend(ctx, source, options = {}) {
  const status = await ctx.reply("⏳ Taqdimotingiz tayyorlanmoqda. Biroz kuting...");
  const jobId = String(ctx.from.id) + "-" + Date.now() + "-" + Math.random().toString(36).slice(2,8);
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "slayd-bot-" + jobId + "-"));
  const outputPath = path.join(jobDir, "slayd-ai-taqdimot.pdf");
  let projectId = null;
  try {
    if (db) {
      const dailyLimit = Number(ctx.from.id) === Number(ADMIN_TELEGRAM_ID) ? 100 : 25;
      const daily = await db.query("select count(*)::int as n from public.slayd_projects where telegram_user_id=$1 and created_at>now()-interval '24 hours'", [Number(ctx.from.id)]);
      if (Number(daily.rows[0].n) >= dailyLimit) throw new Error("Kunlik sinov taqdimotlari limiti tugadi.");
      const project = await db.query(
        "insert into public.slayd_projects (telegram_user_id,topic,file_name,input_type,image_mode,status,slide_count) values ($1,$2,$3,$4,$5,'generating',8) returning id",
        [Number(ctx.from.id), String(source).slice(0,12000), "slayd-ai-taqdimot.pdf", options.imageBuffer ? "image" : "topic", options.imageBuffer ? "user" : "ai"]
      );
      projectId = project.rows[0].id;
    }
    console.log("Taqdimot: Groq asosiy, Gemini zaxira AI so'rovi boshlandi.");
    const data = await makeSlides(source);
    if (options.imageBuffer) {
      const sourceImagePath = path.join(jobDir, "telegram-source.jpg");
      fs.writeFileSync(sourceImagePath, options.imageBuffer, { flag: "wx" });
      data.slides[0].imagePath = sourceImagePath;
    }
    if (db && projectId) {
      const client = await db.connect();
      try {
        await client.query("begin");
        for (let i = 0; i < data.slides.length; i++) {
          const slide = data.slides[i];
          const imageData = slide.imagePath && fs.existsSync(slide.imagePath) ? fs.readFileSync(slide.imagePath) : null;
          const imageMime = slide.imagePath && slide.imagePath.toLowerCase().endsWith(".jpg") ? "image/jpeg" : (imageData ? "image/png" : null);
          await client.query(
            "insert into public.slayd_slides (project_id,slide_number,title,body,speaker_notes,image_data,image_mime) values ($1,$2,$3,$4,$5,$6,$7)",
            [projectId, i + 1, slide.title, (slide.bullets || []).join("\n"), slide.speaker_notes || "", imageData, imageMime]
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    await createPdf(data, outputPath);
    await ctx.replyWithDocument(new InputFile(outputPath, "slayd-ai-taqdimot.pdf"), {
      caption: "✅ Taqdimotingiz tayyor!"
    });
    if (db && projectId) await db.query("update public.slayd_projects set status='completed',pdf_path=$1,updated_at=now() where id=$2", ["slayd-ai-taqdimot.pdf", projectId]);
    if (db && projectId) { try { await db.query("update public.slayd_slides set image_data=null,image_mime=null where project_id=$1", [projectId]); } catch (cleanupError) { console.warn("Slide image cleanup:", cleanupError.message); } }
  } catch (error) {
    if (db && projectId) {
      try { await db.query("update public.slayd_projects set status='failed',error_message=$1,updated_at=now() where id=$2", [String(error.message).slice(0,1000), projectId]); } catch (_) {}
    }
    throw error;
  } finally {
    try { await ctx.api.deleteMessage(ctx.chat.id, status.message_id); } catch (_) {}
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}
bot.on("message:text", async (ctx) => {
  if (!(await requireAccess(ctx))) return;
  if (!isFreeTester(ctx.from.id)) return ctx.reply("Oddiy foydalanuvchilar taqdimotni Web App orqali yaratib, Click orqali tolov qiladi. /webapp buyrugini bosing.");
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

bot.callbackQuery(/^receipt:(SLD-[A-Z0-9]+)$/i,async ctx=>{
 try{
  if(!db)return ctx.answerCallbackQuery({text:"Baza ulanmagan.",show_alert:true});
  const order=ctx.match[1];
  const r=await db.query("select order_code from public.slayd_payments where order_code=$1 and telegram_user_id=$2 and provider='manual' and status='pending' order by created_at desc limit 1",[order,Number(ctx.from.id)]);
  if(!r.rowCount)return ctx.answerCallbackQuery({text:"Bu buyurtma topilmadi yoki allaqachon ko‘rib chiqilgan.",show_alert:true});
  await ctx.answerCallbackQuery({text:"Chek yuborish mumkin."});
  await ctx.reply("📸 Endi to‘lov chekini rasm qilib shu chatga yuboring.\n\nChek adminga tekshirish uchun yuboriladi. Admin tasdiqlagach, PDF faylingiz shu bot chatiga keladi.");
 }catch(e){console.error("Receipt prompt:",e);await ctx.answerCallbackQuery({text:"Xatolik. Qayta urinib ko‘ring.",show_alert:true});}
});

bot.on("message:photo", async ctx => {
 if(!(await requireAccess(ctx))) return;
 if(!db) return ctx.reply("Baza ulanmagan.");
 if(!isFreeTester(ctx.from.id)){
  try {
   const r=await db.query("select id,order_code,amount_uzs from public.slayd_payments where telegram_user_id=$1 and provider='manual' and status in ('pending','rejected') order by created_at desc limit 1",[Number(ctx.from.id)]);
   if(!r.rowCount) return ctx.reply("Avval Web Appda taqdimotni yakunlang, keyin chek yuboring.");
   const ch=await db.query("select setting_value from public.slayd_settings where setting_key='payment_review_chat_id'");
   if(!ch.rowCount) return ctx.reply("Chek kanali admin tomonidan sozlanmagan.");
   const p=r.rows[0],file=ctx.message.photo[ctx.message.photo.length-1].file_id;
   await db.query("update public.slayd_payments set status='pending',receipt_file_id=$1,updated_at=now() where id=$2",[file,p.id]);
   const kb=new InlineKeyboard().text("Tasdiqlash","payok:"+p.id).text("Rad etish","payno:"+p.id);
   const sent=await bot.api.sendPhoto(ch.rows[0].setting_value,file,{caption:"YANGI CHEK\nBuyurtma: "+(p.order_code||p.id)+"\nFoydalanuvchi: "+ctx.from.id+"\nSumma: "+p.amount_uzs+" so‘m",reply_markup:kb});
   await db.query("update public.slayd_payments set review_chat_id=$1,review_message_id=$2 where id=$3",[ch.rows[0].setting_value,sent.message_id,p.id]);
   return ctx.reply("✅ Buyurtmangiz qabul qilindi! Chek admin tekshiruviga yuborildi. Admin tasdiqlagandan so‘ng PDF faylingiz shu Telegram bot chatiga yuboriladi.");
  } catch(e){console.error("Receipt:",e);return ctx.reply("Chek yuborilmadi. Qayta urinib ko‘ring.");}
 }
 const extracted=await extractImageText(ctx);
 const caption=ctx.message.caption||"";
 try { await generateAndSend(ctx,[caption,extracted.text].filter(Boolean).join("\n\n"),{imageBuffer:extracted.imageBuffer}); }
 catch(e){console.error(e);await ctx.reply("Rasmni qayta yuboring yoki mavzuni matn bilan kiriting.");}
});

bot.catch((error) => console.error("Bot xatosi:", error));
startWebApp({ bot, db, makeSlides, createPdf, generateSlideImages, InputFile, botToken: BOT_TOKEN, requiredChannel: REQUIRED_CHANNEL, freeTesterIds: FREE_TESTER_IDS, adminTelegramId: ADMIN_TELEGRAM_ID, clickServiceId: CLICK_SERVICE_ID, clickMerchantId: CLICK_MERCHANT_ID, clickMerchantUserId: CLICK_MERCHANT_USER_ID, clickSecretKey: CLICK_SECRET_KEY, slidePriceUzs: SLIDE_PRICE_UZS, webAppUrl: WEB_APP_URL });
async function startBotWithRetry() {
  while (true) {
    try {
      await bot.start();
      return;
    } catch (error) {
      console.error("Telegram polling xatosi:", error);
      if (error?.error_code === 409) {
        console.error("409 Conflict: shu BOT_TOKEN boshqa jarayonda ishlayapti. Web App serveri ishlashda davom etadi; 15 soniyadan keyin bot qayta ulanadi.");
      }
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
  }
}
startBotWithRetry().catch(error => console.error("Bot ishga tushirish xatosi:", error));
console.log("SLAYD AI bot va Web App ishga tushdi.");
