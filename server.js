// 당근마켓 클론 서버 (Node.js + PostgreSQL, 회원가입/로그인 포함)
// 실행: DATABASE_URL=... node server.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { init } = require('./schema');
const { createMailer, consoleMailer } = require('./mailer');

const scrypt = promisify(crypto.scrypt);
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_PROD = process.env.NODE_ENV === 'production';

const CATEGORIES = ['디지털기기', '생활가전', '가구/인테리어', '생활/주방', '유아동', '의류', '잡화', '스포츠/레저', '취미/게임/음반', '도서', '기타'];
const DONGS = ['고잔동', '초지동', '선부동', '원곡동', '와동', '본오동', '사동', '성포동'];
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_BODY = 3 * 1024 * 1024;
const MAX_IMAGE_CHARS = 2_000_000;
const CODE_TTL_MS = 10 * 60 * 1000;      // 인증 코드 유효 시간
const RESEND_COOLDOWN_MS = 60 * 1000;    // 재전송 대기 시간
const MAX_CODE_ATTEMPTS = 5;             // 코드 입력 허용 횟수
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const AUTO_REPLIES = ['안녕하세요! 아직 판매 중이에요 😊', '네, 가능합니다. 언제 괜찮으세요?', '가격은 조금 조정 가능해요.', '직거래는 근처 편의점 앞에서 하면 어떨까요?', '네, 알겠습니다!'];

// ───────── 공용 유틸 ─────────
const fail = (status, message) => Object.assign(new Error(message), { status });
class Reply { constructor(status, body, headers = {}) { this.status = status; this.body = body; this.headers = headers; } }
const created = (body) => new Reply(201, body);

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const round1 = (n) => Math.round(Math.max(0, Math.min(99, Number(n))) * 10) / 10;
const isUnique = (e) => e && (e.code === '23505' || /UNIQUE constraint/i.test(e.message || ''));
function idOf(s) {
  if (!/^\d{1,15}$/.test(String(s))) throw fail(404, '존재하지 않아요');
  return Number(s);
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const sessionCookie = (token, maxAgeSec) =>
  `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${IS_PROD ? '; Secure' : ''}`;
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// 로그인/가입 시도 횟수 제한 (메모리)
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 3600 * 1000)) hits.delete(k);
}, 10 * 60 * 1000).unref();

// 비밀번호: scrypt (Node 내장, 별도 패키지 불필요)
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), expected.length || 64);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
let DUMMY_HASH = null; // 없는 계정에도 같은 시간이 걸리게 하기 위한 값

// 매너온도 = 기본 온도 + 받은 평가(±0.5℃)의 합
const mannerExpr = (a) =>
  `(${a}.manner_base + COALESCE((SELECT CAST(SUM(CASE r.rating WHEN 'good' THEN 0.5 ELSE -0.5 END) AS DOUBLE PRECISION) FROM reviews r WHERE r.target_id = ${a}.id), 0))`;

const ITEM_COLS = `i.id, i.seller_id, i.title, i.category, i.price, i.dong, i.description, i.emoji,
  (i.image IS NOT NULL) AS has_image, i.status, i.views, i.created_at,
  u.nickname AS seller_nickname, u.dong AS seller_dong, ${mannerExpr('u')} AS seller_manner,
  (SELECT COUNT(*) FROM likes l WHERE l.item_id = i.id) AS like_count,
  (SELECT COUNT(*) FROM chats c WHERE c.item_id = i.id) AS chat_count,
  EXISTS (SELECT 1 FROM likes l2 WHERE l2.item_id = i.id AND l2.user_id = $1) AS liked`;

const mapItem = (r) => ({
  id: Number(r.id), sellerId: Number(r.seller_id), title: r.title, category: r.category, price: Number(r.price),
  dong: r.dong, desc: r.description, emoji: r.emoji, hasImage: Boolean(r.has_image), status: r.status,
  views: Number(r.views), createdAt: Number(r.created_at),
  seller: { id: Number(r.seller_id), nickname: r.seller_nickname, dong: r.seller_dong, manner: round1(r.seller_manner) },
  likeCount: Number(r.like_count), chatCount: Number(r.chat_count), liked: Boolean(r.liked),
});

