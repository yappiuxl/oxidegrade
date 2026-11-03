const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const CRYPTOBOT_TOKEN = "ТВОЙ_ТОКЕН_ОТ_CRYPTOBOT";
const PRICE_PER_50 = 2.31;
const API_URL = "https://pay.crypt.bot/api/";

// Временное хранилище (в оперативке)
const pendingInvoices = {}; 
const userBalances = {}; 

// 1. Создание счета
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

// 2. Вебхук (сюда приходит сигнал об оплате)
app.post('/api/cryptobot-webhook', (req, res) => {
  const update = req.body;
  
  if (update.update_type === "invoice_paid") {
    const invoice = update.payload;
    const invoiceId = invoice.invoice_id;

    if (pendingInvoices[invoiceId]) {
      const { coins, userId } = pendingInvoices[invoiceId];
      
      // Начисляем монеты пользователю
      if (!userBalances[userId]) userBalances[userId] = 0;
      userBalances[userId] += coins;
      
      console.log(`✅ Пользователь ${userId} купил ${coins} монет. Новый баланс: ${userBalances[userId]}`);
      delete pendingInvoices[invoiceId];
    }
  }
  res.sendStatus(200);
});

// 3. Получить баланс (игра запрашивает при заходе)
app.get('/api/balance/:userId', (req, res) => {
  res.json({ coins: userBalances[req.params.userId] || 0 });
});

// 4. Сохранить баланс (когда игрок продает/покупает в игре)
app.post('/api/update-balance', (req, res) => {
  const { userId, coins } = req.body;
  userBalances[userId] = coins;
  res.json({ success: true });
});

// --- ПРОМОКОДЫ ---
let promos = {
  "oxide": { coins: 5, usesLeft: 5 }
};

app.post('/api/apply-promo', (req, res) => {
  const { code, userId } = req.body;
  const promo = promos[code.toLowerCase()];

  if (!promo) return res.json({ status: "invalid", message: "Промокод неверный" });
  if (promo.usesLeft <= 0) return res.json({ status: "limit", message: "У промокода закончились активации" });

  // Активация
  promo.usesLeft--;
  if (!userBalances[userId]) userBalances[userId] = 0;
  userBalances[userId] += promo.coins;

  res.json({ 
    status: "success", 
    message: `Промокод использован, +${promo.coins} монет. Можете возвращаться в игру`,
    coins: promo.coins
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
