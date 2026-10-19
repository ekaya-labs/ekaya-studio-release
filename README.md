# Ekaya Studio

Ekaya Studio 데스크톱 앱 다운로드 전용 레포입니다. 소스코드는 이 레포에 없으며, 별도 private 레포에서
빌드되어 여기 [Releases](../../releases)에만 게시됩니다.

## 다운로드

[Releases](../../releases) 탭에서 플랫폼에 맞는 파일을 받으세요.

- Windows: `.exe` (설치 프로그램) 또는 `.msi`
- macOS: `.dmg`
- Linux: `.deb` 또는 `.AppImage`

마크다운 편집기, Git 익스플로러, 데이터 모델러(ERD), DB 클라이언트, 이미지 스튜디오, 파일 비교,
터미널/RDP, 칸반, 메신저 등을 한 창에서 전환하며 씁니다.

## 자동 업데이트

설치된 앱은 `devvault-latest` 릴리스를 통해 새 버전을 확인합니다. 버전 이력은
`devvault-v{version}` 태그로 남습니다.

> 태그와 파일 이름에 남아 있는 `devvault` / `DevVault`는 내부 프로젝트 이름입니다. 이미 배포된
> 설치본의 자동 업데이트 경로가 여기에 묶여 있어 그대로 유지합니다.

## 문의 · 제보

- 버그 제보와 기능 제안: [Issues](../../issues/new/choose)
- 사용법 질문, 아이디어, 사용례: [Discussions](../../discussions)

### 구글 폼으로 보낸 제보 (GitHub 계정이 없을 때)

앱의 「계정 없이 보내기」는 구글 폼을 엽니다. 폼으로 받은 제보는 매시간 이 저장소의 이슈(질문은 Discussions Q&A)로 옮겨집니다.

- 연락처(이메일)는 **옮기지 않습니다.** 답장 용도로만 쓰고 90일 뒤 삭제합니다.
- 본문의 사용자 경로·IP·긴 토큰은 가려서 올립니다.
- 본문에 이메일·전화번호가 있거나 스팸으로 보이는 제보는 자동으로 올리지 않고 보류한 뒤 담당자가 확인합니다.
- 옮기는 스크립트: [`.github/feedback-sync/`](.github/feedback-sync), 워크플로: [`feedback-sync.yml`](.github/workflows/feedback-sync.yml).
