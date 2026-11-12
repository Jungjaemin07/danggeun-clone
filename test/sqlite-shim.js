// 테스트 전용: PostgreSQL 대신 Node 내장 SQLite(node:sqlite, Node 22.5+)로 server.js 로직을 확인합니다.
// 운영 환경(PostgreSQL)과 SQL 방언이 완전히 같지는 않으므로, 최종 확인은 실제 Postgres에서 해야 해요.
'use strict';
const { DatabaseSync } = require('node:sqlite');

function createSqliteDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const translate = (sql) =>
    sql.replace(/\$(\d+)/g, '?$1').replace(/BIGSERIAL PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT');
  const run = (sql, params = []) => {
    const rows = raw.prepare(translate(sql)).all(...params);
    return { rows: rows.map((r) => ({ ...r })) };
  };
  return {
    query: async (sql, params) => run(sql, params),
    async tx(fn) {
      raw.exec('BEGIN');
      try {
        const result = await fn({ query: async (sql, params) => run(sql, params) });
        raw.exec('COMMIT');
        return result;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    close: async () => raw.close(),
  };
}

module.exports = { createSqliteDb };
