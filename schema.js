// DB 스키마 생성 + 최초 1회 데모 데이터 입력.
// PostgreSQL 기준으로 작성했고, 표준 SQL 범위만 사용합니다.
'use strict';

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    nickname TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    dong TEXT NOT NULL,
    manner_base DOUBLE PRECISION NOT NULL DEFAULT 36.5,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  )`,
  // 이메일 인증 전의 가입 요청. 인증이 끝나야 users에 계정이 만들어져요.
  `CREATE TABLE IF NOT EXISTS pending_signups (
    email TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    dong TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id BIGSERIAL PRIMARY KEY,
    seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    price BIGINT NOT NULL,
    dong TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    emoji TEXT NOT NULL DEFAULT '📦',
    image TEXT,
    status TEXT NOT NULL DEFAULT 'sale',
    views INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS likes (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, item_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chats (
    id BIGSERIAL PRIMARY KEY,
    item_id BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    buyer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    UNIQUE (item_id, buyer_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    reviewer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (reviewer_id, target_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_dong_created ON items (dong, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_items_seller ON items (seller_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_buyer ON chats (buyer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_seller ON chats (seller_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_item ON chats (item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_likes_item ON likes (item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,
];

// [판매자 인덱스, 제목, 카테고리, 가격, 동네, 설명, 이모지, 상태, 조회수, 몇 시간 전]
const DEMO_USERS = [
  ['당근이', '고잔동', 41.2],
  ['해피맘', '초지동', 38.7],
  ['자전거왕', '선부동', 45.0],
  ['책벌레', '고잔동', 37.9],
];
const DEMO_ITEMS = [
  [0, '아이패드 에어 5세대 64GB', '디지털기기', 520000, '고잔동', '작년에 구매해서 가볍게 사용했어요. 케이스, 필름 같이 드려요. 직거래 선호합니다.', '📱', 'sale', 42, 2],
  [1, '유아 원목 책상 의자 세트', '유아동', 45000, '초지동', '아이가 커서 내놓아요. 흠집 거의 없고 깨끗합니다.', '🪑', 'sale', 18, 5],
  [2, '로드 자전거 (알루미늄 프레임)', '스포츠/레저', 280000, '선부동', '입문용으로 좋아요. 타이어 새것으로 교체했습니다.', '🚲', 'sale', 67, 9],
  [3, '해리포터 전집 (한글판)', '도서', 60000, '고잔동', '1~7권 세트, 상태 좋아요.', '📚', 'reserved', 31, 14],
  [0, '다이슨 무선청소기 V8', '생활가전', 170000, '고잔동', '배터리 상태 양호, 거치대 포함.', '🧹', 'sale', 55, 20],
  [1, '에어프라이어 5L', '생활/주방', 25000, '초지동', '이사 때문에 정리합니다. 박스 있어요.', '🍟', 'sale', 12, 26],
  [2, '캠핑 의자 2개 세트', '스포츠/레저', 30000, '선부동', '한 번 사용했어요.', '⛺', 'sold', 80, 40],
  [3, '닌텐도 스위치 라이트', '취미/게임/음반', 140000, '고잔동', '게임 칩 2개 포함.', '🎮', 'sale', 95, 48],
  [0, '이케아 3단 수납장', '가구/인테리어', 15000, '원곡동', '직접 가져가셔야 해요.', '🗄️', 'sale', 9, 60],
  [1, '겨울 패딩 (95 사이즈)', '의류', 35000, '와동', '한 시즌 입었어요. 세탁 완료.', '🧥', 'sale', 22, 72],
];

async function seedDemo(db) {
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM users WHERE is_demo = 1');
  if (Number(rows[0].n) > 0) return;
  const now = Date.now();
  await db.tx(async (t) => {
    const ids = [];
    for (let i = 0; i < DEMO_USERS.length; i++) {
      const [nick, dong, manner] = DEMO_USERS[i];
      const r = await t.query(
        'INSERT INTO users (email, nickname, pw_hash, dong, manner_base, is_demo, created_at) VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING id',
        [`demo${i + 1}@demo.invalid`, nick, 'disabled', dong, manner, now]
      );
      ids.push(r.rows[0].id);
    }
    for (const [si, title, cat, price, dong, desc, emoji, status, views, hoursAgo] of DEMO_ITEMS) {
      await t.query(
        'INSERT INTO items (seller_id, title, category, price, dong, description, emoji, status, views, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [ids[si], title, cat, price, dong, desc, emoji, status, views, now - hoursAgo * 3600 * 1000]
      );
    }
  });
}

async function init(db) {
  for (const sql of DDL) await db.query(sql);
  await seedDemo(db);
}

module.exports = { init };
