# Yes24 장바구니 일괄 담기 Chrome Extension

Yes24 도서 URL 목록을 입력받아 장바구니에 자동으로 일괄 담아주는 Chrome Extension.

## 기술 스택
- Chrome Extension Manifest V3
- Vanilla JavaScript (빌드 도구 없음)
- 한국어 UI

## 컨벤션
- 주석 및 UI 텍스트: 한국어
- 세미콜론 사용
- Content Script: 매니페스트 선언 없이 programmatic injection

## 핵심 아키텍처
- **popup**: URL 입력 + 진행률/결과 표시
- **service-worker**: 배치 오케스트레이션 (탭 생성 → 스크립트 주입 → 결과 수집)
- **content-script**: Yes24 페이지에서 장바구니 버튼 클릭 + 결과 감지 (DOM 자동화)

## 상세 문서
- 요구사항/UI 설계: [`docs/PRD.md`](docs/PRD.md)
- 기술 설계/구현 명세: [`docs/TRD.md`](docs/TRD.md)

## 테스트
1. `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다"로 프로젝트 폴더 로드
2. Yes24에 로그인 후 Extension 팝업에서 URL 입력하여 테스트
