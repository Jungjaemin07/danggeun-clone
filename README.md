# 당근마켓 클론

의존성 없이 Node.js(18+)만으로 동작하는 중고거래 앱입니다.

## 실행

```bash
node server.js        # http://localhost:3000  (PORT=4000 node server.js 로 포트 변경)
```

처음 실행하면 더미 데이터가 담긴 `data.json`이 자동 생성됩니다. 초기화하려면 이 파일을 지우고 다시 실행하세요.
휴대폰 화면 비율(최대 480px)로 설계되어 있어요. 브라우저 개발자도구의 모바일 보기로 확인해 보세요.

## 구조

```
server.js          # HTTP 서버 + REST API + JSON 파일 저장
public/index.html  # 프론트엔드 (해시 라우팅 SPA, 단일 파일)
data.json          # 실행 시 생성되는 DB
```

## 기능

- 홈: 내 동네 기준 피드, 카테고리 필터, 검색, 동네 변경
- 상세: 판매자 매너온도, 관심(하트), 채팅하기, 내 글은 상태 변경(판매중/예약중/거래완료)·삭제
- 글쓰기: 사진 업로드(브라우저에서 800px로 축소) 또는 이모지 대표 이미지
- 채팅: 1:1 채팅방, 1.5초 폴링, 상대방은 데모용 자동 응답
- 거래 후 매너 평가(±0.5℃), 관심목록, 나의 당근(동네·닉네임 설정)

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/meta` | 카테고리, 동네 목록 |
| GET/PATCH | `/api/me` | 내 정보 조회/수정(dong, nickname) |
| GET | `/api/items?dong=&category=&q=&seller=&liked=1` | 상품 목록 |
| GET/PATCH/DELETE | `/api/items/:id` | 상세(조회수 +1) / 상태·가격 수정 / 삭제 |
| POST | `/api/items` | 상품 등록 |
| POST | `/api/items/:id/like` | 관심 토글 |
| POST | `/api/users/:id/review` | 매너 평가 `{rating: "good"|"bad"}` |
| GET/POST | `/api/chats` | 채팅 목록 / 채팅방 생성 `{itemId}` |
| GET | `/api/chats/:id` | 채팅방 + 메시지 |
| POST | `/api/chats/:id/messages` | 메시지 전송 `{text}` |

## 한계 (다음 단계 아이디어)

- 로그인이 없고 항상 `id=1` 사용자로 동작합니다. JWT/세션 인증을 붙이면 다중 사용자로 확장할 수 있어요.
- 저장소가 JSON 파일이라 동시 접속이 많으면 SQLite/PostgreSQL로 바꾸는 게 좋아요.
- 이미지는 data URL로 저장합니다. 실서비스에서는 S3 같은 파일 저장소를 쓰세요.
- 채팅은 폴링 방식이에요. WebSocket으로 바꾸면 실시간성이 좋아져요.
