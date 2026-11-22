#!/usr/bin/env bash
# 게시된 ekaya-studio 판을 winget-pkgs(microsoft/winget-pkgs)에 PR로 낸다.
# 부르는 곳: .github/workflows/winget-submit.yml. 손으로도 돌릴 수 있다(DRY_RUN=1이면 매니페스트만 만들고 멈춘다).
#
# 입력(환경 변수)
#   VERSION        낼 판(예: 0.26.0). 비우면 ekaya-studio-latest 포인터의 latest.json 판
#   GH_TOKEN       이 레포 읽기 — 릴리스·에셋 조회
#   WINGET_TOKEN   ekaya-labs classic PAT(public_repo) — fork에 커밋하고 winget-pkgs에 PR을 연다
#   DRY_RUN        1이면 PR을 내지 않는다
#   OUT_DIR        렌더한 매니페스트를 둘 곳(기본: 임시 폴더)
#
# 왜 komac·wingetcreate가 아닌가: 둘 다 winget-pkgs에 이미 병합된 패키지만 갱신한다. 첫 등록 PR이 검토 중일 때도
# 다음 판을 낼 수 있게, 이 레포의 템플릿(.github/winget/templates)에서 매니페스트를 직접 만든다.
# 설명 글·태그를 바꾸려면 템플릿을 고친다. 근거: ekaya-studio 트랙 docs/tracks/platform/2026-11-22-winget-distribution SPEC §3.
set -euo pipefail

PACKAGE_ID="EkayaLabs.EkayaStudio"
PKG_PATH="manifests/e/EkayaLabs/EkayaStudio"
REPO="${GITHUB_REPOSITORY:-ekaya-labs/ekaya-studio-release}"
UPSTREAM="microsoft/winget-pkgs"
FORK_OWNER="ekaya-labs"
HERE="$(cd "$(dirname "$0")" && pwd)"

note() { echo "::notice::$*"; }
fail() { echo "::error::$*"; exit 1; }

# ── 1. 판 ────────────────────────────────────────────────────────────────
v="${VERSION:-}"
if [ -z "$v" ]; then
  # 포인터 릴리스 이름이 「… (auto-update pointer -> ekaya-studio-vX.Y.Z)」다. 못 읽으면 latest.json의 version.
  v="$(gh api "repos/$REPO/releases/tags/ekaya-studio-latest" -q '.name' | sed -n 's/.*ekaya-studio-v\([0-9][0-9.]*\).*/\1/p')"
  if [ -z "$v" ]; then
    tmp="$(mktemp -d)"; gh release download ekaya-studio-latest -R "$REPO" -p latest.json -D "$tmp"
    v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -1)"
  fi
fi
v="${v#v}"
[ -n "$v" ] || fail "낼 판을 정하지 못했다"
tag="ekaya-studio-v$v"
echo "version=$v tag=$tag"

# ── 2. 게시된 릴리스인가 — Draft는 내지 않는다 ───────────────────────────
draft="$(gh api "repos/$REPO/releases/tags/$tag" -q '.draft' 2>/dev/null || echo missing)"
case "$draft" in
  false) : ;;
  true) note "$tag 는 아직 Draft — winget에 내지 않는다(게시되면 다시 돈다)"; exit 0 ;;
  *) fail "$tag 릴리스를 찾지 못했다" ;;
esac

