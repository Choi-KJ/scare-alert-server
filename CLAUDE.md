# CLAUDE.md — scare-alert-server (백엔드)

이 저장소는 **3,2,1 와!** 서비스의 백엔드입니다. 확장프로그램(`../scare-alert-extension`)은 별도 저장소이며, 여기서는 **웹사이트 + 확장용 API**를 하나의 서버가 겸합니다.

## 작업 지침
- 한국어로 답변합니다.
- **작성자(사용자)는 Spring Boot 경험이 있는 백엔드 개발자이지만 Node.js/TypeScript는 초보입니다.** Node/TS 특유의 개념(async/await, ESM import, 타입, DI가 없다는 점 등)이 나오면 Spring/Java에 매핑해 간단히 설명하며 진행하세요.
- 범위가 큰 변경(여러 파일, 스키마/아키텍처 변경)은 먼저 알리고 확인받습니다.

## 한 줄 요약
공포영화 점프스케어 3초 전 카운트다운을 보여주는 크롬 확장의 백엔드. 사용자 제보(크라우드소싱)로 타임스탬프를 모아 **집계 → 확정**하고, 확장이 조회한다. 동시에 영화 소개/후원 **웹사이트**도 이 서버가 서빙한다.

## 핵심 전제 (확장 저장소 CLAUDE.md와 공유)
- 타임스탬프는 운영자가 만들지 않고 **전량 사용자 제보**로 수집. 파이프라인: **제보 → 검수/집계 → 확정 → 알림 반영**.
- **어뷰징 방지가 최우선순위 중 하나** — 빈도 제한, 중복 제거, 다중 세션 조건, 이상치 제거.
- **타임스탬프는 "영화"가 아니라 "(플랫폼, 콘텐츠ID)"에 묶는다** — 같은 영화라도 플랫폼 버전마다 재생시간이 어긋남.
- DB 접속정보는 **서버에만** 둔다(확장은 API만 호출). CORS로 확장 origin 허용.
- 자세한 기획: `PLANNING.md`, 랜딩 디자인: `DESIGN.md`.

## 기술 스택
- **Node.js + TypeScript** (실행: `tsx`, 빌드 단계 없이 TS 직접 실행)
- **Hono** — 웹 프레임워크 (Spring Web 자리. 경량, DI/애노테이션 없음, `c` Context 하나로 req/res)
- **Drizzle ORM + mysql2** — DB 레이어 (jOOQ + Flyway 자리. 타입 안전 SQL + 마이그레이션. JPA식 영속성 컨텍스트/dirty checking 없음 → UPDATE는 명시적)
- **Zod** — 입력 검증 (Bean Validation `@Valid` 자리)
- **MariaDB**

## 구조 (레이어드 — Spring의 Controller→Service→Repository와 매핑)
```
src/
  index.ts        # 앱 진입점: 미들웨어 + API 라우트 + /admin + 정적(public) 서빙 + 첫 관리자 시딩
  config.ts       # 환경변수 (DB, ADMIN_USER/PASSWORD, SESSION_SECRET)
  db/
    schema.ts     # Drizzle 스키마: movies / platform_contents / submissions / confirmed_timestamps
                  #                 / admins / admin_login_attempts
    client.ts     # 커넥션 풀(UTC 세션) + db 인스턴스
  routes/
    submissions.ts   # POST /api/submissions
    timestamps.ts    # GET  /api/timestamps
    admin.ts         # /admin/* : 세션 로그인, 관리자 관리, 콘텐츠 목록/상세, 수동 등록/삭제 (Hono HTML 렌더)
  services/
    submissionService.ts   # 제보 저장 → 어뷰징 검사 → 재집계
    adminService.ts        # 관리자 계정(bcrypt) + 로그인 감사 로그 조회
    contentService.ts      # 콘텐츠 목록/상세 집계 + 수동 타임스탬프 add/delete
  lib/
    aggregate.ts    # buildClusters(모든 묶음) + aggregateReports(확정) + recomputeConfirmed. 대표 강도(최빈) 포함
    rateLimit.ts    # 제보 어뷰징 방지: 세션 빈도 제한 + 중복 제거
    loginRateLimit.ts # 관리자 로그인 무차별 대입 방지(IP 5회/15분)
public/           # 정적: index.html=랜딩, admin.css(관리자 공용), *.svg
drizzle/          # 마이그레이션 SQL (0000~0004)
```
**구현 완료(2026-08-02):**
- 제보 API·집계/확정·어뷰징 방지 실DB 검증, 확장과 실환경 연동(제보 수신 + 확정 조회 카운트다운).
- **관리자**: 세션 로그인 + DB `admins`(다중, bcrypt) + 첫 관리자 시딩 + 무차별 대입 방지 + 로그인 감사 로그.
- **관리자 페이지**: 사이드바 쉘 + 대시보드(내용 추후) / 콘텐츠 목록·상세(확정·클러스터) / 수동 타임스탬프 등록·삭제 / 확정 강도(최빈) 표시.

**아직 없는 것(예정):** 클러스터 확정 승격·반려, 영화(canonical) 연결, 대시보드 내용, 집계 M 상향(3+), 단위 테스트, 배포(HTTPS + 쿠키 secure).

## 명령어
- `npm run dev` — 개발 서버(파일 변경 시 자동 재시작, http://localhost:3000)
- `npm run typecheck` — 타입 체크
- `npm run db:generate` — 스키마 → 마이그레이션 SQL 생성 (DB 접속 불필요)
- `npm run db:migrate` — 마이그레이션 적용 (`.env`의 DB 접속정보 사용)
- `npm run db:push` — 개발용 즉시 반영 (Hibernate ddl-auto 느낌)
- `npm run db:studio` — DB GUI

## 시작 순서 (로컬)
1. MariaDB에 DB 생성: `CREATE DATABASE scare_alert;`
2. `.env.example` → `.env` 복사 후 접속정보 채우기 (`.env`는 커밋 금지)
3. `npm install`
4. `npm run db:migrate` (또는 개발 중 `npm run db:push`)
5. `npm run dev`

## 커밋 전 체크리스트
- [ ] `.env`·DB 접속정보 등 민감정보가 코드/커밋에 없는지 (`.env`는 `.gitignore` 포함)
- [ ] 제보 관련 로직에 검증/어뷰징 방지 고려가 빠지지 않았는지
- [ ] 확장이 보내는 제보 페이로드 형태가 확장의 `Submission` 타입과 정합하는지
- [ ] CORS 설정이 과도하게 열려 배포되지 않는지 (배포 시 확장 origin으로 제한)
