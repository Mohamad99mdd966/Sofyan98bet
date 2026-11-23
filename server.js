const http = require("http");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { WebSocketServer } = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "sofyan_bet_super_secret_key_change_in_prod_2026";
const JWT_EXPIRES_IN = "7d";
const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || "admin";
const DEFAULT_ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

const CARD_NUMBER = "6037997410972831";
const CARD_HOLDER = "محمد مددی صوفیانی";

// --- Persistent SQLite Database ---
const sqlite = new Database("sofyan_bet.db");
sqlite.pragma("journal_mode = WAL");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    wallet_mode TEXT NOT NULL DEFAULT 'demo',
    demo_balance INTEGER NOT NULL DEFAULT 10000000,
    real_balance INTEGER NOT NULL DEFAULT 0,
    balance INTEGER NOT NULL DEFAULT 10000000,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    amount INTEGER NOT NULL,
    receipt_ref TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    amount INTEGER NOT NULL,
    dest_card TEXT NOT NULL,
    holder_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    topic TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'عادی',
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'در انتظار بررسی',
    reply TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'demo',
    game TEXT NOT NULL,
    stake INTEGER NOT NULL,
    mult REAL NOT NULL DEFAULT 0,
    payout INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS crash_rounds (
    round_id INTEGER PRIMARY KEY,
    mult REAL NOT NULL,
    round_hash TEXT NOT NULL,
    server_seed TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

function nowTime() {
  return new Date().toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, originalHex] = storedHash.split(":");
  const originalBuf = Buffer.from(originalHex, "hex");
  const derivedBuf = crypto.scryptSync(String(password), salt, 64);
  if (originalBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(originalBuf, derivedBuf);
}

function normalizeMode(mode) {
  return mode === "real" ? "real" : "demo";
}

function ensureDefaultAdmin() {
  const existingAdmin = sqlite.prepare("SELECT id, role FROM users WHERE username = ?").get(DEFAULT_ADMIN_USER);
  if (!existingAdmin) {
    sqlite.prepare(`
      INSERT INTO users (username, password_hash, role, wallet_mode, demo_balance, real_balance, balance, created_at)
      VALUES (?, ?, 'admin', 'real', 50000000, 10000000, 10000000, ?)
    `).run(DEFAULT_ADMIN_USER, hashPassword(DEFAULT_ADMIN_PASS), new Date().toISOString());
  } else if (existingAdmin.role !== "admin") {
    sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existingAdmin.id);
  }
}
ensureDefaultAdmin();