// ───────── 서버 생성 ─────────
function createServer(db, opts = {}) {
  const mailer = opts.mailer || consoleMailer;
  const mailIpLimit = opts.mailIpLimit || 10; // IP당 시간당 인증 메일 요청 수
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler, pub: Boolean(opts.pub) });
  };

  // ---- 데이터 조회 헬퍼 ----
  async function fetchItems(userId, where = '', params = [], tail = '') {
    const { rows } = await db.query(
      `SELECT ${ITEM_COLS} FROM items i JOIN users u ON u.id = i.seller_id ${where} ${tail}`,
      [userId, ...params]
    );
    return rows.map(mapItem);
  }
  async function loadMe(id) {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.nickname, u.dong, ${mannerExpr('u')} AS manner FROM users u WHERE u.id = $1`, [id]);
    const r = rows[0];
    return r && { id: Number(r.id), email: r.email, nickname: r.nickname, dong: r.dong, manner: round1(r.manner) };
  }
  async function currentUser(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return null;
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.nickname, u.dong FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2`, [sha256(token), Date.now()]);
    return rows[0] ? { id: Number(rows[0].id), email: rows[0].email, nickname: rows[0].nickname, dong: rows[0].dong } : null;
  }
  async function startSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), userId, Date.now() + SESSION_MS]);
    await db.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
    return sessionCookie(token, SESSION_MS / 1000);
  }

  // ---- 인증 ----
  const codeHash = (email, code) => sha256(`${email}:${code}`);
  const cooldownLeft = (row) => (row ? Math.max(0, Math.ceil((Number(row.last_sent_at) + RESEND_COOLDOWN_MS - Date.now()) / 1000)) : 0);
  const getPending = async (email) => (await db.query('SELECT * FROM pending_signups WHERE email = $1', [email])).rows[0];

  // 메일을 먼저 보내고, 성공했을 때만 저장해요 (받지 못한 코드가 저장되는 일을 막기 위해)
  async function sendAndStore(email, f) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    try { await mailer.sendCode(email, code); }
    catch (e) {
      console.error('[mail]', e.message);
      throw fail(502, '인증 메일을 보내지 못했어요. 이메일 주소를 확인하고 잠시 후 다시 시도해 주세요');
    }
    const now = Date.now();
    await db.query(
      `INSERT INTO pending_signups (email, nickname, pw_hash, dong, code_hash, expires_at, attempts, last_sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
       ON CONFLICT (email) DO UPDATE SET nickname = EXCLUDED.nickname, pw_hash = EXCLUDED.pw_hash, dong = EXCLUDED.dong,
         code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, last_sent_at = EXCLUDED.last_sent_at`,
      [email, f.nickname, f.pw_hash, f.dong, codeHash(email, code), now + CODE_TTL_MS, now]);
    db.query('DELETE FROM pending_signups WHERE expires_at < $1', [now - 3600 * 1000]).catch(() => {}); // 오래된 요청 정리
    return { needsVerification: true, email, ttlSec: CODE_TTL_MS / 1000, resendAfterSec: RESEND_COOLDOWN_MS / 1000 };
  }
  function mailLimit(email, req) {
    if (limited(`mail-ip:${clientIp(req)}`, mailIpLimit, 3600 * 1000) || limited(`mail-addr:${email}`, 5, 3600 * 1000)) {
      throw fail(429, '인증 메일 요청이 너무 많아요. 잠시 후 다시 시도해 주세요');
    }
  }
  const emailOf = (body) => String(body.email || '').trim().toLowerCase();

  route('POST', '/api/auth/signup', async ({ body, req }) => {
    const email = emailOf(body);
    const nickname = String(body.nickname || '').trim();
    const password = String(body.password || '');
    if (!EMAIL_RE.test(email) || email.length > 254) throw fail(400, '이메일 형식이 올바르지 않아요');
    if (nickname.length < 2 || nickname.length > 12) throw fail(400, '닉네임은 2~12자로 입력해 주세요');
    if (password.length < 8 || password.length > 128) throw fail(400, '비밀번호는 8자 이상 입력해 주세요');
    const dong = DONGS.includes(body.dong) ? body.dong : DONGS[0];
    if ((await db.query('SELECT 1 FROM users WHERE email = $1', [email])).rows.length) throw fail(409, '이미 가입된 이메일이에요');
    const wait = cooldownLeft(await getPending(email));
    if (wait > 0) throw fail(429, `${wait}초 후에 다시 시도해 주세요`);
    mailLimit(email, req);
    const out = await sendAndStore(email, { nickname, pw_hash: await hashPassword(password), dong });
    return new Reply(202, out);
  }, { pub: true });

  route('POST', '/api/auth/resend', async ({ body, req }) => {
    const email = emailOf(body);
    const row = await getPending(email);
    if (!row) throw fail(400, '가입 요청이 없거나 만료됐어요. 처음부터 다시 가입해 주세요');
    const wait = cooldownLeft(row);
    if (wait > 0) throw fail(429, `${wait}초 후에 다시 요청해 주세요`);
    mailLimit(email, req);
    return sendAndStore(email, row);
  }, { pub: true });

  route('POST', '/api/auth/verify', async ({ body, req }) => {
    const email = emailOf(body);
    const code = String(body.code || '').trim();
    if (limited(`verify-ip:${clientIp(req)}`, 30, 15 * 60 * 1000)) throw fail(429, '시도가 너무 많아요. 잠시 후 다시 시도해 주세요');
    const row = await getPending(email);
    if (!row) throw fail(400, '가입 요청이 없거나 만료됐어요. 처음부터 다시 가입해 주세요');
    if (Number(row.expires_at) < Date.now()) throw fail(400, '인증 코드가 만료됐어요. 코드를 다시 받아 주세요');
    if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) throw fail(429, '입력 횟수를 넘었어요. 코드를 다시 받아 주세요');
    if (!/^\d{6}$/.test(code)) throw fail(400, '6자리 숫자를 입력해 주세요');
    const a = Buffer.from(codeHash(email, code)), b = Buffer.from(String(row.code_hash));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await db.query('UPDATE pending_signups SET attempts = attempts + 1 WHERE email = $1', [email]);
      throw fail(400, '인증 코드가 올바르지 않아요');
    }
    let id;
    try {
      id = await db.tx(async (t) => {
        const r = await t.query(
          'INSERT INTO users (email, nickname, pw_hash, dong, manner_base, is_demo, created_at) VALUES ($1, $2, $3, $4, 36.5, 0, $5) RETURNING id',
          [email, row.nickname, row.pw_hash, row.dong, Date.now()]);
        await t.query('DELETE FROM pending_signups WHERE email = $1', [email]);
        return Number(r.rows[0].id);
      });
    } catch (e) {
      if (isUnique(e)) throw fail(409, '이미 가입된 이메일이에요');
      throw e;
    }
    const cookie = await startSession(id);
    return new Reply(201, await loadMe(id), { 'Set-Cookie': cookie });
  }, { pub: true });

  route('POST', '/api/auth/login', async ({ body, req }) => {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const key = `login:${clientIp(req)}:${email}`;
    if (limited(key, 10, 15 * 60 * 1000)) throw fail(429, '로그인 시도가 너무 많아요. 잠시 후 다시 시도해 주세요');
    const row = (await db.query('SELECT id, pw_hash FROM users WHERE email = $1', [email])).rows[0];
    if (!DUMMY_HASH) DUMMY_HASH = await hashPassword('dummy-password');
    const ok = await verifyPassword(password.slice(0, 128), row ? row.pw_hash : DUMMY_HASH);
    if (!row || !ok) throw fail(401, '이메일 또는 비밀번호가 올바르지 않아요');
    hits.delete(key);
    const cookie = await startSession(Number(row.id));
    return new Reply(200, await loadMe(Number(row.id)), { 'Set-Cookie': cookie });
  }, { pub: true });

  route('POST', '/api/auth/logout', async ({ req }) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    return new Reply(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }, { pub: true });

  route('GET', '/api/meta', () => ({ categories: CATEGORIES, dongs: DONGS }), { pub: true });

  // ---- 내 정보 ----
  route('GET', '/api/me', ({ user }) => loadMe(user.id));
  route('PATCH', '/api/me', async ({ body, user }) => {
    if (body.dong !== undefined) {
      if (!DONGS.includes(body.dong)) throw fail(400, '지원하지 않는 동네예요');
      await db.query('UPDATE users SET dong = $1 WHERE id = $2', [body.dong, user.id]);
    }
    if (body.nickname !== undefined) {
      const n = String(body.nickname).trim();
      if (n.length < 2 || n.length > 12) throw fail(400, '닉네임은 2~12자로 입력해 주세요');
      await db.query('UPDATE users SET nickname = $1 WHERE id = $2', [n, user.id]);
    }
    return loadMe(user.id);
  });

  // ---- 상품 ----
  route('GET', '/api/items', async ({ query, user }) => {
    const params = [];
    const add = (v) => { params.push(v); return `$${params.length + 1}`; }; // $1은 로그인 사용자
    const conds = [];
    if (query.dong) conds.push(`i.dong = ${add(String(query.dong))}`);
    if (query.category) conds.push(`i.category = ${add(String(query.category))}`);
    if (query.q) {
      const like = '%' + String(query.q).toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      const p = add(like);
      conds.push(`(LOWER(i.title) LIKE ${p} ESCAPE '\\' OR LOWER(i.description) LIKE ${p} ESCAPE '\\')`);
    }
    if (query.seller) conds.push(`i.seller_id = ${add(idOf(query.seller))}`);
    if (query.liked === '1') conds.push('EXISTS (SELECT 1 FROM likes lk WHERE lk.item_id = i.id AND lk.user_id = $1)');
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    return fetchItems(user.id, where, params, 'ORDER BY i.created_at DESC, i.id DESC LIMIT 100');
  });

  route('GET', '/api/items/:id', async ({ params, user }) => {
    const id = idOf(params.id);
    const item = (await fetchItems(user.id, 'WHERE i.id = $2', [id]))[0];
    if (!item) throw fail(404, '게시글을 찾을 수 없어요');
    if (item.sellerId !== user.id) {
      await db.query('UPDATE items SET views = views + 1 WHERE id = $1', [id]);
      item.views += 1;
    }
    return item;
  });

  route('GET', '/api/items/:id/image', async ({ params }) => {
    const r = await db.query('SELECT image FROM items WHERE id = $1', [idOf(params.id)]);
    const img = r.rows[0] && r.rows[0].image;
    const m = img && /^data:image\/(\w+);base64,([\s\S]*)$/.exec(img);
    if (!m) throw fail(404, '이미지가 없어요');
    return new Reply(200, Buffer.from(m[2], 'base64'), {
      'Content-Type': `image/${m[1] === 'jpg' ? 'jpeg' : m[1]}`,
      'Cache-Control': 'public, max-age=86400',
      'Content-Security-Policy': "default-src 'none'",
    });
  }, { pub: true });

  route('POST', '/api/items', async ({ body, user }) => {
    const title = String(body.title || '').trim();
    if (!title || title.length > 60) throw fail(400, '제목을 1~60자로 입력해 주세요');
    if (body.price === '' || body.price === null || body.price === undefined) throw fail(400, '가격을 입력해 주세요');
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0 || price > 1_000_000_000) throw fail(400, '가격을 올바르게 입력해 주세요');
    if (!CATEGORIES.includes(body.category)) throw fail(400, '카테고리를 선택해 주세요');
    const emoji = typeof body.emoji === 'string' && body.emoji && body.emoji.length <= 8 ? body.emoji : '📦';
    let image = null;
    if (body.image) {
      if (typeof body.image !== 'string' || body.image.length > MAX_IMAGE_CHARS || !IMAGE_RE.test(body.image)) {
        throw fail(400, '이미지 형식이 올바르지 않거나 너무 커요');
      }
      image = body.image;
    }
    const r = await db.query(
      `INSERT INTO items (seller_id, title, category, price, dong, description, emoji, image, status, views, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sale', 0, $9) RETURNING id`,
      [user.id, title, body.category, Math.floor(price), user.dong, String(body.desc || '').slice(0, 2000), emoji, image, Date.now()]);
    return created((await fetchItems(user.id, 'WHERE i.id = $2', [Number(r.rows[0].id)]))[0]);
  });

  async function ownItem(id, user) {
    const row = (await db.query('SELECT seller_id FROM items WHERE id = $1', [id])).rows[0];
    if (!row) throw fail(404, '게시글을 찾을 수 없어요');
    if (Number(row.seller_id) !== user.id) throw fail(403, '내 게시글만 수정할 수 있어요');
  }

  route('PATCH', '/api/items/:id', async ({ params, body, user }) => {
    const id = idOf(params.id);
    await ownItem(id, user);
    if (body.status !== undefined) {
      if (!['sale', 'reserved', 'sold'].includes(body.status)) throw fail(400, '잘못된 상태예요');
      await db.query('UPDATE items SET status = $1 WHERE id = $2', [body.status, id]);
    }
    if (body.price !== undefined) {
      const p = Number(body.price);
      if (!Number.isFinite(p) || p < 0 || p > 1_000_000_000) throw fail(400, '가격을 올바르게 입력해 주세요');
      await db.query('UPDATE items SET price = $1 WHERE id = $2', [Math.floor(p), id]);
    }
    return (await fetchItems(user.id, 'WHERE i.id = $2', [id]))[0];
  });

  route('DELETE', '/api/items/:id', async ({ params, user }) => {
    const id = idOf(params.id);
    await ownItem(id, user);
    await db.query('DELETE FROM items WHERE id = $1', [id]); // 관심·채팅·메시지는 ON DELETE CASCADE로 함께 삭제
    return { ok: true };
  });

  route('POST', '/api/items/:id/like', async ({ params, user }) => {
    const id = idOf(params.id);
    if (!(await db.query('SELECT 1 FROM items WHERE id = $1', [id])).rows.length) throw fail(404, '게시글을 찾을 수 없어요');
    const del = await db.query('DELETE FROM likes WHERE user_id = $1 AND item_id = $2 RETURNING item_id', [user.id, id]);
    const liked = del.rows.length === 0;
    if (liked) await db.query('INSERT INTO likes (user_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, id]);
    const c = await db.query('SELECT COUNT(*) AS n FROM likes WHERE item_id = $1', [id]);
    return { liked, likeCount: Number(c.rows[0].n) };
  });

  // ---- 매너 평가: 채팅을 주고받은 상대에게만, 상대당 1표(다시 누르면 변경) ----
  route('POST', '/api/users/:id/review', async ({ params, body, user }) => {
    const target = idOf(params.id);
    if (target === user.id) throw fail(400, '나 자신은 평가할 수 없어요');
    if (!['good', 'bad'].includes(body.rating)) throw fail(400, 'rating은 good 또는 bad여야 해요');
    const talked = await db.query(
      'SELECT 1 FROM chats WHERE (buyer_id = $1 AND seller_id = $2) OR (buyer_id = $2 AND seller_id = $1)', [user.id, target]);
    if (!talked.rows.length) throw fail(403, '채팅을 나눈 상대만 평가할 수 있어요');
    await db.query(
      `INSERT INTO reviews (reviewer_id, target_id, rating, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (reviewer_id, target_id) DO UPDATE SET rating = EXCLUDED.rating`,
      [user.id, target, body.rating, Date.now()]);
    const r = await db.query(`SELECT u.id, u.nickname, u.dong, ${mannerExpr('u')} AS manner FROM users u WHERE u.id = $1`, [target]);
    const u = r.rows[0];
    return { id: Number(u.id), nickname: u.nickname, dong: u.dong, manner: round1(u.manner) };
  });

  // ---- 채팅 ----
  async function fetchChats(userId, extraWhere = '', extraParams = []) {
    const { rows } = await db.query(
      `SELECT c.id, c.created_at, c.item_id,
         i.title AS item_title, i.price AS item_price, i.emoji AS item_emoji, (i.image IS NOT NULL) AS item_has_image, i.status AS item_status,
         o.id AS other_id, o.nickname AS other_nickname, o.dong AS other_dong, ${mannerExpr('o')} AS other_manner,
         (SELECT m.body FROM messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_text,
         (SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_at
       FROM chats c
       JOIN items i ON i.id = c.item_id
       JOIN users o ON o.id = CASE WHEN c.buyer_id = $1 THEN c.seller_id ELSE c.buyer_id END
       WHERE (c.buyer_id = $1 OR c.seller_id = $1) ${extraWhere}`,
      [userId, ...extraParams]);
    return rows.map((r) => ({
      id: Number(r.id),
      other: { id: Number(r.other_id), nickname: r.other_nickname, dong: r.other_dong, manner: round1(r.other_manner) },
      item: { id: Number(r.item_id), title: r.item_title, price: Number(r.item_price), emoji: r.item_emoji, hasImage: Boolean(r.item_has_image), status: r.item_status },
      lastMessage: r.last_text || '',
      lastAt: Number(r.last_at || r.created_at),
    }));
  }
  const mapMsg = (r) => ({ id: Number(r.id), chatId: Number(r.chat_id), senderId: Number(r.sender_id), text: r.body, createdAt: Number(r.created_at) });

  route('GET', '/api/chats', async ({ user }) => (await fetchChats(user.id)).sort((a, b) => b.lastAt - a.lastAt));

  route('POST', '/api/chats', async ({ body, user }) => {
    const itemId = idOf(body.itemId);
    const it = (await db.query('SELECT seller_id, status FROM items WHERE id = $1', [itemId])).rows[0];
    if (!it) throw fail(404, '게시글을 찾을 수 없어요');
    if (Number(it.seller_id) === user.id) throw fail(400, '내 게시글에는 채팅할 수 없어요');
    const exists = await db.query('SELECT id FROM chats WHERE item_id = $1 AND buyer_id = $2', [itemId, user.id]);
    let chatId = exists.rows[0] && Number(exists.rows[0].id);
    if (!chatId) {
      if (it.status === 'sold') throw fail(400, '거래가 완료된 상품이에요');
      await db.query('INSERT INTO chats (item_id, buyer_id, seller_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (item_id, buyer_id) DO NOTHING',
        [itemId, user.id, Number(it.seller_id), Date.now()]);
      chatId = Number((await db.query('SELECT id FROM chats WHERE item_id = $1 AND buyer_id = $2', [itemId, user.id])).rows[0].id);
    }
    return (await fetchChats(user.id, 'AND c.id = $2', [chatId]))[0];
  });

  route('GET', '/api/chats/:id', async ({ params, query, user }) => {
    const id = idOf(params.id);
    const chat = (await fetchChats(user.id, 'AND c.id = $2', [id]))[0];
    if (!chat) throw fail(404, '채팅방을 찾을 수 없어요');
    const after = query.after ? idOf(query.after) : 0;
    const { rows } = await db.query('SELECT id, chat_id, sender_id, body, created_at FROM messages WHERE chat_id = $1 AND id > $2 ORDER BY id LIMIT 300', [id, after]);
    return { ...chat, messages: rows.map(mapMsg) };
  });

  route('POST', '/api/chats/:id/messages', async ({ params, body, user }) => {
    const id = idOf(params.id);
    const chat = (await db.query('SELECT buyer_id, seller_id FROM chats WHERE id = $1', [id])).rows[0];
    if (!chat || (Number(chat.buyer_id) !== user.id && Number(chat.seller_id) !== user.id)) throw fail(404, '채팅방을 찾을 수 없어요');
    const text = String(body.text || '').trim();
    if (!text || text.length > 500) throw fail(400, '메시지를 1~500자로 입력해 주세요');
    const r = await db.query('INSERT INTO messages (chat_id, sender_id, body, created_at) VALUES ($1, $2, $3, $4) RETURNING id, chat_id, sender_id, body, created_at',
      [id, user.id, text, Date.now()]);
    // 데모 계정(가짜 판매자)과의 채팅이면 잠시 후 자동 응답
    const otherId = Number(chat.buyer_id) === user.id ? Number(chat.seller_id) : Number(chat.buyer_id);
    db.query('SELECT is_demo FROM users WHERE id = $1', [otherId]).then((res) => {
      if (Number(res.rows[0] && res.rows[0].is_demo) !== 1) return;
      setTimeout(() => {
        db.query('INSERT INTO messages (chat_id, sender_id, body, created_at) VALUES ($1, $2, $3, $4)',
          [id, otherId, AUTO_REPLIES[Math.floor(Math.random() * AUTO_REPLIES.length)], Date.now()]).catch(() => {});
      }, 1200);
    }).catch(() => {});
    return created(mapMsg(r.rows[0]));
  });

  // ---- 요청 처리 ----
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(fail(413, '요청이 너무 커요')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
        catch { reject(fail(400, '잘못된 JSON이에요')); }
      });
      req.on('error', reject);
    });
  }

  function send(res, status, body, headers = {}) {
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, headers);
      return res.end(body);
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }

  async function handleApi(req, res, url) {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !sameOrigin(req)) throw fail(403, '허용되지 않은 요청이에요');
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const user = r.pub ? null : await currentUser(req);
      if (!r.pub && !user) throw fail(401, '로그인이 필요해요');
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler({ params, body, query: Object.fromEntries(url.searchParams), user, req });
      return out instanceof Reply ? send(res, out.status, out.body, out.headers) : send(res, 200, out);
    }
    throw fail(404, '존재하지 않는 API예요');
  }

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

      const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof URIError) return send(res, 400, { error: '잘못된 요청이에요' });
      if (Number.isInteger(e.status)) return send(res, e.status, { error: e.message });
      console.error('[error]', req.method, req.url, e);
      send(res, 500, { error: '서버 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' });
    }
  });
}

// ───────── 실행 ─────────
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL 환경변수가 필요해요. .env.example을 참고해 주세요.');
    process.exit(1);
  }
  const { createPgDb } = require('./db');
  const db = createPgDb(url);
  try {
    await init(db);
  } catch (e) {
    console.error('DB 초기화에 실패했어요:', e.message);
    process.exit(1);
  }
  let mailer = createMailer();
  if (!mailer) {
    if (IS_PROD) {
      console.error('인증 메일 설정이 필요해요. MAIL_PROVIDER와 관련 환경변수(.env.example 참고)를 설정해 주세요.');
      process.exit(1);
    }
    console.warn('[개발 모드] 메일 설정이 없어서 인증 코드를 이 터미널에 출력해요.');
    mailer = consoleMailer;
  } else {
    console.log(`메일 발송 방식: ${mailer.provider}`);
  }
  const port = process.env.PORT || 3000;
  const server = createServer(db, { mailer });
  server.listen(port, '0.0.0.0', () => console.log(`당근마켓 클론 서버 실행 중: http://localhost:${port}`));
  const shutdown = () => { server.close(() => db.close().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();
module.exports = { createServer };
