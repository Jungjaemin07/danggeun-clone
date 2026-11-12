// 인증 메일 발송. 환경변수로 방식을 고릅니다.
//   MAIL_PROVIDER=gmail  → Gmail SMTP (내 컴퓨터 개발용. Render 무료 서버에서는 SMTP 포트가 막혀 있어 동작하지 않아요)
//   MAIL_PROVIDER=resend → Resend HTTPS API (배포용. 포트 제한 없음, 보내는 도메인 인증 필요)
// 설정이 없으면 null을 돌려주고, 개발 모드에서는 서버 터미널에 코드를 출력하는 consoleMailer를 씁니다.
'use strict';

function buildMessage(code, appName) {
  const subject = `[${appName}] 이메일 인증 코드 ${code}`;
  const text = `${appName} 이메일 인증 코드: ${code}\n\n10분 안에 입력해 주세요.\n본인이 요청하지 않았다면 이 메일을 무시해 주세요.`;
  const html = `<div style="font-family:-apple-system,'Malgun Gothic',sans-serif;max-width:420px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">🥕 ${appName}</h2>
    <p style="margin:0 0 16px;color:#495057">아래 인증 코드를 입력해 가입을 완료해 주세요.</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#fff1e8;color:#ff6f0f;text-align:center;padding:18px;border-radius:12px">${code}</div>
    <p style="margin:16px 0 0;color:#868e96;font-size:13px">10분 동안 유효해요. 본인이 요청하지 않았다면 이 메일을 무시해 주세요.</p></div>`;
  return { subject, text, html };
}

function createMailer(env = process.env) {
  const appName = env.MAIL_FROM_NAME || '당근 클론';
  const provider = String(env.MAIL_PROVIDER || (env.RESEND_API_KEY ? 'resend' : env.GMAIL_USER ? 'gmail' : '')).toLowerCase();

  if (provider === 'gmail') {
    const user = env.GMAIL_USER;
    const pass = String(env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''); // 앱 비밀번호는 4자리씩 띄어 보여서 공백 제거
    if (!user || !pass) return null;
    let transport;
    return {
      provider,
      async sendCode(to, code) {
        if (!transport) {
          transport = require('nodemailer').createTransport({
            service: 'gmail', auth: { user, pass },
            connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
          });
        }
        const m = buildMessage(code, appName);
        await transport.sendMail({ from: `"${appName}" <${user}>`, to, subject: m.subject, text: m.text, html: m.html });
      },
    };
  }

  if (provider === 'resend') {
    const key = env.RESEND_API_KEY;
    const from = env.MAIL_FROM; // 예: no-reply@내도메인.com (Resend에서 인증한 도메인)
    if (!key || !from) return null;
    return {
      provider,
      async sendCode(to, code) {
        const m = buildMessage(code, appName);
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: `${appName} <${from}>`, to: [to], subject: m.subject, text: m.text, html: m.html }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
      },
    };
  }
  return null;
}

// 개발 전용: 실제 메일 대신 서버 터미널에 코드를 보여줍니다.
const consoleMailer = {
  provider: 'console',
  async sendCode(to, code) { console.log(`[개발 모드] ${to} 인증 코드: ${code}`); },
};

module.exports = { createMailer, consoleMailer };
