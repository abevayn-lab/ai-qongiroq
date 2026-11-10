const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyTelegramInitData, clickSignature, fileName } = require("../src/web");

const botToken = "123456:TEST_TOKEN";
const params = new URLSearchParams({
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: "AAEAAAE",
  user: JSON.stringify({ id: 123456789, first_name: "Test" })
});
const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => k + "=" + v).join("\n");
const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
const hash = crypto.createHmac("sha256", secret).update(check).digest("hex");
const signedInitData = params.toString() + "&hash=" + hash;
assert.equal(verifyTelegramInitData(signedInitData, botToken).id, 123456789);
assert.throws(() => verifyTelegramInitData(signedInitData.replace("hash=" + hash, "hash=" + "0".repeat(64)), botToken));

const prepare = {
  click_trans_id: "123456789",
  service_id: "98765",
  merchant_trans_id: "order-abc",
  action: "0",
  amount: "5000.00",
  sign_time: "2026-11-11 00:00:00"
};
assert.equal(clickSignature(prepare, "test-secret"), "48dffd86b2d269e131daec6dc5215ce0");
const complete = { ...prepare, action: "1", merchant_prepare_id: "42" };
assert.equal(clickSignature(complete, "test-secret"), "4087358c66f6b4af8ab21cd7145aa74b");

const safe = fileName("../../test presentation?.pdf");
assert.match(safe, /\.pdf$/);
assert.doesNotMatch(safe, /[\\/]/);
console.log("Security and payment signature tests passed.");
