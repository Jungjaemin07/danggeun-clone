// 당근마켓 클론 - 의존성 없는 Node.js 서버 (Node 18+)
// 실행: node server.js  →  http://localhost:3000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const CATEGORIES = ['디지털기기', '생활가전', '가구/인테리어', '생활/주방', '유아동', '의류', '잡화', '스포츠/레저', '취미/게임/음반', '도서', '기타'];
const DONGS = ['고잔동', '초지동', '선부동', '원곡동', '와동', '본오동', '사동', '성포동'];

function seed() {
  const now = Date.now();
  const h = (n) => now - n * 3600 * 1000;
  return {
    nextId: { item: 11, chat: 1, msg: 1, user: 6 },
    users: [
      { id: 1, nickname: '나', dong: '고잔동', manner: 36.5 },
      { id: 2, nickname: '당근이', dong: '고잔동', manner: 41.2 },
      { id: 3, nickname: '해피맘', dong: '초지동', manner: 38.7 },
      { id: 4, nickname: '자전거왕', dong: '선부동', manner: 45.0 },
      { id: 5, nickname: '책벌레', dong: '고잔동', manner: 37.9 },
    ],
    items: [
      { id: 1, sellerId: 2, title: '아이패드 에어 5세대 64GB', category: '디지털기기', price: 520000, dong: '고잔동', desc: '작년에 구매해서 가볍게 사용했어요. 케이스, 필름 같이 드려요. 직거래 선호합니다.', emoji: '📱', image: null, status: 'sale', views: 42, createdAt: h(2) },
      { id: 2, sellerId: 3, title: '유아 원목 책상 의자 세트', category: '유아동', price: 45000, dong: '초지동', desc: '아이가 커서 내놓아요. 흠집 거의 없고 깨끗합니다.', emoji: '🪑', image: null, status: 'sale', views: 18, createdAt: h(5) },
      { id: 3, sellerId: 4, title: '로드 자전거 (알루미늄 프레임)', category: '스포츠/레저', price: 280000, dong: '선부동', desc: '입문용으로 좋아요. 타이어 새것으로 교체했습니다.', emoji: '🚲', image: null, status: 'sale', views: 67, createdAt: h(9) },
      { id: 4, sellerId: 5, title: '해리포터 전집 (한글판)', category: '도서', price: 60000, dong: '고잔동', desc: '1~7권 세트, 상태 좋아요.', emoji: '📚', image: null, status: 'reserved', views: 31, createdAt: h(14) },
      { id: 5, sellerId: 2, title: '다이슨 무선청소기 V8', category: '생활가전', price: 170000, dong: '고잔동', desc: '배터리 상태 양호, 거치대 포함.', emoji: '🧹', image: null, status: 'sale', views: 55, createdAt: h(20) },
      { id: 6, sellerId: 3, title: '에어프라이어 5L', category: '생활/주방', price: 25000, dong: '초지동', desc: '이사 때문에 정리합니다. 박스 있어요.', emoji: '🍟', image: null, status: 'sale', views: 12, createdAt: h(26) },
      { id: 7, sellerId: 4, title: '캠핑 의자 2개 세트', category: '스포츠/레저', price: 30000, dong: '선부동', desc: '한 번 사용했어요.', emoji: '⛺', image: null, status: 'sold', views: 80, createdAt: h(40) },
      { id: 8, sellerId: 5, title: '닌텐도 스위치 라이트', category: '취미/게임/음반', price: 140000, dong: '고잔동', desc: '게임 칩 2개 포함.', emoji: '🎮', image: null, status: 'sale', views: 95, createdAt: h(48) },
      { id: 9, sellerId: 2, title: '이케아 3단 수납장', category: '가구/인테리어', price: 15000, dong: '원곡동', desc: '직접 가져가셔야 해요.', emoji: '🗄️', image: null, status: 'sale', views: 9, createdAt: h(60) },
      { id: 10, sellerId: 3, title: '겨울 패딩 (95 사이즈)', category: '의류', price: 35000, dong: '와동', desc: '한 시즌 입었어요. 세탁 완료.', emoji: '🧥', image: null, status: 'sale', views: 22, createdAt: h(72) },
    ],
    likes: [], // { userId, itemId }
    chats: [], // { id, itemId, buyerId, sellerId, createdAt }
    messages: [], // { id, chatId, senderId, text, createdAt }
  };
}

