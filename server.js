const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const CRYPTOBOT_TOKEN = "666950:AAwEKoxn7wiMgilNQp0hwtNSmmwB04hhYLz";
const PRICE_PER_50 = 2.31;
const API_URL = "https://pay.crypt.bot/api/";

const pendingInvoices = {}; 
const userBalances = {}; 

app.post('/api/create-invoice', async (req, res) => {
  const { coins, userId } = req.body;
  if (!coins || coins < 50) return res.status(400).json({ error: "Минимум 50 монет" });

  const usdAmount = (coins / 50) * PRICE_PER_50;

  try {
    const response = await fetch(API_URL + 'createInvoice', {
      method: 'POST',
      headers: {
        'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        asset: "USDT",
        amount: usdAmount.toFixed(2),
        description: `Покупка ${coins} монет в Oxidegrade`,
        payload: JSON.stringify({ coins, userId })
      })
    });

    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Ошибка API");

    const invoice = data.result;
    pendingInvoices[invoice.invoice_id] = { coins, userId };

    res.json({ payUrl: invoice.bot_invoice_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка создания счета" });
  }
});

app.post('/api/cryptobot-webhook', (req, res) => {
  const update = req.body;
  if (update.update_type === "invoice_paid") {
    const invoice = update.payload;
    const invoiceId = invoice.invoice_id;

    if (pendingInvoices[invoiceId]) {
      const { coins, userId } = pendingInvoices[invoiceId];
      if (!userBalances[userId]) userBalances[userId] = 0;
      userBalances[userId] += coins;
      delete pendingInvoices[invoiceId];
    }
  }
  res.sendStatus(200);
});

app.get('/api/balance/:userId', (req, res) => {
  res.json({ coins: userBalances[req.params.userId] || 0 });
});

app.post('/api/update-balance', (req, res) => {
  const { userId, coins } = req.body;
  userBalances[userId] = coins;
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
