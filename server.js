const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- НАСТРОЙКИ ---
const CRYPTOBOT_TOKEN = "667032:AAXp9fqUaWylsUDxBwlSdiiVNLuaL7YM4Qi";
const PRICE_PER_50 = 2.31;
const API_URL = "https://pay.crypt.bot/api/";

// НАСТРОЙКИ GITHUB ДЛЯ БЭКАПА
const GITHUB_TOKEN = "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";
const GITHUB_REPO = "yappiuxl/oxidegrade"; // Твой репозиторий
const DB_PATH = path.join(__dirname, 'database.sqlite');

// --- ПОДКЛЮЧЕНИЕ К SQLITE ---
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS players (
    user_id TEXT PRIMARY KEY,
    coins REAL DEFAULT 0,
    inventory TEXT DEFAULT '[]',
    promo_used TEXT DEFAULT '[]'
  )`);
});

// Функция для отправки базы в GitHub (чтобы она не удалилась при перезагрузке Render)
async function backupDB() {
  if (!GITHUB_TOKEN || GITHUB_TOKEN === "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") return;
  try {
    const fileContent = fs.readFileSync(DB_PATH).toString('base64');
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/database.sqlite`;

    let sha = null;
    const getRes = await fetch(url, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
    });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }

    const body = {
      message: `Auto-backup database ${new Date().toISOString()}`,
      content: fileContent,
      branch: 'main'
    };
    if (sha) body.sha = sha;

    await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    console.log("✅ База сохранена в GitHub");
  } catch (e) {
    console.error("Ошибка бэкапа:", e);
  }
}

// --- ПРОМОКОДЫ ---
let promos = {
  "oxide": { coins: 5, usesLeft: 5 }
};

app.post('/api/apply-promo', (req, res) => {
  const { code, userId } = req.body;
  if (!code) return res.json({ status: "invalid", message: "Промокод неверный" });
  
  const promo = promos[code.toLowerCase()];
  if (!promo) return res.json({ status: "invalid", message: "Промокод неверный" });
  if (promo.usesLeft <= 0) return res.json({ status: "limit", message: "У промокода закончились активации" });

  db.get('SELECT * FROM players WHERE user_id = ?', [userId], (err, user) => {
    if (err) return res.json({ status: "invalid", message: "Ошибка БД" });

    if (!user) {
      db.run('INSERT INTO players (user_id, coins, inventory, promo_used) VALUES (?, 0, ?, ?)', [userId, '[]', '[]'], function(err) {
        if (err) return res.json({ status: "invalid", message: "Ошибка БД" });
        user = { user_id: userId, coins: 0, promo_used: '[]' };
        processPromo(user);
      });
    } else {
      processPromo(user);
    }
  });

  function processPromo(user) {
    const promoUsed = JSON.parse(user.promo_used || '[]');
    if (promoUsed.includes(code.toLowerCase())) {
      return res.json({ status: "invalid", message: "Вы уже использовали этот промокод" });
    }

    promo.usesLeft--;
    const newCoins = Number(user.coins) + promo.coins;
    const newPromoUsed = JSON.stringify([...promoUsed, code.toLowerCase()]);
    
    db.run('UPDATE players SET coins = ?, promo_used = ? WHERE user_id = ?', [newCoins, newPromoUsed, user.user_id], (err) => {
      if (err) return res.json({ status: "invalid", message: "Ошибка БД" });
      backupDB(); // Сохраняем базу в GitHub
      res.json({ status: "success", message: `Промокод использован, +${promo.coins} монет. Можете возвращаться в игру`, coins: promo.coins });
    });
  }
});

// --- КАССА ---
const pendingInvoices = {}; 

app.post('/api/create-invoice', async (req, res) => {
  const { coins, userId } = req.body;
  if (!coins || coins < 50) return res.status(400).json({ error: "Минимум 50 монет" });

  const usdAmount = (coins / 50) * PRICE_PER_50;

  try {
    const response = await fetch(API_URL + 'createInvoice', {
      method: 'POST',
      headers: { 'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN, 'Content-Type': 'application/json' },
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
      
      db.get('SELECT * FROM players WHERE user_id = ?', [userId], (err, user) => {
        if (!user) {
          db.run('INSERT INTO players (user_id, coins, inventory) VALUES (?, ?, ?)', [userId, coins, '[]'], () => backupDB());
        } else {
          const newCoins = Number(user.coins) + coins;
          db.run('UPDATE players SET coins = ? WHERE user_id = ?', [newCoins, userId], () => backupDB());
        }
      });
      
      delete pendingInvoices[invoiceId];
    }
  }
  res.sendStatus(200);
});

// --- СИНХРОНИЗАЦИЯ С ИГРОЙ ---
app.get('/api/get-player/:userId', (req, res) => {
  db.get('SELECT * FROM players WHERE user_id = ?', [req.params.userId], (err, user) => {
    if (!user) {
      db.run('INSERT INTO players (user_id, coins, inventory) VALUES (?, 0, ?)', [req.params.userId, '[]'], function(err) {
        res.json({ coins: 0, inventory: [] });
      });
    } else {
      res.json({ coins: Number(user.coins), inventory: JSON.parse(user.inventory || '[]') });
    }
  });
});

app.post(`/api/tg-webhook`, async (req, res) => {
  const msg = req.body.message;
  if (!msg || !msg.text) return res.sendStatus(200);
  
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text.startsWith("/start")) {
    // Ссылка на игру с ID игрока
    const gameUrl = `https://oxidegrade-dmfx.onrender.com/?id=${chatId}`;
    
    const replyText = `Добро пожаловать в Oxidegrade!\n\nВаш ID: ${chatId}\n\nНажмите кнопку ниже, чтобы начать играть:`;
    
    await fetch(`https://api.telegram.org/bot${9161757246:AAEbwTof-v6cNhP6jI7mFeziirqgCK_PdwQ}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyText,
        reply_markup: {
          inline_keyboard: [[ { text: "🎮 Играть", url: gameUrl } ]]
        }
      })
    });
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