let db;
function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { db = seed(); save(); }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)), 50);
}
function saveNow() { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

const ME = 1;
const user = (id) => db.users.find((u) => u.id === id);
const publicUser = (u) => u && { id: u.id, nickname: u.nickname, dong: u.dong, manner: u.manner };

function decorateItem(it) {
  return {
    ...it,
    seller: publicUser(user(it.sellerId)),
    likeCount: db.likes.filter((l) => l.itemId === it.id).length,
    chatCount: db.chats.filter((c) => c.itemId === it.id).length,
    liked: db.likes.some((l) => l.itemId === it.id && l.userId === ME),
  };
}

// ---- 응답 유틸 ----
function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 6 * 1024 * 1024) { reject(Object.assign(new Error('요청이 너무 큽니다'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('잘못된 JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}
const fail = (code, message) => Object.assign(new Error(message), { code });
class Created { constructor(body) { this.body = body; } }
const created = (body) => new Created(body);

// ---- 라우트 ----
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/meta', () => ({ categories: CATEGORIES, dongs: DONGS }));

route('GET', '/api/me', () => publicUser(user(ME)));
route('PATCH', '/api/me', async ({ body }) => {
  const me = user(ME);
  if (body.dong !== undefined) {
    if (!DONGS.includes(body.dong)) throw fail(400, '지원하지 않는 동네예요');
    me.dong = body.dong;
  }
  if (body.nickname !== undefined) {
    const n = String(body.nickname).trim();
    if (!n || n.length > 12) throw fail(400, '닉네임은 1~12자로 입력해 주세요');
    me.nickname = n;
  }
  save();
  return publicUser(me);
});

route('GET', '/api/items', ({ query }) => {
  let list = db.items.slice();
  if (query.dong) list = list.filter((i) => i.dong === query.dong);
  if (query.category) list = list.filter((i) => i.category === query.category);
  if (query.q) {
    const q = query.q.toLowerCase();
    list = list.filter((i) => i.title.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q));
  }
  if (query.seller) list = list.filter((i) => i.sellerId === Number(query.seller));
  if (query.liked === '1') list = list.filter((i) => db.likes.some((l) => l.itemId === i.id && l.userId === ME));
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list.map(decorateItem);
});

route('GET', '/api/items/:id', ({ params }) => {
  const it = db.items.find((i) => i.id === Number(params.id));
  if (!it) throw fail(404, '게시글을 찾을 수 없어요');
  it.views += 1; save();
  return decorateItem(it);
});

route('POST', '/api/items', ({ body }) => {
  const title = String(body.title || '').trim();
  const price = Number(body.price);
  if (!title || title.length > 60) throw fail(400, '제목을 1~60자로 입력해 주세요');
  if (!Number.isFinite(price) || price < 0) throw fail(400, '가격을 올바르게 입력해 주세요');
  if (!CATEGORIES.includes(body.category)) throw fail(400, '카테고리를 선택해 주세요');
  if (body.image && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(body.image)) throw fail(400, '이미지 형식이 올바르지 않아요');
  const it = {
    id: db.nextId.item++, sellerId: ME, title, category: body.category, price: Math.floor(price),
    dong: user(ME).dong, desc: String(body.desc || '').slice(0, 2000), emoji: body.emoji || '📦',
    image: body.image || null, status: 'sale', views: 0, createdAt: Date.now(),
  };
  db.items.push(it); save();
  return created(decorateItem(it));
});

route('PATCH', '/api/items/:id', ({ params, body }) => {
  const it = db.items.find((i) => i.id === Number(params.id));
  if (!it) throw fail(404, '게시글을 찾을 수 없어요');
  if (it.sellerId !== ME) throw fail(403, '내 게시글만 수정할 수 있어요');
  if (body.status !== undefined) {
    if (!['sale', 'reserved', 'sold'].includes(body.status)) throw fail(400, '잘못된 상태예요');
    it.status = body.status;
  }
  if (body.price !== undefined) { const p = Number(body.price); if (Number.isFinite(p) && p >= 0) it.price = Math.floor(p); }
  save();
  return decorateItem(it);
});

route('DELETE', '/api/items/:id', ({ params }) => {
  const idx = db.items.findIndex((i) => i.id === Number(params.id));
  if (idx < 0) throw fail(404, '게시글을 찾을 수 없어요');
  if (db.items[idx].sellerId !== ME) throw fail(403, '내 게시글만 삭제할 수 있어요');
  const id = db.items[idx].id;
  db.items.splice(idx, 1);
  db.likes = db.likes.filter((l) => l.itemId !== id);
  const chatIds = db.chats.filter((c) => c.itemId === id).map((c) => c.id);
  db.chats = db.chats.filter((c) => c.itemId !== id);
  db.messages = db.messages.filter((m) => !chatIds.includes(m.chatId));
  save();
  return { ok: true };
});

route('POST', '/api/items/:id/like', ({ params }) => {
  const id = Number(params.id);
  if (!db.items.some((i) => i.id === id)) throw fail(404, '게시글을 찾을 수 없어요');
  const idx = db.likes.findIndex((l) => l.itemId === id && l.userId === ME);
  if (idx >= 0) db.likes.splice(idx, 1); else db.likes.push({ userId: ME, itemId: id });
  save();
  return { liked: idx < 0, likeCount: db.likes.filter((l) => l.itemId === id).length };
});

// 매너 평가: 거래 후 상대방 매너온도 조정 (+0.5 / -0.5 단위)
route('POST', '/api/users/:id/review', ({ params, body }) => {
  const u = user(Number(params.id));
  if (!u) throw fail(404, '사용자를 찾을 수 없어요');
  if (u.id === ME) throw fail(400, '나 자신은 평가할 수 없어요');
  const delta = { good: 0.5, bad: -0.5 }[body.rating];
  if (delta === undefined) throw fail(400, 'rating은 good 또는 bad여야 해요');
  u.manner = Math.max(0, Math.min(99, Math.round((u.manner + delta) * 10) / 10));
  save();
  return publicUser(u);
});

// ---- 채팅 ----
function decorateChat(c) {
  const it = db.items.find((i) => i.id === c.itemId);
  const other = user(c.buyerId === ME ? c.sellerId : c.buyerId);
  const msgs = db.messages.filter((m) => m.chatId === c.id);
  const last = msgs[msgs.length - 1];
  return {
    id: c.id, other: publicUser(other),
    item: it ? { id: it.id, title: it.title, price: it.price, emoji: it.emoji, image: it.image, status: it.status } : null,
    lastMessage: last ? last.text : '', lastAt: last ? last.createdAt : c.createdAt,
  };
}

route('GET', '/api/chats', () =>
  db.chats.filter((c) => c.buyerId === ME || c.sellerId === ME).map(decorateChat).sort((a, b) => b.lastAt - a.lastAt));

route('POST', '/api/chats', ({ body }) => {
  const it = db.items.find((i) => i.id === Number(body.itemId));
  if (!it) throw fail(404, '게시글을 찾을 수 없어요');
  if (it.sellerId === ME) throw fail(400, '내 게시글에는 채팅할 수 없어요');
  let chat = db.chats.find((c) => c.itemId === it.id && c.buyerId === ME);
  if (!chat) {
    chat = { id: db.nextId.chat++, itemId: it.id, buyerId: ME, sellerId: it.sellerId, createdAt: Date.now() };
    db.chats.push(chat); save();
  }
  return decorateChat(chat);
});

route('GET', '/api/chats/:id', ({ params }) => {
  const chat = db.chats.find((c) => c.id === Number(params.id));
  if (!chat || (chat.buyerId !== ME && chat.sellerId !== ME)) throw fail(404, '채팅방을 찾을 수 없어요');
  return { ...decorateChat(chat), messages: db.messages.filter((m) => m.chatId === chat.id) };
});

const AUTO_REPLIES = ['안녕하세요! 아직 판매 중이에요 😊', '네, 가능합니다. 언제 괜찮으세요?', '가격은 조금 조정 가능해요.', '직거래는 근처 편의점 앞에서 하면 어떨까요?', '네, 알겠습니다!'];

route('POST', '/api/chats/:id/messages', ({ params, body }) => {
  const chat = db.chats.find((c) => c.id === Number(params.id));
  if (!chat || (chat.buyerId !== ME && chat.sellerId !== ME)) throw fail(404, '채팅방을 찾을 수 없어요');
  const text = String(body.text || '').trim();
  if (!text || text.length > 500) throw fail(400, '메시지를 1~500자로 입력해 주세요');
  const msg = { id: db.nextId.msg++, chatId: chat.id, senderId: ME, text, createdAt: Date.now() };
  db.messages.push(msg);
  // 데모용: 상대방(더미 사용자)이 잠시 후 자동 응답
  const otherId = chat.buyerId === ME ? chat.sellerId : chat.buyerId;
  setTimeout(() => {
    db.messages.push({ id: db.nextId.msg++, chatId: chat.id, senderId: otherId, text: AUTO_REPLIES[Math.floor(Math.random() * AUTO_REPLIES.length)], createdAt: Date.now() });
    save();
  }, 1200);
  save();
  return created(msg);
});

// ---- 서버 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
        const out = await r.handler({ params, body, query: Object.fromEntries(url.searchParams) });
        return out instanceof Created ? send(res, 201, out.body) : send(res, 200, out);
      }
      return send(res, 404, { error: '존재하지 않는 API예요' });
    }
    // 정적 파일
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    send(res, e.code && Number.isInteger(e.code) ? e.code : 500, { error: e.message || '서버 오류' });
  }
});

load();
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });
server.listen(PORT, () => console.log(`당근마켓 클론 서버 실행 중: http://localhost:${PORT}`));
