require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const { Telegraf, Markup, session } = require("telegraf");

const required = ["BOT_TOKEN", "ADMIN_TELEGRAM_ID", "DATABASE_URL"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID);
const PRICE = Number(process.env.CALL_PRICE_UZS || 25000);
const CARD_NUMBER = process.env.PAYMENT_CARD_NUMBER || "";
const CARD_HOLDER = process.env.PAYMENT_CARD_HOLDER || "Administrator";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

const app = express();
app.get("/", (_req, res) => res.status(200).send("AI Qo'ng'iroq bot is running"));
app.get("/health", (_req, res) => res.json({ ok: true }));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT NOT NULL,
      customer_username TEXT,
      recipient_name TEXT NOT NULL,
      recipient_phone TEXT NOT NULL,
      greeting_note TEXT,
      consent_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'awaiting_payment',
      payment_file_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function isUzPhone(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  return /^(998)?[0-9]{9}$/.test(digits);
}

function normalizePhone(value) {
  const digits = String(value).replace(/[^0-9]/g, "");
  return digits.startsWith("998") ? `+${digits}` : `+998${digits}`;
}

function isAdmin(ctx) {
  return ctx.from && ctx.from.id === ADMIN_ID;
}

async function sendAdminOrder(ctx, order, photoFileId) {
  const username = order.customer_username ? `@${order.customer_username}` : "yo'q";
  const message =
    `🆕 Yangi tabrik buyurtmasi #${order.id}\n\n` +
    `👤 Buyurtmachi: ${order.customer_id} (${username})\n` +
    `🎂 Tabriklanadigan inson: ${order.recipient_name}\n` +
    `📞 Telefon: ${order.recipient_phone}\n` +
    `💬 Izoh: ${order.greeting_note || "yo'q"}\n` +
    `✅ Rozilik tasdiqlangan: ha\n` +
    `💳 To'lov: ${PRICE.toLocaleString("uz-UZ")} so'm\n\n` +
    `Chekni tekshirib, buyurtmani tasdiqlang.`;

  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback("✅ To'lovni tasdiqlash", `approve:${order.id}`),
    Markup.button.callback("❌ Rad etish", `reject:${order.id}`)
  ]);
  if (photoFileId) {
    await bot.telegram.sendPhoto(ADMIN_ID, photoFileId, {
      caption: message,
      ...keyboard
    });
  } else {
    await bot.telegram.sendMessage(ADMIN_ID, message, keyboard);
  }
}

bot.start(async (ctx) => {
  ctx.session = {};
  await ctx.reply(
    "🎉 Assalomu alaykum! AI Qo'ng'iroq xizmatiga xush kelibsiz.\n\n" +
    "Biz siz tanlagan insonga telefon qilib, o'zbek tilida samimiy tabrik yetkazishga yordam beramiz.\n\n" +
    "Buyurtma berish uchun /buyurtma ni bosing. Buyurtma faqat to'lov admin tomonidan tekshirilgandan keyin tasdiqlanadi."
  );
});

bot.command("buyurtma", async (ctx) => {
  ctx.session = { step: "recipient_name" };
  await ctx.reply("🎂 Kimni tabriklaymiz? Ismini yozing:");
});

bot.command("cancel", async (ctx) => {
  ctx.session = {};
  await ctx.reply("Buyurtma bekor qilindi. Yangi buyurtma uchun /buyurtma ni bosing.");
});

bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Bu bo'lim faqat admin uchun.");
  const { rows } = await pool.query(
    "SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status ORDER BY status"
  );
  const summary = rows.map((r) => `• ${r.status}: ${r.count}`).join("\n") || "Hozircha buyurtma yo'q.";
  await ctx.reply(`📊 Buyurtmalar statistikasi\n\n${summary}`);
});

bot.on("text", async (ctx) => {
  const sessionData = ctx.session || {};
  const value = ctx.message.text.trim();

  if (isAdmin(ctx) && value === "/start") return;
  if (!sessionData.step) return;

  if (sessionData.step === "recipient_name") {
    if (value.length < 2 || value.length > 80) {
      return ctx.reply("Ismni 2 dan 80 tagacha belgida kiriting.");
    }
    sessionData.recipient_name = value;
    sessionData.step = "recipient_phone";
    return ctx.reply(
      "📞 Tabriklanadigan insonning telefon raqamini kiriting. Masalan: 901234567 yoki +998901234567"
    );
  }

  if (sessionData.step === "recipient_phone") {
    if (!isUzPhone(value)) {
      return ctx.reply("Raqam noto'g'ri. O'zbekiston raqamini kiriting: 901234567 yoki +998901234567");
    }
    sessionData.recipient_phone = normalizePhone(value);
    sessionData.step = "greeting_note";
    return ctx.reply("💬 Tabrikda alohida aytilishi kerak bo'lgan gap bormi? Bo'lmasa, «Yo'q» deb yozing.");
  }

  if (sessionData.step === "greeting_note") {
    sessionData.greeting_note = value.toLowerCase() === "yo'q" ? "" : value.slice(0, 500);
    sessionData.step = "consent";
    return ctx.reply(
      "⚠️ Muhim: qo'ng'iroq qilinadigan inson avtomatlashtirilgan AI qo'ng'irog'ini olishga roziligini bildirganmi? Faqat rozilik bo'lsa davom eting.",
      Markup.inlineKeyboard([
        Markup.button.callback("Ha, roziligi bor", "consent:yes"),
        Markup.button.callback("Yo'q", "consent:no")
      ])
    );
  }
});

