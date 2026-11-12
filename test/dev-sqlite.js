// 선택 사항: Postgres 없이 화면만 빠르게 띄워 보는 개발용 서버 (Node 22.5+, 메모리 DB라 재시작하면 데이터가 사라져요)
//   node --no-warnings test/dev-sqlite.js   →  http://localhost:3100
'use strict';
const { createServer } = require('../server');
const { init } = require('../schema');
const { createSqliteDb } = require('./sqlite-shim');

(async () => {
  const db = createSqliteDb();
  await init(db);
  const port = process.env.PORT || 3100;
  createServer(db).listen(port, () => console.log(`개발용(SQLite 메모리) 서버: http://localhost:${port}`));
})();