if (sqlite.prepare("SELECT COUNT(*) AS cnt FROM tickets").get().cnt === 0) {
  sqlite.prepare(`
    INSERT INTO tickets (id, username, topic, priority, subject, message, status, reply, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "TCK-1001",
    "system",
    "واریز و کیف پول",
    "عادی",
    "راهنمای حساب دمو، کارت به کارت و برداشت واقعی",
    `شماره کارت واریز: ${CARD_NUMBER} (${CARD_HOLDER}). تمامی بازی‌ها (انفجار، مین‌روب و تاس) مستقیماً از کیف پول فعال (دمو یا واقعی) حساب می‌کنند.`,
    "پاسخ داده شده",
    "در حالت دمو با موجودی مجازی بازی کنید؛ در حالت واقعی پس از تایید فیش توسط ادمین، موجودی واقعی شارژ می‌شود.",
    nowTime()
  );
}

if (sqlite.prepare("SELECT COUNT(*) AS cnt FROM chat_messages").get().cnt === 0) {
  sqlite.prepare(`
    INSERT INTO chat_messages (id, username, text, created_at) VALUES (?, ?, ?, ?)
  `).run("m1", "saman_vip", "نسخه یکپارچه صوفیان بت (انفجار، مین‌روب، تاس و کیف پول دمو/واقعی) آماده است ✅", nowTime());
}

function getUserRow(username) {
  const row = sqlite.prepare(`
    SELECT id, username, password_hash, role, wallet_mode, demo_balance, real_balance, balance
    FROM users WHERE username = ?
  `).get(username);
  if (!row) return null;
  const mode = normalizeMode(row.wallet_mode);
  const demoBal = Math.max(0, Math.round(Number(row.demo_balance) || 0));
  const realBal = Math.max(0, Math.round(Number(row.real_balance) || 0));
  const activeBal = mode === "real" ? realBal : demoBal;
  return { ...row, wallet_mode: mode, demo_balance: demoBal, real_balance: realBal, balance: activeBal };
}

function getUserById(id) {
  const row = sqlite.prepare(`
    SELECT id, username, role, wallet_mode, demo_balance, real_balance, balance, created_at
    FROM users WHERE id = ?
  `).get(id);
  if (!row) return null;
  const mode = normalizeMode(row.wallet_mode);
  const demoBal = Math.max(0, Math.round(Number(row.demo_balance) || 0));
  const realBal = Math.max(0, Math.round(Number(row.real_balance) || 0));
  return { ...row, wallet_mode: mode, demo_balance: demoBal, real_balance: realBal, balance: mode === "real" ? realBal : demoBal };
}

function formatPublicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role || "user",
    wallet_mode: u.wallet_mode,
    demo_balance: u.demo_balance,
    real_balance: u.real_balance,
    balance: u.balance
  };
}

function setModeBalance(username, mode, nextAmount) {
  const m = normalizeMode(mode);
  const safeVal = Math.max(0, Math.round(Number(nextAmount) || 0));
  const user = getUserRow(username);
  if (!user) return null;

  const demoBal = m === "demo" ? safeVal : user.demo_balance;
  const realBal = m === "real" ? safeVal : user.real_balance;
  const activeBal = user.wallet_mode === "real" ? realBal : demoBal;

  sqlite.prepare(`
    UPDATE users SET demo_balance = ?, real_balance = ?, balance = ? WHERE username = ?
  `).run(demoBal, realBal, activeBal, username);

  return { demo_balance: demoBal, real_balance: realBal, balance: activeBal };
}

function switchWalletMode(username, nextMode) {
  const m = normalizeMode(nextMode);
  const user = getUserRow(username);
  if (!user) return null;
  const activeBal = m === "real" ? user.real_balance : user.demo_balance;
  sqlite.prepare(`
    UPDATE users SET wallet_mode = ?, balance = ? WHERE username = ?
  `).run(m, activeBal, username);
  return getUserRow(username);
}

function signToken(userRow) {
  const role = userRow.role || "user";
  return jwt.sign({ sub: userRow.id, username: userRow.username, role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyTokenSafe(token) {
  try {
    return jwt.verify(String(token || ""), JWT_SECRET);
  } catch {
    return null;
  }
}

function requireJwt(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ ok: false, message: "توکن احراز هویت (Bearer JWT) ارسال نشده است." });
  }
  const payload = verifyTokenSafe(match[1]);
  if (!payload || !payload.username) {
    return res.status(401).json({ ok: false, message: "توکن JWT نامعتبر یا منقضی شده است." });
  }
  const userRow = getUserRow(payload.username);
  if (!userRow) {
    return res.status(401).json({ ok: false, message: "کاربر مرتبط با توکن یافت نشد." });
  }
  req.authUser = formatPublicUser(userRow);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.authUser || req.authUser.role !== "admin") {
    return res.status(403).json({
      ok: false,
      message: "دسترسی غیرمجاز: این عملیات فقط برای ادمین (admin) مجاز است."
    });
  }
  next();
}

function insertBetRecord({ username, mode, game, stake, mult, payout }) {
  const safeMode = normalizeMode(mode);
  const record = {
    id: "BET-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
    username,
    mode: safeMode,
    game,
    stake: Math.round(Number(stake) || 0),
    mult: Number(Number(mult || 0).toFixed(2)),
    payout: Math.round(Number(payout) || 0),
    time: nowTime()
  };
  sqlite.prepare(`
    INSERT INTO bets (id, username, mode, game, stake, mult, payout, created_at)
    VALUES (@id, @username, @mode, @game, @stake, @mult, @payout, @time)
  `).run(record);
  return record;
}

function computeFinanceStats() {
  const depApproved = sqlite.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt
    FROM deposits WHERE status = 'approved'
  `).get();
  const depPending = sqlite.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt
    FROM deposits WHERE status = 'pending'
  `).get();

  const wdrApproved = sqlite.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt
    FROM withdrawals WHERE status = 'approved'
  `).get();
  const wdrPending = sqlite.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS cnt
    FROM withdrawals WHERE status = 'pending'
  `).get();

  const userTotals = sqlite.prepare(`
    SELECT
      COUNT(*) AS totalUsers,
      COALESCE(SUM(real_balance), 0) AS totalRealBalances,
      COALESCE(SUM(demo_balance), 0) AS totalDemoBalances
    FROM users
  `).get();

  const realBetsSummary = sqlite.prepare(`
    SELECT
      COALESCE(SUM(stake), 0) AS totalRealStake,
      COALESCE(SUM(payout), 0) AS totalRealPayout,
      COUNT(*) AS realBetsCount
    FROM bets WHERE mode = 'real'
  `).get();

  const approvedDepositsTotal = Number(depApproved?.total || 0);
  const approvedWithdrawalsTotal = Number(wdrApproved?.total || 0);
  const netCashflow = approvedDepositsTotal - approvedWithdrawalsTotal;
  const totalRealBalances = Number(userTotals?.totalRealBalances || 0);
  const netHousePosition = netCashflow - totalRealBalances;
  const realGameGrossMargin = Number(realBetsSummary?.totalRealStake || 0) - Number(realBetsSummary?.totalRealPayout || 0);

  const recentDeposits = sqlite.prepare(`
    SELECT id, username, amount, receipt_ref, status, created_at, reviewed_at
    FROM deposits ORDER BY rowid DESC LIMIT 8
  `).all();

  const recentWithdrawals = sqlite.prepare(`
    SELECT id, username, amount, dest_card, status, created_at, reviewed_at
    FROM withdrawals ORDER BY rowid DESC LIMIT 8
  `).all();

  return {
    approvedDepositsTotal,
    approvedDepositsCount: Number(depApproved?.cnt || 0),
    pendingDepositsTotal: Number(depPending?.total || 0),
    pendingDepositsCount: Number(depPending?.cnt || 0),
    approvedWithdrawalsTotal,
    approvedWithdrawalsCount: Number(wdrApproved?.cnt || 0),
    pendingWithdrawalsTotal: Number(wdrPending?.total || 0),
    pendingWithdrawalsCount: Number(wdrPending?.cnt || 0),
    netCashflow,
    totalRealBalances,
    totalDemoBalances: Number(userTotals?.totalDemoBalances || 0),
    totalUsers: Number(userTotals?.totalUsers || 0),
    netHousePosition,
    realGameGrossMargin,
    realBetsCount: Number(realBetsSummary?.realBetsCount || 0),
    recentDeposits,
    recentWithdrawals
  };
}

// --- Official Mines & Dice Session Engines ---
const activeMinesSessions = new Map();

function calcMinesMultiplier(safeRevealed, minesCount) {
  const totalTiles = 25;
  const safeTotal = totalTiles - minesCount;
  if (safeRevealed <= 0) return 1.0;
  let prob = 1;
  for (let i = 0; i < safeRevealed; i++) {
    prob *= (safeTotal - i) / (totalTiles - i);
  }
  const rawMult = 0.97 / Math.max(prob, 0.0001);
  return Number(Math.max(1.01, Math.min(100, rawMult)).toFixed(2));
}

// --- Crash Engine ---
const lastRoundRow = sqlite.prepare("SELECT MAX(round_id) AS maxId FROM crash_rounds").get();
const crashEngine = {
  roundId: (lastRoundRow?.maxId || 1000) + 1,
  phase: "waiting",
  multiplier: 1.0,
  crashPoint: 2.1,
  serverSeed: "",
  roundHash: "",
  roundBets: new Map()
};

function generateCrashRoundData(roundId) {
  const serverSeed = crypto.randomBytes(24).toString("hex");
  const roundHash = crypto.createHash("sha256").update(serverSeed + ":" + roundId).digest("hex");
  const hInt = parseInt(roundHash.slice(0, 8), 16);
  const unit = hInt / 0xffffffff;
  const crashPoint = unit < 0.03 ? 1.0 : Math.min(25, Math.max(1.0, Number((0.99 / (1 - unit)).toFixed(2))));
  return { serverSeed, roundHash, crashPoint };
}

function getCrashHistory(limit = 15) {
  return sqlite.prepare(`
    SELECT round_id AS id, mult, round_hash AS hash, created_at AS time
    FROM crash_rounds ORDER BY round_id DESC LIMIT ?
  `).all(limit);
}

function getRecentChat(limit = 40) {
  const rows = sqlite.prepare(`
    SELECT id, username AS user, text, created_at AS time
    FROM chat_messages ORDER BY rowid DESC LIMIT ?
  `).all(limit);
  return rows.reverse();
}

// --- REST Endpoints ---
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "sofyan.bet-official",
    cardNumber: CARD_NUMBER,
    cardHolder: CARD_HOLDER,
    roundId: crashEngine.roundId,
    phase: crashEngine.phase
  });
});

app.post("/auth/register", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (username.length < 3 || password.length < 4) {
    return res.status(400).json({ ok: false, message: "نام کاربری (حداقل ۳ کاراکتر) و رمز عبور (حداقل ۴ کاراکتر) الزامی است." });
  }
  if (getUserRow(username)) {
    return res.status(409).json({ ok: false, message: "این نام کاربری قبلاً ثبت شده است. از تب ورود استفاده کنید." });
  }
  const info = sqlite.prepare(`
    INSERT INTO users (username, password_hash, role, wallet_mode, demo_balance, real_balance, balance, created_at)
    VALUES (?, ?, 'user', 'demo', 10000000, 0, 10000000, ?)
  `).run(username, hashPassword(password), new Date().toISOString());

  const user = {
    id: info.lastInsertRowid,
    username,
    role: "user",
    wallet_mode: "demo",
    demo_balance: 10000000,
    real_balance: 0,
    balance: 10000000
  };
  const token = signToken(user);
  res.json({ ok: true, token, user });
});

app.post("/auth/login", (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) {
    return res.status(400).json({ ok: false, message: "نام کاربری و رمز عبور الزامی است." });
  }

  const existing = getUserRow(username);
  if (!existing) {
    return res.status(404).json({ ok: false, message: "حسابی با این نام کاربری یافت نشد. ابتدا ثبت‌نام کنید." });
  }
  if (!verifyPassword(password, existing.password_hash)) {
    return res.status(401).json({ ok: false, message: "رمز عبور اشتباه است." });
  }

  const user = formatPublicUser(existing);
  const token = signToken(user);
  res.json({ ok: true, token, user });
});

app.get("/auth/me", requireJwt, (req, res) => {
  const bets = sqlite.prepare(`
    SELECT id, mode, game, stake, mult, payout, created_at AS time
    FROM bets WHERE username = ? ORDER BY rowid DESC LIMIT 50
  `).all(req.authUser.username);
  res.json({ ok: true, user: req.authUser, bets });
});

app.post("/wallet/mode", requireJwt, (req, res) => {
  const nextMode = req.body?.mode;
  if (nextMode !== "demo" && nextMode !== "real") {
    return res.status(400).json({ ok: false, message: "حالت کیف پول باید 'demo' یا 'real' باشد." });
  }
  const updated = switchWalletMode(req.authUser.username, nextMode);
  res.json({ ok: true, user: formatPublicUser(updated) });
});

app.post("/wallet/demo-topup", requireJwt, (req, res) => {
  const amount = Math.round(Number(req.body?.amount) || 5000000);
  const safeAmt = Math.min(50000000, Math.max(100000, amount));
  const u = getUserRow(req.authUser.username);
  setModeBalance(req.authUser.username, "demo", u.demo_balance + safeAmt);
  const fresh = getUserRow(req.authUser.username);
  res.json({ ok: true, user: formatPublicUser(fresh) });
});

// --- Official Dice Endpoint ---
app.post("/games/dice/roll", requireJwt, (req, res) => {
  const stake = Math.round(Number(req.body?.stake) || 0);
  const target = Math.min(95, Math.max(5, Math.round(Number(req.body?.target) || 50)));
  if (!(stake >= 1000)) {
    return res.status(400).json({ ok: false, message: "حداقل مبلغ شرط ۱,۰۰۰ تومان است." });
  }

  const userRow = getUserRow(req.authUser.username);
  const mode = normalizeMode(userRow.wallet_mode);
  const currentBal = mode === "real" ? userRow.real_balance : userRow.demo_balance;

  if (currentBal < stake) {
    return res.status(400).json({
      ok: false,
      message: mode === "real" ? "موجودی حساب واقعی کافی نیست." : "موجودی حساب دمو کافی نیست."
    });
  }

  const roll = Number((crypto.randomBytes(4).readUInt32BE(0) / 0xffffffff * 99.99).toFixed(2));
  const won = roll < target;
  const winMult = Number((98 / target).toFixed(2));
  const payout = won ? Math.round(stake * winMult) : 0;

  let betLog = null;
  const tx = sqlite.transaction(() => {
    const afterStake = currentBal - stake;
    const finalBal = afterStake + payout;
    setModeBalance(req.authUser.username, mode, finalBal);
    betLog = insertBetRecord({
      username: req.authUser.username,
      mode,
      game: `تاس (کمتر از ${target})`,
      stake,
      mult: won ? winMult : 0,
      payout
    });
  });
  tx();

  const freshUser = getUserRow(req.authUser.username);
  broadcast({ type: "live_bet", data: betLog });

  res.json({
    ok: true,
    roll,
    won,
    mult: won ? winMult : 0,
    payout,
    betLog,
    user: formatPublicUser(freshUser)
  });
});

// --- Official Mines Endpoints ---
app.post("/games/mines/start", requireJwt, (req, res) => {
  const stake = Math.round(Number(req.body?.stake) || 0);
  const minesCount = Math.min(20, Math.max(1, Math.round(Number(req.body?.minesCount) || 4)));
  if (!(stake >= 1000)) {
    return res.status(400).json({ ok: false, message: "حداقل مبلغ شرط ۱,۰۰۰ تومان است." });
  }
  if (activeMinesSessions.has(req.authUser.username)) {
    return res.status(400).json({ ok: false, message: "یک بازی مین‌روب فعال دارید؛ ابتدا آن را تمام کنید." });
  }

  const userRow = getUserRow(req.authUser.username);
  const mode = normalizeMode(userRow.wallet_mode);
  const currentBal = mode === "real" ? userRow.real_balance : userRow.demo_balance;

  if (currentBal < stake) {
    return res.status(400).json({
      ok: false,
      message: mode === "real" ? "موجودی حساب واقعی کافی نیست." : "موجودی حساب دمو کافی نیست."
    });
  }

  const bombSet = new Set();
  while (bombSet.size < minesCount) {
    bombSet.add(crypto.randomInt(0, 25));
  }

  setModeBalance(req.authUser.username, mode, currentBal - stake);
  const freshUser = getUserRow(req.authUser.username);

  activeMinesSessions.set(req.authUser.username, {
    username: req.authUser.username,
    mode,
    stake,
    minesCount,
    bombs: Array.from(bombSet),
    revealed: []
  });

  res.json({
    ok: true,
    session: {
      minesCount,
      revealed: [],
      nextMult: calcMinesMultiplier(1, minesCount),
      currentMult: 1.0
    },
    user: formatPublicUser(freshUser)
  });
});

app.post("/games/mines/reveal", requireJwt, (req, res) => {
  const tileIndex = Number(req.body?.tileIndex);
  const sess = activeMinesSessions.get(req.authUser.username);
  if (!sess) {
    return res.status(400).json({ ok: false, message: "بازی مین‌روب فعالی یافت نشد." });
  }
  if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex > 24 || sess.revealed.includes(tileIndex)) {
    return res.status(400).json({ ok: false, message: "خانه نامعتبر یا تکراری است." });
  }

  if (sess.bombs.includes(tileIndex)) {
    activeMinesSessions.delete(req.authUser.username);
    const betLog = insertBetRecord({
      username: sess.username,
      mode: sess.mode,
      game: `مین‌روب (${sess.minesCount} مین)`,
      stake: sess.stake,
      mult: 0,
      payout: 0
    });
    broadcast({ type: "live_bet", data: betLog });
    const freshUser = getUserRow(sess.username);
    return res.json({
      ok: true,
      hitMine: true,
      bombs: sess.bombs,
      betLog,
      user: formatPublicUser(freshUser)
    });
  }

  sess.revealed.push(tileIndex);
  const currentMult = calcMinesMultiplier(sess.revealed.length, sess.minesCount);
  const nextMult = calcMinesMultiplier(sess.revealed.length + 1, sess.minesCount);

  res.json({
    ok: true,
    hitMine: false,
    revealed: sess.revealed,
    currentMult,
    nextMult,
    potentialPayout: Math.round(sess.stake * currentMult)
  });
});

app.post("/games/mines/cashout", requireJwt, (req, res) => {
  const sess = activeMinesSessions.get(req.authUser.username);
  if (!sess) {
    return res.status(400).json({ ok: false, message: "بازی مین‌روب فعالی یافت نشد." });
  }
  if (sess.revealed.length === 0) {
    return res.status(400).json({ ok: false, message: "حداقل یک خانه امن را باز کنید تا بتوانید برداشت بزنید." });
  }

  const mult = calcMinesMultiplier(sess.revealed.length, sess.minesCount);
  const payout = Math.round(sess.stake * mult);
  activeMinesSessions.delete(req.authUser.username);

  let betLog = null;
  const tx = sqlite.transaction(() => {
    const u = getUserRow(sess.username);
    const curBal = sess.mode === "real" ? u.real_balance : u.demo_balance;
    setModeBalance(sess.username, sess.mode, curBal + payout);
    betLog = insertBetRecord({
      username: sess.username,
      mode: sess.mode,
      game: `مین‌روب (${sess.minesCount} مین)`,
      stake: sess.stake,
      mult,
      payout
    });
  });
  tx();

  const freshUser = getUserRow(sess.username);
  broadcast({ type: "live_bet", data: betLog });

  res.json({
    ok: true,
    cashedOut: true,
    mult,
    payout,
    bombs: sess.bombs,
    betLog,
    user: formatPublicUser(freshUser)
  });
});

// --- Deposits & Withdrawals ---
app.post("/deposits/submit", requireJwt, (req, res) => {
  const amount = Math.round(Number(req.body?.amount) || 0);
  const receiptRef = String(req.body?.receiptRef || "").trim();
  const note = String(req.body?.note || "").trim();

  if (!(amount >= 10000)) {
    return res.status(400).json({ ok: false, message: "حداقل مبلغ واریز کارت به کارت ۱۰,۰۰۰ تومان است." });
  }
  if (receiptRef.length < 3) {
    return res.status(400).json({ ok: false, message: "شماره پیگیری / فیش رسید را وارد کنید." });
  }

  const deposit = {
    id: "DEP-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
    username: req.authUser.username,
    amount,
    receipt_ref: receiptRef,
    note,
    status: "pending",
    admin_note: "",
    reviewed_by: "",
    created_at: nowTime(),
    reviewed_at: ""
  };

  sqlite.prepare(`
    INSERT INTO deposits (id, username, amount, receipt_ref, note, status, admin_note, reviewed_by, created_at, reviewed_at)
    VALUES (@id, @username, @amount, @receipt_ref, @note, @status, @admin_note, @reviewed_by, @created_at, @reviewed_at)
  `).run(deposit);

  res.json({ ok: true, deposit });
});

app.get("/deposits", requireJwt, (req, res) => {
  const rows = req.authUser.role === "admin"
    ? sqlite.prepare("SELECT * FROM deposits ORDER BY rowid DESC LIMIT 100").all()
    : sqlite.prepare("SELECT * FROM deposits WHERE username = ? ORDER BY rowid DESC LIMIT 50").all(req.authUser.username);
  res.json({ ok: true, deposits: rows });
});

app.patch("/admin/deposits/:id/review", requireJwt, requireAdmin, (req, res) => {
  const depId = String(req.params.id || "").trim();
  const decision = String(req.body?.decision || "").trim();
  const adminNote = String(req.body?.adminNote || "").trim();

  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ ok: false, message: "وضعیت بررسی باید 'approved' یا 'rejected' باشد." });
  }

  const dep = sqlite.prepare("SELECT * FROM deposits WHERE id = ?").get(depId);
  if (!dep) return res.status(404).json({ ok: false, message: "فیش واریزی یافت نشد." });
  if (dep.status !== "pending") return res.status(400).json({ ok: false, message: "این فیش قبلاً بررسی شده است." });

  const reviewedAt = nowTime();
  let updatedTargetUser = null;

  const tx = sqlite.transaction(() => {
    sqlite.prepare(`
      UPDATE deposits SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?
    `).run(decision, adminNote, req.authUser.username, reviewedAt, depId);

    if (decision === "approved") {
      const target = getUserRow(dep.username);
      if (target) {
        setModeBalance(dep.username, "real", target.real_balance + dep.amount);
        updatedTargetUser = formatPublicUser(getUserRow(dep.username));
      }
    }
  });
  tx();

  const updatedDeposit = sqlite.prepare("SELECT * FROM deposits WHERE id = ?").get(depId);
  res.json({ ok: true, deposit: updatedDeposit, user: updatedTargetUser });
});

app.post("/withdrawals/request", requireJwt, (req, res) => {
  const amount = Math.round(Number(req.body?.amount) || 0);
  const destCard = String(req.body?.destCard || "").replace(/\s+/g, "").trim();
  const holderName = String(req.body?.holderName || "").trim();

  if (!(amount >= 50000)) {
    return res.status(400).json({ ok: false, message: "حداقل مبلغ درخواست برداشت واقعی ۵۰,۰۰۰ تومان است." });
  }
  if (!/^\d{16}$/.test(destCard)) {
    return res.status(400).json({ ok: false, message: "شماره کارت مقصد باید دقیقاً ۱۶ رقم باشد." });
  }

  const currentUser = getUserRow(req.authUser.username);
  if (!currentUser || currentUser.real_balance < amount) {
    return res.status(400).json({ ok: false, message: "موجودی حساب واقعی برای برداشت کافی نیست." });
  }

  const withdrawal = {
    id: "WDR-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
    username: req.authUser.username,
    amount,
    dest_card: destCard,
    holder_name: holderName,
    status: "pending",
    admin_note: "",
    reviewed_by: "",
    created_at: nowTime(),
    reviewed_at: ""
  };

  let freshUser = null;
  const tx = sqlite.transaction(() => {
    setModeBalance(req.authUser.username, "real", currentUser.real_balance - amount);
    sqlite.prepare(`
      INSERT INTO withdrawals (id, username, amount, dest_card, holder_name, status, admin_note, reviewed_by, created_at, reviewed_at)
      VALUES (@id, @username, @amount, @dest_card, @holder_name, @status, @admin_note, @reviewed_by, @created_at, @reviewed_at)
    `).run(withdrawal);
    freshUser = formatPublicUser(getUserRow(req.authUser.username));
  });
  tx();

  res.json({ ok: true, withdrawal, user: freshUser });
});

app.get("/withdrawals", requireJwt, (req, res) => {
  const rows = req.authUser.role === "admin"
    ? sqlite.prepare("SELECT * FROM withdrawals ORDER BY rowid DESC LIMIT 100").all()
    : sqlite.prepare("SELECT * FROM withdrawals WHERE username = ? ORDER BY rowid DESC LIMIT 50").all(req.authUser.username);
  res.json({ ok: true, withdrawals: rows });
});

app.patch("/admin/withdrawals/:id/review", requireJwt, requireAdmin, (req, res) => {
  const wdrId = String(req.params.id || "").trim();
  const decision = String(req.body?.decision || "").trim();
  const adminNote = String(req.body?.adminNote || "").trim();

  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ ok: false, message: "وضعیت بررسی باید 'approved' یا 'rejected' باشد." });
  }

  const wdr = sqlite.prepare("SELECT * FROM withdrawals WHERE id = ?").get(wdrId);
  if (!wdr) return res.status(404).json({ ok: false, message: "درخواست برداشت یافت نشد." });
  if (wdr.status !== "pending") return res.status(400).json({ ok: false, message: "این درخواست قبلاً بررسی شده است." });

  const reviewedAt = nowTime();
  let updatedTargetUser = null;

  const tx = sqlite.transaction(() => {
    sqlite.prepare(`
      UPDATE withdrawals SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?
    `).run(decision, adminNote, req.authUser.username, reviewedAt, wdrId);

    const target = getUserRow(wdr.username);
    if (target) {
      if (decision === "rejected") {
        setModeBalance(wdr.username, "real", target.real_balance + wdr.amount);
      }
      updatedTargetUser = formatPublicUser(getUserRow(wdr.username));
    }
  });
  tx();

  const updatedWithdrawal = sqlite.prepare("SELECT * FROM withdrawals WHERE id = ?").get(wdrId);
  res.json({ ok: true, withdrawal: updatedWithdrawal, user: updatedTargetUser });
});

app.get("/admin/finance-stats", requireJwt, requireAdmin, (req, res) => {
  res.json({ ok: true, stats: computeFinanceStats() });
});

app.get("/admin/users", requireJwt, requireAdmin, (req, res) => {
  const rows = sqlite.prepare(`
    SELECT id, username, role, wallet_mode, demo_balance, real_balance, balance, created_at
    FROM users ORDER BY id ASC LIMIT 100
  `).all();
  res.json({ ok: true, users: rows });
});

app.patch("/admin/users/:id/role", requireJwt, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const nextRole = String(req.body?.role || "").trim();
  if (!Number.isInteger(targetId) || targetId <= 0 || !["user", "admin"].includes(nextRole)) {
    return res.status(400).json({ ok: false, message: "شناسه کاربر یا نقش نامعتبر است." });
  }
  const targetUser = getUserById(targetId);
  if (!targetUser) return res.status(404).json({ ok: false, message: "کاربر یافت نشد." });
  if (targetUser.username === req.authUser.username && nextRole !== "admin") {
    return res.status(400).json({ ok: false, message: "نمی‌توانید نقش ادمین حساب فعال خود را تغییر دهید." });
  }
  sqlite.prepare("UPDATE users SET role = ? WHERE id = ?").run(nextRole, targetId);
  res.json({ ok: true, user: getUserById(targetId) });
});

app.get("/tickets", (req, res) => {
  const rows = sqlite.prepare(`
    SELECT id, username, topic, priority, subject, message, status, reply, created_at AS time
    FROM tickets ORDER BY rowid DESC LIMIT 50
  `).all();
  res.json({ ok: true, tickets: rows });
});

app.post("/tickets", requireJwt, (req, res) => {
  const topic = String(req.body?.topic || "").trim();
  const priority = String(req.body?.priority || "عادی").trim();
  const subject = String(req.body?.subject || "").trim();
  const message = String(req.body?.message || "").trim();
  if (!topic || !subject || !message) {
    return res.status(400).json({ ok: false, message: "موضوع، عنوان و متن تیکت الزامی است." });
  }
  const ticket = {
    id: "TCK-" + Math.floor(1000 + Math.random() * 9000),
    username: req.authUser.username,
    topic,
    priority,
    subject,
    message,
    status: "در انتظار بررسی",
    reply: "",
    time: nowTime()
  };
  sqlite.prepare(`
    INSERT INTO tickets (id, username, topic, priority, subject, message, status, reply, created_at)
    VALUES (@id, @username, @topic, @priority, @subject, @message, @status, @reply, @time)
  `).run(ticket);
  res.json({ ok: true, ticket });
});

// --- WebSocket + Server-Authoritative Crash ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function sendToClient(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(raw);
  });
}

function settleCrashCashout(entry, exactMult) {
  if (!entry || entry.status !== "active") return null;
  const confirmedMult = Number(Number(exactMult).toFixed(2));
  const payout = Math.round(entry.amount * confirmedMult);
  entry.status = "cashed";

  const userRow = getUserRow(entry.username);
  const mode = normalizeMode(entry.mode);
  const currentModeBal = mode === "real" ? (userRow?.real_balance || 0) : (userRow?.demo_balance || 0);
  setModeBalance(entry.username, mode, currentModeBal + payout);
  const freshUser = getUserRow(entry.username);

  const betLog = insertBetRecord({
    username: entry.username,
    mode,
    game: `انفجار پنل ${entry.slotId}`,
    stake: entry.amount,
    mult: confirmedMult,
    payout
  });

  broadcast({ type: "live_bet", data: betLog });
  return {
    slotId: entry.slotId,
    username: entry.username,
    mode,
    roundId: crashEngine.roundId,
    multiplier: confirmedMult,
    payout,
    balance: freshUser?.balance,
    demo_balance: freshUser?.demo_balance,
    real_balance: freshUser?.real_balance,
    betLog
  };
}

wss.on("connection", (ws) => {
  ws.authUser = null;

  sendToClient(ws, {
    type: "init_state",
    data: {
      crash: {
        roundId: crashEngine.roundId,
        phase: crashEngine.phase,
        multiplier: crashEngine.multiplier,
        roundHash: crashEngine.roundHash,
        history: getCrashHistory(15)
      },
      chat: getRecentChat(40)
    }
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg || !msg.type) return;

      if (msg.type === "auth") {
        const decoded = verifyTokenSafe(msg.token);
        if (!decoded || !decoded.username) {
          return sendToClient(ws, { type: "auth_error", data: { message: "توکن JWT نامعتبر است." } });
        }
        const userRow = getUserRow(decoded.username);
        if (!userRow) {
          return sendToClient(ws, { type: "auth_error", data: { message: "کاربر یافت نشد." } });
        }
        ws.authUser = { username: userRow.username, role: userRow.role || "user" };
        return sendToClient(ws, {
          type: "auth_ok",
          data: {
            username: userRow.username,
            role: ws.authUser.role,
            wallet_mode: userRow.wallet_mode,
            demo_balance: userRow.demo_balance,
            real_balance: userRow.real_balance,
            balance: userRow.balance
          }
        });
      }

      if (msg.type === "chat_send" && msg.text) {
        const sender = ws.authUser?.username || "مهمان";
        const chatItem = {
          id: "MSG-" + crypto.randomBytes(4).toString("hex"),
          user: sender,
          text: String(msg.text).slice(0, 300),
          time: nowTime()
        };
        sqlite.prepare(`
          INSERT INTO chat_messages (id, username, text, created_at) VALUES (@id, @user, @text, @time)
        `).run(chatItem);
        broadcast({ type: "chat_msg", data: chatItem });
      }

      if (msg.type === "crash_place_bet") {
        if (!ws.authUser?.username) {
          return sendToClient(ws, { type: "crash_error", data: { message: "ابتدا وارد حساب کاربری شوید." } });
        }
        const username = ws.authUser.username;
        const slotId = msg.slotId === 2 ? 2 : 1;
        const amount = Math.round(Number(msg.amount) || 0);
        const autoCashout = Number(msg.autoCashout) || 0;
        const userRow = getUserRow(username);
        const mode = normalizeMode(userRow?.wallet_mode);
        const modeBalance = mode === "real" ? (userRow?.real_balance || 0) : (userRow?.demo_balance || 0);

        if (!(amount >= 1000)) {
          return sendToClient(ws, { type: "crash_error", data: { slotId, message: "حداقل مبلغ شرط ۱,۰۰۰ تومان است." } });
        }
        if (modeBalance < amount) {
          return sendToClient(ws, {
            type: "crash_error",
            data: {
              slotId,
              message: mode === "real" ? "موجودی حساب واقعی کافی نیست." : "موجودی حساب دمو کافی نیست."
            }
          });
        }

        const key = `${username}:${slotId}`;
        if (crashEngine.roundBets.has(key)) {
          return sendToClient(ws, { type: "crash_error", data: { slotId, message: "شرط این پنل قبلاً ثبت شده است." } });
        }

        setModeBalance(username, mode, modeBalance - amount);
        const freshUser = getUserRow(username);
        const status = crashEngine.phase === "waiting" ? "active" : "queued";
        crashEngine.roundBets.set(key, {
          username,
          mode,
          slotId,
          amount,
          autoCashout: autoCashout >= 1.05 ? Number(autoCashout.toFixed(2)) : 0,
          status
        });

        sendToClient(ws, {
          type: "crash_bet_placed",
          data: {
            slotId,
            username,
            mode,
            amount,
            status,
            roundId: crashEngine.roundId,
            balance: freshUser?.balance,
            demo_balance: freshUser?.demo_balance,
            real_balance: freshUser?.real_balance
          }
        });
      }

      if (msg.type === "crash_cashout") {
        if (!ws.authUser?.username) {
          return sendToClient(ws, { type: "crash_error", data: { message: "ابتدا وارد حساب کاربری شوید." } });
        }
        const username = ws.authUser.username;
        const slotId = msg.slotId === 2 ? 2 : 1;
        const entry = crashEngine.roundBets.get(`${username}:${slotId}`);

        if (crashEngine.phase !== "running" || !entry || entry.status !== "active") {
          return sendToClient(ws, { type: "crash_error", data: { slotId, message: "برداشت در این لحظه امکان‌پذیر نیست." } });
        }

        const confirmedMult = Math.min(crashEngine.multiplier, crashEngine.crashPoint);
        const settled = settleCrashCashout(entry, confirmedMult);
        if (settled) {
          sendToClient(ws, { type: "crash_cashout_ok", data: settled });
        }
      }
    } catch {}
  });
});

function beginCrashRound() {
  const next = generateCrashRoundData(crashEngine.roundId);
  crashEngine.phase = "running";
  crashEngine.multiplier = 1.0;
  crashEngine.serverSeed = next.serverSeed;
  crashEngine.roundHash = next.roundHash;
  crashEngine.crashPoint = next.crashPoint;

  for (const [, entry] of crashEngine.roundBets.entries()) {
    if (entry.status === "queued") entry.status = "active";
  }

  broadcast({
    type: "crash_start",
    data: { roundId: crashEngine.roundId, roundHash: crashEngine.roundHash }
  });
}

setInterval(() => {
  if (crashEngine.phase === "running") {
    crashEngine.multiplier = Number((crashEngine.multiplier + 0.03 + crashEngine.multiplier * 0.006).toFixed(2));

    for (const [, entry] of crashEngine.roundBets.entries()) {
      if (entry.status === "active" && entry.autoCashout >= 1.05 && crashEngine.multiplier >= entry.autoCashout) {
        const cashMult = Math.min(crashEngine.multiplier, crashEngine.crashPoint);
        const settled = settleCrashCashout(entry, cashMult);
        if (settled) broadcast({ type: "crash_cashout_ok", data: settled });
      }
    }

    if (crashEngine.multiplier >= crashEngine.crashPoint) {
      for (const [, entry] of crashEngine.roundBets.entries()) {
        if (entry.status === "active") {
          entry.status = "lost";
          const betLog = insertBetRecord({
            username: entry.username,
            mode: entry.mode,
            game: `انفجار پنل ${entry.slotId}`,
            stake: entry.amount,
            mult: 0,
            payout: 0
          });
          broadcast({ type: "live_bet", data: betLog });
        }
      }

      const timeStr = nowTime();
      sqlite.prepare(`
        INSERT INTO crash_rounds (round_id, mult, round_hash, server_seed, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(crashEngine.roundId, crashEngine.crashPoint, crashEngine.roundHash, crashEngine.serverSeed, timeStr);

      broadcast({
        type: "crash_end",
        data: { id: crashEngine.roundId, mult: crashEngine.crashPoint, hash: crashEngine.roundHash, time: timeStr }
      });

      const nextBets = new Map();
      for (const [k, entry] of crashEngine.roundBets.entries()) {
        if (entry.status === "queued") nextBets.set(k, entry);
      }
      crashEngine.roundBets = nextBets;
      crashEngine.roundId += 1;

      setTimeout(() => {
        crashEngine.phase = "waiting";
        broadcast({ type: "crash_waiting", data: { roundId: crashEngine.roundId } });
        setTimeout(beginCrashRound, 2000);
      }, 2200);
    } else {
      broadcast({
        type: "crash_tick",
        data: { roundId: crashEngine.roundId, multiplier: crashEngine.multiplier }
      });
    }
  }
}, 100);

setTimeout(beginCrashRound, 1000);

server.listen(PORT, () => {
  console.log(`Sofyan.bet official server running on http://localhost:${PORT}`);
});
