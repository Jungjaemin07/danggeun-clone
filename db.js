// PostgreSQL 연결. server.js와는 query/tx/close 세 가지 함수로만 연결됩니다.
'use strict';
const { Pool, types } = require('pg');

// BIGINT(int8)와 NUMERIC은 기본적으로 문자열로 오므로 숫자로 변환합니다.
// (id, 가격, 시각(ms)은 모두 안전한 정수 범위입니다.)
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

function createPgDb(connectionString) {
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000, // 무료 DB가 잠들어 있다가 깨어나는 시간 고려
  });
  pool.on('error', (e) => console.error('[pg pool]', e.message));

  return {
    query: (text, params = []) => pool.query(text, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (text, params = []) => client.query(text, params) });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* 무시 */ }
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

module.exports = { createPgDb };
