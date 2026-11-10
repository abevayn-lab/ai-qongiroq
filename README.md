# AI Qo'ng'iroq

Telegram bot for paid birthday greeting call requests. The first version collects order details and payment proof, then lets an administrator approve or reject the payment.

## Setup
1. Copy `.env.example` to `.env`.
2. Set `BOT_TOKEN` from BotFather.
3. Set `ADMIN_TELEGRAM_ID` to your numeric Telegram user ID.
4. Add a PostgreSQL `DATABASE_URL`.
5. Set payment card details and `CALL_PRICE_UZS`.
6. Run `npm install && npm start`.

The app exposes `/health` and listens on `PORT`.

## Customer flow
- Start with `/start`; create an order using `/buyurtma`.
- Enter recipient name and Uzbekistan (+998) phone number.
- Confirm that the recipient has agreed to receive an automated AI call.
- Pay manually and send the receipt photo.
- Admin reviews the receipt and approves or rejects it.

## Admin
Use `/admin` in Telegram to view order counts. New receipts are sent to the configured admin account with approve/reject buttons.

## Phone calls
**Outbound calls are not enabled yet.** Before calls can be placed, connect a legitimate telephony/SIP provider supporting calls to Uzbekistan (+998), verify the caller ID/number, and connect an AI speech service. Do not place calls without recipient consent. Payment approval does not mean a call has been placed.