bot.action("consent:no", async (ctx) => {
  ctx.session = {};
  await ctx.answerCbQuery();
  await ctx.editMessageText("Rozilik bo'lmasa, avtomatik qo'ng'iroq buyurtmasini qabul qila olmaymiz.");
});

bot.action("consent:yes", async (ctx) => {
  await ctx.answerCbQuery();
  const s = ctx.session || {};
  if (!s.recipient_name || !s.recipient_phone) {
    return ctx.reply("Buyurtma ma'lumotlari topilmadi. Qaytadan /buyurtma ni bosing.");
  }

  const { rows } = await pool.query(
    `INSERT INTO orders
      (customer_id, customer_username, recipient_name, recipient_phone, greeting_note, consent_confirmed)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     RETURNING *`,
    [ctx.from.id, ctx.from.username || null, s.recipient_name, s.recipient_phone, s.greeting_note || ""]
  );
  const order = rows[0];
  s.order_id = order.id;
  s.step = "payment_proof";

  const paymentText = CARD_NUMBER
    ? `💳 Karta: ${CARD_NUMBER}\n👤 Karta egasi: ${CARD_HOLDER}`
    : "💳 To'lov rekvizitlari hozircha admin tomonidan kiritilmagan. Admin bilan bog'laning.";

  await ctx.editMessageText(
    `✅ Ma'lumotlar qabul qilindi!\n\nBuyurtma: #${order.id}\nTabriklanadigan inson: ${order.recipient_name}\nTelefon: ${order.recipient_phone}\n\nNarx: ${PRICE.toLocaleString("uz-UZ")} so'm\n${paymentText}\n\nTo'lovni amalga oshirib, chek rasmini shu chatga yuboring. Buyurtma admin tasdiqlamaguncha faol bo'lmaydi.`
  );
});

bot.on("photo", async (ctx) => {
  const s = ctx.session || {};
  if (s.step !== "payment_proof" || !s.order_id) {
    return ctx.reply("Avval /buyurtma orqali buyurtma bering. Chekni buyurtma jarayonida yuboring.");
  }
  const fileId = ctx.message.photo.at(-1).file_id;
  const { rows } = await pool.query(
    "UPDATE orders SET payment_file_id=$1, status='pending_review', updated_at=NOW() WHERE id=$2 AND customer_id=$3 RETURNING *",
    [fileId, s.order_id, ctx.from.id]
  );
  if (!rows[0]) return ctx.reply("Buyurtma topilmadi. /buyurtma orqali qayta urinib ko'ring.");
  s.step = "awaiting_admin";
  await ctx.reply("🧾 Chek yuborildi! Admin to'lovni tekshiradi. Tasdiqlangach sizga xabar beramiz.");
  await sendAdminOrder(ctx, rows[0], fileId);
});

bot.action(/^approve:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Ruxsat yo'q", { show_alert: true });
  const id = Number(ctx.match[1]);
  const { rows } = await pool.query(
    "UPDATE orders SET status='approved', updated_at=NOW() WHERE id=$1 AND status='pending_review' RETURNING *",
    [id]
  );
  await ctx.answerCbQuery(rows[0] ? "Tasdiqlandi" : "Buyurtma topilmadi yoki oldin ko'rib chiqilgan");
  if (!rows[0]) return;
  await ctx.editMessageCaption((ctx.callbackQuery.message.caption || "") + "\n\n✅ ADMIN TASDIQLADI");
  await bot.telegram.sendMessage(
    rows[0].customer_id,
    `✅ To'lovingiz tasdiqlandi! Buyurtma #${id} qabul qilindi. Qo'ng'iroq xizmati ulanib, operator sozlamalari tayyor bo'lgach, qo'ng'iroq vaqtini kelishamiz.`
  );
});

bot.action(/^reject:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Ruxsat yo'q", { show_alert: true });
  const id = Number(ctx.match[1]);
  const { rows } = await pool.query(
    "UPDATE orders SET status='rejected', updated_at=NOW() WHERE id=$1 AND status='pending_review' RETURNING *",
    [id]
  );
  await ctx.answerCbQuery(rows[0] ? "Rad etildi" : "Buyurtma topilmadi yoki oldin ko'rib chiqilgan");
  if (!rows[0]) return;
  await ctx.editMessageCaption((ctx.callbackQuery.message.caption || "") + "\n\n❌ ADMIN RAD ETDI");
  await bot.telegram.sendMessage(
    rows[0].customer_id,
    `❌ Buyurtma #${id} bo'yicha to'lov tasdiqlanmadi. Iltimos, admin bilan bog'laning.`
  );
});

bot.catch((err) => console.error("Telegram bot error:", err));

async function main() {
  await initDb();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Health server listening on ${port}`));
  await bot.launch();
  console.log("Telegram bot started");
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
