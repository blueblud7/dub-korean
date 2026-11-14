# DUB Korean

영상에서 **선택한 구간만** 내 목소리로 더빙하는 데스크톱 앱 (macOS / Windows).
Pick segments of a video and dub just those with your own voice.

Copyright © 혜리쌤

## 사용자용
1. [Releases](../../releases)에서 `.dmg`(macOS) 또는 `.exe`(Windows)를 받아 설치합니다.
2. 처음 실행하면 필요한 구성요소(URL 다운로드 도구, 목소리 분리 Demucs)를 앱이 자동으로 내려받습니다.
   Demucs는 약 1GB로 시간이 걸리지만, 그동안에도 다른 기능은 쓸 수 있습니다.
3. 내보낸 영상은 `동영상/DUB Korean` 폴더에 저장됩니다.

> 서명되지 않은 앱이라 처음 열 때 경고가 나올 수 있습니다.
> macOS: 앱을 우클릭 → 열기. (또는 `xattr -cr "/Applications/DUB Korean.app"`)
> Windows: "추가 정보" → "실행".

## 개발
```bash
npm install
npm start            # 앱 실행
node tests/e2e.js    # 가짜 마이크로 녹음→미리듣기→내보내기 자동 테스트
npm run dist:mac     # dmg 빌드 (dist/)
```

## 배포 (GitHub)
`v*` 태그를 푸시하면 GitHub Actions가 macOS(Apple Silicon/Intel)와 Windows 설치 파일을 빌드해 Release에 올립니다.
```bash
git tag v0.1.0 && git push origin v0.1.0
```
