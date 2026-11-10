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
const TG_BOT_TOKEN = "9161757246:AAEbwTof-v6cNhP6jI7mFeziirqgCK_PdwQ";
const PRICE_PER_50 = 2.31;
const API_URL = "https://pay.crypt.bot/api/";

const GITHUB_TOKEN = "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";
const GITHUB_REPO = "yappiuxl/oxidegrade";
const DB_PATH = path.join(__dirname, 'database.sqlite');

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS players (
    user_id TEXT PRIMARY KEY,
    coins REAL DEFAULT 0,
    inventory TEXT DEFAULT '[]',
    promo_used TEXT DEFAULT '[]',
    weekly_deposit REAL DEFAULT 0,
    reward_stage INTEGER DEFAULT 1,
    last_reward_week TEXT DEFAULT ''
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    item_name TEXT,
    item_price REAL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

async function backupDB() {
  if (!GITHUB_TOKEN) return;
  try {
    const fileContent = fs.readFileSync(DB_PATH).toString('base64');
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/database.sqlite`;
    let sha = null;
    const getRes = await fetch(url, { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } });
    if (getRes.ok) { const data = await getRes.json(); sha = data.sha; }
    const body = { message: `Auto-backup`, content: fileContent, branch: 'main' };
    if (sha) body.sha = sha;
    await fetch(url, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { console.error("Backup error:", e); }
}

// Вспомогательная функция для получения текущей недели (ISO)
function getWeekKey() {
  const d = new Date();
  const day = d.getUTCDay() || 7; // 1-7 (Пн-Вс)
  d.setUTCDate(d.getUTCDate() + 4 - day); // Четверг текущей недели
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo}`;
}

// --- НАГРАДЫ ---
const REWARDS = {
  1: { need: 10, type: "item", item: "Ткань" },
  2: { need: 20, type: "choice", items: ["Кодовый замок", "МВК"] },
  3: { need: 50, type: "choice", items: ["Печь", "Железная дверь"] },
  4: { need: 100, type: "item", item: "Костяной нагрудник" }
};

app.get('/api/reward-status/:userId', (req, res) => {
  db.get('SELECT * FROM players WHERE user_id = ?', [req.params.userId], (err, user) => {
    if (!user) return res.json({ error: "User not found" });
    
    const currentWeek = getWeekKey();
    const stage = user.reward_stage || 1;
    const rewardConfig = REWARDS[stage] || REWARDS[1];
    
    // Если неделя сменилась, сбрасываем счетчик
    let weeklyDeposit = user.weekly_deposit || 0;
    let lastWeek = user.last_reward_week || '';
    let canClaim = false;
    
    if (lastWeek !== currentWeek) {
      // Новая неделя, сбрасываем прогресс
      weeklyDeposit = 0;
      canClaim = false;
    } else {
      canClaim = weeklyDeposit >= rewardConfig.need;
    }
    
    res.json({ 
      stage, 
      need: rewardConfig.need, 
      current: weeklyDeposit, 
      type: rewardConfig.type,
      items: rewardConfig.items || [rewardConfig.item],
      canClaim: canClaim
    });
  });
});

app.post('/api/claim-reward', (req, res) => {
  const { userId, choiceItem } = req.body;
  db.get('SELECT * FROM players WHERE user_id = ?', [userId], (err, user) => {
    if (!user) return res.status(400).json({ error: "User not found" });
    
    const currentWeek = getWeekKey();
    const stage = user.reward_stage || 1;
    const rewardConfig = REWARDS[stage] || REWARDS[1];
    
    if (user.last_reward_week !== currentWeek) return res.status(400).json({ error: "Week changed" });
    if ((user.weekly_deposit || 0) < rewardConfig.need) return res.status(400).json({ error: "Not enough deposit" });
    
    let itemToGive = rewardConfig.item;
    if (rewardConfig.type === "choice") {
      if (!choiceItem || !rewardConfig.items.includes(choiceItem)) return res.status(400).json({ error: "Invalid choice" });
      itemToGive = choiceItem;
    }
    
    const inventory = JSON.parse(user.inventory || '[]');
    // Находим предмет в базе, чтобы взять его цену и картинку
    const dbItem = PLAYERS.find(p => p.name === itemToGive);
    if (dbItem) inventory.push(dbItem);
    
    const nextStage = stage >= 4 ? 4 : stage + 1; // На 4 стейдже остаемся
    const nextWeek = getNextWeekKey();
    
    db.run('UPDATE players SET inventory = ?, weekly_deposit = 0, reward_stage = ?, last_reward_week = ? WHERE user_id = ?', 
      [JSON.stringify(inventory), nextStage, nextWeek, userId], (err) => {
        if (err) return res.status(500).json({ error: "DB Error" });
        backupDB();
        res.json({ success: true, item: itemToGive });
      });
  });
});

function getNextWeekKey() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo}`;
}

// --- ДЕПОЗИТ (изменен, чтобы считать недельный) ---
app.post('/api/cryptobot-webhook', (req, res) => {
  const update = req.body;
  if (update.update_type === "invoice_paid") {
    const invoice = update.payload;
    const invoiceId = invoice.invoice_id;
    if (pendingInvoices[invoiceId]) {
      const { coins, userId } = pendingInvoices[invoiceId];
      
      const currentWeek = getWeekKey();
      
      db.get('SELECT * FROM players WHERE user_id = ?', [userId], (err, user) => {
        if (!user) {
          db.run('INSERT INTO players (user_id, coins, inventory, weekly_deposit, last_reward_week) VALUES (?, ?, ?, ?, ?)', 
            [userId, coins, '[]', coins, currentWeek], () => backupDB());
        } else {
          const newCoins = Number(user.coins) + coins;
          // Если неделя та же — прибавляем, если новая — ставим только эту сумму
          const isSameWeek = user.last_reward_week === currentWeek;
          const newDeposit = isSameWeek ? (Number(user.weekly_deposit) + coins) : coins;
          
          db.run('UPDATE players SET coins = ?, weekly_deposit = ?, last_reward_week = ? WHERE user_id = ?', 
            [newCoins, newDeposit, currentWeek, userId], () => backupDB());
        }
      });
      delete pendingInvoices[invoiceId];
    }
  }
  res.sendStatus(200);
});

// ... остальные маршруты (баланс, сохранение, промокоды, вывод, телеграм вебхук) оставляем как были ...

// Для примера, я оставлю их краткими
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

// ... остальные app.post('/api/save-player'), app.post('/api/apply-promo'), app.post('/api/request-withdraw') ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