# ── 3. 묶음 설치본 에셋 ──────────────────────────────────────────────────
asset="$(gh api "repos/$REPO/releases/tags/$tag" -q '.assets[] | select(.name|test("_x64-all-setup\\.exe$")) | "\(.name) \(.digest // "-") \(.browser_download_url)"' | head -1)"
[ -n "$asset" ] || fail "$tag 에 *_x64-all-setup.exe 가 없다 — 묶음 설치본 이름 규칙이 바뀌었나"
read -r name digest url <<<"$asset"
if [[ "$digest" == sha256:* ]]; then
  sha="${digest#sha256:}"
else
  note "에셋 digest가 없다 — 내려받아 계산한다"
  d="$(mktemp -d)"; gh release download "$tag" -R "$REPO" -p "$name" -D "$d"
  sha="$(sha256sum "$d/$name" | cut -d' ' -f1)"
fi
sha="$(echo "$sha" | tr 'a-f' 'A-F')"
date="$(gh api "repos/$REPO/releases/tags/$tag" -q '.published_at' | cut -c1-10)"
echo "asset=$name sha256=$sha date=$date"

# ── 4. 매니페스트 렌더 ───────────────────────────────────────────────────
out="${OUT_DIR:-$(mktemp -d)}/$v"
mkdir -p "$out"
for t in "$HERE"/templates/*.yaml; do
  sed -e "s#__VERSION__#$v#g" -e "s#__URL__#$url#g" -e "s#__SHA256__#$sha#g" -e "s#__DATE__#$date#g" "$t" > "$out/$(basename "$t")"
done
if grep -q "__[A-Z0-9]*__" "$out"/*.yaml; then fail "템플릿 자리표시가 남았다"; fi
echo "rendered: $out"
ls "$out"

if [ "${DRY_RUN:-0}" = "1" ]; then note "DRY_RUN — PR을 내지 않는다"; exit 0; fi
[ -n "${WINGET_TOKEN:-}" ] || fail "WINGET_TOKEN(시크릿 WINGET_PKGS_TOKEN)이 없다"
export GH_TOKEN="$WINGET_TOKEN"

# ── 5. 이미 있거나 열린 PR이 있으면 끝 ───────────────────────────────────
if gh api "repos/$UPSTREAM/contents/$PKG_PATH/$v" >/dev/null 2>&1; then
  note "winget-pkgs에 $PACKAGE_ID $v 가 이미 있다"; exit 0
fi
open="$(gh pr list -R "$UPSTREAM" --state open --author "$FORK_OWNER" --search "$PACKAGE_ID $v in:title" --json number -q 'length')"
if [ "$open" != "0" ]; then note "$PACKAGE_ID $v 열린 PR이 이미 있다"; exit 0; fi

# ── 6. fork에 커밋(클론 없이 git data API) ───────────────────────────────
fork="$FORK_OWNER/winget-pkgs"
gh api "repos/$fork" >/dev/null 2>&1 || { gh repo fork "$UPSTREAM" --clone=false; sleep 10; }
base="$(gh api "repos/$UPSTREAM/git/ref/heads/master" -q .object.sha)"
btree="$(gh api "repos/$UPSTREAM/git/commits/$base" -q .tree.sha)"
tree='['; sep=''
for f in "$out"/*.yaml; do
  b="$(base64 -w0 "$f")"
  s="$(gh api -X POST "repos/$fork/git/blobs" -f content="$b" -f encoding=base64 -q .sha)"
  tree="$tree$sep{\"path\":\"$PKG_PATH/$v/$(basename "$f")\",\"mode\":\"100644\",\"type\":\"blob\",\"sha\":\"$s\"}"; sep=','
done
tree="$tree]"
newtree="$(echo "{\"base_tree\":\"$btree\",\"tree\":$tree}" | gh api -X POST "repos/$fork/git/trees" --input - -q .sha)"
existing="$(gh api "repos/$UPSTREAM/contents/$PKG_PATH" >/dev/null 2>&1 && echo yes || echo no)"
if [ "$existing" = yes ]; then title="New version: $PACKAGE_ID version $v"; else title="New package: $PACKAGE_ID version $v"; fi
commit="$(echo "{\"message\":\"$title\",\"tree\":\"$newtree\",\"parents\":[\"$base\"]}" | gh api -X POST "repos/$fork/git/commits" --input - -q .sha)"
branch="$PACKAGE_ID-$v"
if gh api "repos/$fork/git/ref/heads/$branch" >/dev/null 2>&1; then
  gh api -X PATCH "repos/$fork/git/refs/heads/$branch" -f sha="$commit" -F force=true >/dev/null
else
  gh api -X POST "repos/$fork/git/refs" -f ref="refs/heads/$branch" -f sha="$commit" >/dev/null
fi

# ── 7. PR ────────────────────────────────────────────────────────────────
body="$(mktemp)"
cat > "$body" <<EOF
## 📖 Description

$title — Ekaya Studio, "all apps" edition from the public release repository (https://github.com/$REPO/releases/tag/$tag).
Submitted automatically after the release was published.

## ✅ Checklist

- [x] Signed the [Contributor License Agreement](https://cla.opensource.microsoft.com)
- [ ] Linked to an issue (if applicable)

## 📦 Manifest Checklist

- [x] Checked that there aren't other open [pull requests](https://github.com/microsoft/winget-pkgs/pulls) for the same manifest update/change
- [x] This PR only modifies one (1) manifest
- [ ] Validated manifest locally with \`winget validate --manifest <path>\`
- [ ] Tested manifest locally with \`winget install --manifest <path>\`
- [x] Manifest conforms to the [1.28 schema](https://github.com/microsoft/winget-pkgs/tree/master/doc/manifest/schema/1.28.0)
EOF
pr="$(gh pr create -R "$UPSTREAM" --base master --head "$FORK_OWNER:$branch" --title "$title" --body-file "$body")"
note "winget-pkgs PR: $pr"
echo "pr=$pr" >> "${GITHUB_OUTPUT:-/dev/null}"
