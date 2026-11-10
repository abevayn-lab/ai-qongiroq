# SLAYD AI

Telegram bot that turns a student's topic or a photo of an assignment/book page into an 8-slide presentation PDF.

## Requirements
- Node.js 20+
- Telegram bot token from @BotFather
- OpenAI API key

## Setup
1. Copy `.env.example` to `.env`.
2. Add `BOT_TOKEN` and `OPENAI_API_KEY`.
3. Install dependencies: `npm install`
4. Start: `npm start`

The bot accepts either a text topic or a photo with an optional caption. It generates an 8-slide landscape PDF and sends it back in Telegram.

## Notes
- Never commit your real `.env` file.
- The first MVP creates clean text-based slides. Uploaded photos are used as source material, not embedded as slide backgrounds.
