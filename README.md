# 당근마켓 클론

Node.js + PostgreSQL로 만든 중고거래 앱입니다. 이메일 인증 회원가입/로그인, 상품, 관심, 1:1 채팅, 매너온도가 있어요.

```
server.js          # HTTP 서버 + REST API + 인증
schema.js          # 테이블 생성 + 최초 1회 데모 데이터
db.js              # PostgreSQL(pg) 연결
mailer.js          # 인증 메일 발송 (Gmail SMTP / Resend API)
public/index.html  # 프론트엔드 (단일 파일, PC/모바일 반응형)
test/              # API 테스트 (npm test)
```

## 내 컴퓨터에서 실행

1. [Neon](https://neon.com)에서 무료 Postgres를 만들고 연결 문자열을 복사해요. (아래 "배포" 1번 참고)
2. 터미널에서:

```bash
npm install
cp .env.example .env     # 윈도우 PowerShell: Copy-Item .env.example .env
# .env 를 열어 DATABASE_URL 에 복사한 주소를 붙여 넣기
npm run dev              # http://localhost:3000
```

처음 실행하면 테이블이 자동으로 만들어지고 데모 상품 10개가 들어가요.
가입하면 이메일로 6자리 인증 코드가 가고, 코드를 입력해야 계정이 만들어져요.
메일 설정(`.env`의 `MAIL_PROVIDER` 등)을 비워 두면 개발 모드에서는 **인증 코드가 `npm run dev`를 실행한 터미널에 출력**돼요.

### Gmail로 인증 메일 보내기 (내 컴퓨터 테스트용)
1. 구글 계정 → 보안 → **2단계 인증** 켜기
2. https://myaccount.google.com/apppasswords 에서 **앱 비밀번호** 만들기 (16자리)
3. `.env`에 `MAIL_PROVIDER=gmail`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`를 채우기

> Render 무료 웹 서비스는 SMTP 포트(25, 465, 587)로 나가는 연결을 막아서, **배포 서버에서는 Gmail 발송이 안 돼요.** 배포할 때는 아래 Resend 방식을 쓰세요.

## 배포 (Neon + Render, 무료로 시작)

### 1. Neon에서 DB 만들기
1. neon.com 가입 → **New Project** → 지역은 한국에서 가까운 아시아(싱가포르 등) 선택
2. 프로젝트 화면의 **Connect**에서 연결 문자열(`postgresql://...?sslmode=require`)을 복사

### 2. GitHub에 코드 올리기
`.env`와 `node_modules`는 `.gitignore`에 있어서 올라가지 않아요. 처음 한 번 `npm install`을 하면 생기는 `package-lock.json`은 같이 올리세요.

```bash
git add .
git commit -m "Postgres + 로그인 적용"
git push
```

### 3. Render에서 웹 서비스 만들기
1. render.com 가입 → **New → Web Service** → GitHub 저장소 연결
2. 설정
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
   - Health Check Path: `/healthz`
3. **Environment Variables** 추가
   - `DATABASE_URL` = Neon에서 복사한 주소
   - `NODE_ENV` = `production`
   - 메일 설정 (배포에서는 HTTPS API 방식인 Resend 권장): `MAIL_PROVIDER=resend`, `RESEND_API_KEY`, `MAIL_FROM=no-reply@내도메인.com`
     (Resend 가입 → 내 도메인 인증 → API 키 발급. 도메인이 없으면 다른 사람에게 메일을 보낼 수 없어서 인증 가입을 운영하기 어려워요.)
   - 배포(`NODE_ENV=production`)에서 메일 설정이 없으면 서버가 시작되지 않아요.
4. **Create Web Service** → 배포가 끝나면 `https://이름.onrender.com` 주소가 생겨요.

### 무료 플랜의 특성 (2026-11 확인)
- **Render 무료 웹 서비스**: 15분간 요청이 없으면 잠들고, 다시 깨어나는 데 약 1분이 걸려요. 월 750시간까지 무료예요. 파일 시스템은 휘발성이라 데이터는 반드시 DB(Neon)에 저장해야 하는데, 이 앱은 그렇게 만들어져 있어요.
- **Neon 무료**: 프로젝트당 저장 1GB, 월 100 CU-시간, 5분간 쓰지 않으면 DB가 잠들어요(첫 요청이 조금 느려질 수 있어요). 한도를 넘으면 DB가 멈추지만 데이터가 지워지지는 않아요.
- 상품 사진은 DB에 저장돼요(업로드 시 브라우저가 800px로 줄여요). 사진이 많아지면 1GB를 빨리 쓰니, 나중에는 S3/R2 같은 파일 저장소로 옮기는 걸 권장해요.

## 테스트

```bash
npm test      # Node 22.5+ 필요. 메모리 SQLite로 API 로직을 점검해요 (운영 DB는 PostgreSQL)
```

## 보안 메모
- 비밀번호는 scrypt로 해시해서 저장하고, 로그인 세션은 HttpOnly 쿠키(30일)로 관리해요. 세션 토큰은 DB에 해시로만 저장돼요.
- 로그인/가입 시도 횟수를 제한하고, 다른 사이트에서 오는 쓰기 요청(Origin 불일치)은 막아요.
- 인증 코드는 10분 유효, 5회 틀리면 잠기고, 재전송은 60초 간격이에요. 인증 메일 발송은 IP·주소별로 시간당 횟수를 제한해요.
- 비밀번호 재설정, 신고/차단 기능은 없어요. 실제 서비스로 운영하려면 추가해야 해요.
