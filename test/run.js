// 서버 API 통합 테스트: node --no-warnings test/run.js  (Node 22.5+, 외부 패키지 불필요)
'use strict';
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { init } = require('../schema');
const { createSqliteDb } = require('./sqlite-shim');

// 1x1 투명 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 실제 메일 대신 발송 내역을 모아 두는 가짜 메일러
const outbox = [];
const mailer = { fail: false, async sendCode(to, code) { if (mailer.fail) throw new Error('smtp down'); outbox.push({ to, code }); } };
const lastCode = (to) => [...outbox].reverse().find((m) => m.to === to)?.code;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

(async () => {
  const db = createSqliteDb();
  await init(db);
  const server = createServer(db, { mailer, mailIpLimit: 1000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 쿠키를 들고 다니는 간단한 클라이언트
  function client() {
    let cookie = '';
    const call = async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie?.() || [];
      for (const c of set) { const kv = c.split(';')[0]; cookie = kv.endsWith('=') ? '' : kv; }
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, headers: res.headers, setCookie: set };
    };
    return { call, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b || {}), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
  }

  // 가입 → 메일의 코드로 인증까지 한 번에
  async function register(c, f) {
    const email = f.email.toLowerCase();
    const r1 = await c.post('/api/auth/signup', f);
    assert.equal(r1.status, 202, JSON.stringify(r1.data));
    return c.post('/api/auth/verify', { email, code: lastCode(email) });
  }

  const guest = client();
  const A = client();
  const B = client();

  console.log('인증');
  await test('로그인 없이 보호된 API는 401', async () => {
    assert.equal((await guest.get('/api/me')).status, 401);
    assert.equal((await guest.get('/api/items')).status, 401);
    assert.equal((await guest.get('/api/chats')).status, 401);
  });
  await test('meta와 healthz는 공개', async () => {
    assert.equal((await guest.get('/api/meta')).status, 200);
    assert.equal((await guest.get('/healthz')).status, 200);
  });
  await test('회원가입 입력 검증', async () => {
    assert.equal((await guest.post('/api/auth/signup', { email: 'bad', nickname: '에이', password: 'password1' })).status, 400);
    assert.equal((await guest.post('/api/auth/signup', { email: 'a@test.com', nickname: '에', password: 'password1' })).status, 400);
    assert.equal((await guest.post('/api/auth/signup', { email: 'a@test.com', nickname: '에이', password: 'short' })).status, 400);
  });
  await test('회원가입 성공 + HttpOnly 쿠키, 비밀번호는 응답에 없음', async () => {
    const r = await register(A, { email: 'A@Test.com', nickname: '에이유저', password: 'password1', dong: '초지동' });
    assert.equal(r.status, 201);
    assert.equal(r.data.email, 'a@test.com');
    assert.equal(r.data.dong, '초지동');
    assert.equal(r.data.manner, 36.5);
    assert.ok(!('pw_hash' in r.data) && !JSON.stringify(r.data).includes('scrypt'));
    assert.ok(/HttpOnly/i.test(r.setCookie[0]) && /SameSite=Lax/i.test(r.setCookie[0]));
  });
  await test('이메일 중복 가입은 409', async () => {
    assert.equal((await guest.post('/api/auth/signup', { email: 'a@test.com', nickname: '다른사람', password: 'password1' })).status, 409);
  });
  await test('로그인 상태에서 /api/me 조회', async () => {
    const r = await A.get('/api/me');
    assert.equal(r.status, 200);
    assert.equal(r.data.nickname, '에이유저');
  });
  await test('틀린 비밀번호 401, 맞는 비밀번호 200', async () => {
    const c = client();
    assert.equal((await c.post('/api/auth/login', { email: 'a@test.com', password: 'wrongpass1' })).status, 401);
    assert.equal((await c.post('/api/auth/login', { email: 'a@test.com', password: 'password1' })).status, 200);
    assert.equal((await c.get('/api/me')).status, 200);
  });
  await test('데모 계정으로는 로그인 불가', async () => {
    assert.equal((await client().post('/api/auth/login', { email: 'demo1@demo.invalid', password: 'disabled' })).status, 401);
  });
  await test('로그아웃하면 세션이 무효화', async () => {
    const c = client();
    await c.post('/api/auth/login', { email: 'a@test.com', password: 'password1' });
    const cookieBefore = (await c.get('/api/me')).status;
    assert.equal(cookieBefore, 200);
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    assert.equal((await c.get('/api/me')).status, 401);
  });
  await test('다른 출처(Origin)의 쓰기 요청은 403', async () => {
    const r = await A.call('POST', '/api/items/1/like', {}, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });

  console.log('이메일 인증');
  const V = 'v1@test.com';
  await test('가입 요청만으로는 계정이 안 만들어지고, 6자리 코드가 메일로 감', async () => {
    const r = await guest.post('/api/auth/signup', { email: V, nickname: '인증유저', password: 'password1' });
    assert.equal(r.status, 202);
    assert.equal(r.data.needsVerification, true);
    assert.ok(!r.setCookie.length, '인증 전에는 세션이 없어야 함');
    assert.match(lastCode(V), /^\d{6}$/);
    assert.equal((await client().post('/api/auth/login', { email: V, password: 'password1' })).status, 401, '인증 전 로그인 불가');
  });
  await test('인증 메일 재요청은 60초 대기', async () => {
    const r = await guest.post('/api/auth/signup', { email: V, nickname: '인증유저', password: 'password1' });
    assert.equal(r.status, 429);
    assert.equal((await guest.post('/api/auth/resend', { email: V })).status, 429);
  });
  await test('틀린 코드는 400, 5번 틀리면 잠기고 코드를 다시 받으면 풀림', async () => {
    const right = lastCode(V);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await guest.post('/api/auth/verify', { email: V, code: wrong })).status, 400);
    assert.equal((await guest.post('/api/auth/verify', { email: V, code: right })).status, 429, '잠금 후에는 맞는 코드도 거부');
    await db.query('UPDATE pending_signups SET last_sent_at = 0 WHERE email = $1', [V]);
    assert.equal((await guest.post('/api/auth/resend', { email: V })).status, 200);
    assert.equal((await guest.post('/api/auth/verify', { email: V, code: right })).status, 400, '이전 코드는 무효');
  });
  await test('형식이 틀린 코드는 400', async () => {
    assert.equal((await guest.post('/api/auth/verify', { email: V, code: 'abc' })).status, 400);
  });
  await test('만료된 코드는 거부하고, 재전송하면 새 코드로 인증됨', async () => {
    await db.query('UPDATE pending_signups SET expires_at = 1 WHERE email = $1', [V]);
    assert.equal((await guest.post('/api/auth/verify', { email: V, code: lastCode(V) })).status, 400);
    await db.query('UPDATE pending_signups SET last_sent_at = 0 WHERE email = $1', [V]);
    assert.equal((await guest.post('/api/auth/resend', { email: V })).status, 200);
  });
  await test('올바른 코드로 인증하면 계정 생성 + 로그인, 같은 코드 재사용은 불가', async () => {
    const c = client();
    const code = lastCode(V);
    const r = await c.post('/api/auth/verify', { email: V, code });
    assert.equal(r.status, 201);
    assert.equal(r.data.nickname, '인증유저');
    assert.ok(/HttpOnly/i.test(r.setCookie[0]));
    assert.equal((await c.get('/api/me')).status, 200);
    assert.equal((await guest.post('/api/auth/verify', { email: V, code })).status, 400);
    assert.equal((await client().post('/api/auth/login', { email: V, password: 'password1' })).status, 200);
    assert.equal((await guest.post('/api/auth/signup', { email: V, nickname: '다른사람', password: 'password1' })).status, 409);
  });
  await test('다시 가입 요청하면 새 정보와 새 코드로 덮어씀(이전 코드 무효)', async () => {
    const E = 'v2@test.com';
    await guest.post('/api/auth/signup', { email: E, nickname: '처음이름', password: 'password1' });
    const first = lastCode(E);
    await db.query('UPDATE pending_signups SET last_sent_at = 0 WHERE email = $1', [E]);
    await guest.post('/api/auth/signup', { email: E, nickname: '바뀐이름', password: 'password1' });
    const second = lastCode(E);
    if (first !== second) assert.equal((await guest.post('/api/auth/verify', { email: E, code: first })).status, 400);
    const r = await guest.post('/api/auth/verify', { email: E, code: second });
    assert.equal(r.status, 201);
    assert.equal(r.data.nickname, '바뀐이름');
  });
  await test('메일 발송이 실패하면 502, 가입 대기 정보도 남지 않음', async () => {
    mailer.fail = true;
    const E = 'v3@test.com';
    const r = await guest.post('/api/auth/signup', { email: E, nickname: '실패유저', password: 'password1' });
    mailer.fail = false;
    assert.equal(r.status, 502);
    assert.equal((await db.query('SELECT 1 FROM pending_signups WHERE email = $1', [E])).rows.length, 0);
  });
  await test('가입 요청이 없는 이메일의 인증/재전송은 400', async () => {
    assert.equal((await guest.post('/api/auth/verify', { email: 'nobody@test.com', code: '123456' })).status, 400);
    assert.equal((await guest.post('/api/auth/resend', { email: 'nobody@test.com' })).status, 400);
  });

  console.log('상품');
  let myItem;
  await test('데모 상품 목록과 동네/카테고리/검색 필터', async () => {
    const all = (await A.get('/api/items')).data;
    assert.equal(all.length, 10);
    assert.ok(all[0].createdAt >= all[all.length - 1].createdAt, '최신순');
    assert.ok(!('image' in all[0]) && 'hasImage' in all[0]);
    assert.equal((await A.get('/api/items?dong=' + encodeURIComponent('고잔동'))).data.length, 4);
    assert.equal((await A.get('/api/items?category=' + encodeURIComponent('도서'))).data.length, 1);
    assert.equal((await A.get('/api/items?q=' + encodeURIComponent('아이패드'))).data.length, 1);
    assert.equal((await A.get('/api/items?q=%25')).data.length, 0, '% 문자는 와일드카드가 아님');
  });
  await test('상품 등록 검증', async () => {
    const ok = { title: '내 상품', category: '기타', price: 1000, desc: '설명', emoji: '📦' };
    assert.equal((await A.post('/api/items', { ...ok, title: '' })).status, 400);
    assert.equal((await A.post('/api/items', { ...ok, price: '' })).status, 400);
    assert.equal((await A.post('/api/items', { ...ok, price: -1 })).status, 400);
    assert.equal((await A.post('/api/items', { ...ok, category: '없는카테고리' })).status, 400);
    assert.equal((await A.post('/api/items', { ...ok, image: 'data:text/html;base64,PHNjcmlwdD4=' })).status, 400);
  });
  await test('이미지 포함 상품 등록 + 이미지 엔드포인트', async () => {
    const r = await A.post('/api/items', { title: '내 상품', category: '기타', price: 1000, desc: '설명', emoji: '📦', image: PNG });
    assert.equal(r.status, 201);
    myItem = r.data;
    assert.equal(myItem.hasImage, true);
    assert.equal(myItem.dong, '초지동');
    assert.equal(myItem.seller.nickname, '에이유저');
    const img = await guest.get(`/api/items/${myItem.id}/image`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.ok(img.data.length > 20);
    assert.equal((await guest.get('/api/items/1/image')).status, 404, '이미지 없는 상품');
  });
  await test('조회수: 남의 글은 +1, 내 글은 그대로', async () => {
    const other = (await A.get('/api/items/1')).data;
    const again = (await A.get('/api/items/1')).data;
    assert.equal(again.views, other.views + 1);
    const mine1 = (await A.get(`/api/items/${myItem.id}`)).data;
    const mine2 = (await A.get(`/api/items/${myItem.id}`)).data;
    assert.equal(mine2.views, mine1.views);
  });
  await test('남의 상품은 수정/삭제 불가(403), 존재하지 않는 id는 404', async () => {
    assert.equal((await A.patch('/api/items/1', { status: 'sold' })).status, 403);
    assert.equal((await A.del('/api/items/1')).status, 403);
    assert.equal((await A.get('/api/items/99999')).status, 404);
    assert.equal((await A.get('/api/items/abc')).status, 404);
  });
  await test('내 상품 상태 변경', async () => {
    const r = await A.patch(`/api/items/${myItem.id}`, { status: 'reserved' });
    assert.equal(r.data.status, 'reserved');
    assert.equal((await A.patch(`/api/items/${myItem.id}`, { status: 'weird' })).status, 400);
  });
  await test('관심 토글과 관심 목록(사용자별로 분리)', async () => {
    await register(B, { email: 'b@test.com', nickname: '비유저', password: 'password1' });
    let r = await B.post(`/api/items/${myItem.id}/like`);
    assert.deepEqual([r.data.liked, r.data.likeCount], [true, 1]);
    assert.equal((await B.get('/api/items?liked=1')).data.length, 1);
    assert.equal((await A.get('/api/items?liked=1')).data.length, 0, 'A의 관심목록에는 없어야 함');
    assert.equal((await B.get(`/api/items/${myItem.id}`)).data.liked, true);
    r = await B.post(`/api/items/${myItem.id}/like`);
    assert.deepEqual([r.data.liked, r.data.likeCount], [false, 0]);
  });

  console.log('채팅 / 매너');
  let chatId;
  await test('내 상품에는 채팅 불가, 남의 상품에는 가능(중복 생성 안 됨)', async () => {
    assert.equal((await A.post('/api/chats', { itemId: myItem.id })).status, 400);
    const c1 = await B.post('/api/chats', { itemId: myItem.id });
    const c2 = await B.post('/api/chats', { itemId: myItem.id });
    assert.equal(c1.status, 200);
    assert.equal(c1.data.id, c2.data.id);
    assert.equal(c1.data.other.nickname, '에이유저');
    chatId = c1.data.id;
  });
  await test('구매자 메시지 → 판매자(실제 사용자)도 채팅 목록에서 확인하고 답장', async () => {
    assert.equal((await B.post(`/api/chats/${chatId}/messages`, { text: '' })).status, 400);
    const m = await B.post(`/api/chats/${chatId}/messages`, { text: '안녕하세요' });
    assert.equal(m.status, 201);
    const list = (await A.get('/api/chats')).data;
    assert.equal(list.length, 1);
    assert.equal(list[0].other.nickname, '비유저');
    assert.equal(list[0].lastMessage, '안녕하세요');
    await A.post(`/api/chats/${chatId}/messages`, { text: '네, 판매 중이에요' });
    const room = (await B.get(`/api/chats/${chatId}`)).data;
    assert.deepEqual(room.messages.map((x) => x.text), ['안녕하세요', '네, 판매 중이에요']);
  });
  await test('?after= 로 새 메시지만 가져오기', async () => {
    const room = (await B.get(`/api/chats/${chatId}`)).data;
    const after = (await B.get(`/api/chats/${chatId}?after=${room.messages[0].id}`)).data;
    assert.equal(after.messages.length, 1);
  });
  await test('제3자는 채팅방에 접근 불가', async () => {
    const C = client();
    await register(C, { email: 'c@test.com', nickname: '씨유저', password: 'password1' });
    assert.equal((await C.get(`/api/chats/${chatId}`)).status, 404);
    assert.equal((await C.post(`/api/chats/${chatId}/messages`, { text: '엿보기' })).status, 404);
    assert.equal((await C.get('/api/chats')).data.length, 0);
  });
  await test('데모 판매자와 채팅하면 자동 응답이 옴', async () => {
    const chat = (await B.post('/api/chats', { itemId: 1 })).data;
    await B.post(`/api/chats/${chat.id}/messages`, { text: '문의드려요' });
    await sleep(1800);
    const room = (await B.get(`/api/chats/${chat.id}`)).data;
    assert.equal(room.messages.length, 2);
    assert.notEqual(room.messages[1].senderId, room.messages[0].senderId);
  });
  await test('매너 평가: 채팅한 상대만, 상대당 1표(재평가 시 변경)', async () => {
    const C = client();
    await C.post('/api/auth/login', { email: 'c@test.com', password: 'password1' });
    const a = (await A.get('/api/me')).data;
    assert.equal((await C.post(`/api/users/${a.id}/review`, { rating: 'good' })).status, 403, '채팅 안 한 사이');
    assert.equal((await B.post(`/api/users/${a.id}/review`, { rating: 'meh' })).status, 400);
    assert.equal((await A.post(`/api/users/${a.id}/review`, { rating: 'good' })).status, 400, '자기 자신');
    assert.equal((await B.post(`/api/users/${a.id}/review`, { rating: 'good' })).data.manner, 37);
    assert.equal((await B.post(`/api/users/${a.id}/review`, { rating: 'good' })).data.manner, 37, '중복 투표는 그대로');
    assert.equal((await B.post(`/api/users/${a.id}/review`, { rating: 'bad' })).data.manner, 36);
    assert.equal((await A.get('/api/me')).data.manner, 36);
  });
  await test('상품 삭제 시 채팅·이미지도 함께 정리', async () => {
    assert.equal((await A.del(`/api/items/${myItem.id}`)).status, 200);
    assert.equal((await B.get(`/api/chats/${chatId}`)).status, 404);
    assert.equal((await guest.get(`/api/items/${myItem.id}/image`)).status, 404);
  });

  console.log('내 정보');
  await test('동네/닉네임 변경과 검증', async () => {
    assert.equal((await A.patch('/api/me', { dong: '없는동' })).status, 400);
    assert.equal((await A.patch('/api/me', { nickname: 'x' })).status, 400);
    const r = await A.patch('/api/me', { dong: '와동', nickname: '새닉네임' });
    assert.deepEqual([r.data.dong, r.data.nickname], ['와동', '새닉네임']);
  });
  await test('로그인 시도 제한 (429)', async () => {
    const c = client();
    let last;
    for (let i = 0; i < 12; i++) last = await c.post('/api/auth/login', { email: 'limit@test.com', password: 'wrongpass1' });
    assert.equal(last.status, 429);
  });
  await test('정적 파일과 경로 이탈 차단', async () => {
    const html = await guest.get('/');
    assert.equal(html.status, 200);
    const raw = await fetch(base + '/..%2fserver.js');
    assert.ok([403, 404].includes(raw.status));
  });

  server.close();
  console.log(`\n${passed}개 통과${process.exitCode ? ' (실패 있음)' : ''}`);
  process.exit(process.exitCode || 0);
})();
