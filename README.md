# SLAYD AI

Telegram bot + Telegram Web App for creating, editing and delivering 8-slide PDF presentations.

## Stack
- Node.js 20+
- grammY Telegram bot
- Express Web App API
- PostgreSQL on Supabase
- Groq text generation with Gemini fallback
- Gemini image generation (optional)
- PDFKit PDF rendering
- Click Shop API payment callbacks

## Required Railway variables
- \`BOT_TOKEN\` — Telegram bot token
- \`DATABASE_URL\` — Supabase PostgreSQL connection string (pooler URL is supported)
- \`ADMIN_TELEGRAM_ID\` — numeric Telegram ID of the owner
- \`WEB_APP_URL\` — HTTPS public Railway domain, e.g. \`https://your-app.up.railway.app\`
- At least one text provider: \`GROQ_API_KEY\` or \`GEMINI_API_KEY\`

## AI variables
- \`GROQ_API_KEY\`
- \`GROQ_MODEL\` (default: \`openai/gpt-oss-120b\`)
- \`GEMINI_API_KEY\`
- \`GEMINI_MODEL\` (default: \`gemini-3.8-flash\`)
- \`GEMINI_IMAGE_MODEL\` (default: \`gemini-3.1-flash-lite-image\`)

When Gemini image generation is available, the service creates visuals for selected slides (1, 3, 5 and 7). User-uploaded slide images take priority. If image generation is unavailable or quota-limited, the PDF still completes with text and uploaded images.

## Free admin and test accounts
- The account in \`ADMIN_TELEGRAM_ID\` is free automatically.
- Add comma-separated numeric Telegram IDs to \`FREE_TESTER_IDS\` for temporary free test accounts.
- Send \`/id\` from a Telegram account to see its numeric ID.
- Regular users can prepare a deck in the Web App and must pay through Click before the PDF is delivered.

## Optional channel subscription
- \`REQUIRED_CHANNEL\` — channel username such as \`@mychannel\` or numeric channel ID
- \`REQUIRED_CHANNEL_URL\` — public invite/channel URL shown to users
- Leave both blank to disable the subscription gate.
- The bot must be an administrator in the required channel so Telegram can verify membership.

## Click payment
Set these values only after Click merchant onboarding:
- \`CLICK_SERVICE_ID\`
- \`CLICK_MERCHANT_ID\`
- \`CLICK_MERCHANT_USER_ID\` (kept for merchant account configuration)
- \`CLICK_SECRET_KEY\` — secret; keep only in Railway Variables
- \`SLIDE_PRICE_UZS\` — integer price in UZS

Configure both Click Shop API Prepare and Complete callback URLs as:

\`https://YOUR-RAILWAY-DOMAIN/api/click\`

The callback validates Click signatures and payment amount. A PDF is delivered only after a verified successful Complete callback. If Click is not configured, regular users cannot receive a free PDF; admin and allowlisted test accounts remain free.

## Telegram Web App setup
1. Generate a public HTTPS domain for the Railway service.
2. Set \`WEB_APP_URL\` to that exact domain.
3. Use BotFather \`/setdomain\` and register the same domain for the bot.
4. Open the bot and press **Taqdimot yaratish va tahrirlash**.

The Web App authenticates requests with Telegram Web App initData. Do not expose the database password or Click secret in frontend code.

## Health and deployment
- Railway start command: \`npm start\`
- Health check: \`GET /health\`
- GitHub Actions checks JavaScript syntax on every push.
- Railway should deploy the \`main\` branch after successful commits.

## Data isolation
Each project is owned by its Telegram user ID. The Web App verifies the Telegram signature and checks project ownership before editing/finalizing. Database transactions use a dedicated PostgreSQL client. Uploaded and generated slide images are stored as bytea in the SLAYD AI tables. RLS is enabled; database access is server-side only.
