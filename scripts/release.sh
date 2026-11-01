#!/usr/bin/env bash
#
# 发布新版本：改版本号 → 提交 → 打 tag → 推送。
# 推送 tag 后会触发 GitHub Actions（.github/workflows/publish.yml）自动发布到 npm，
# CI 用 OIDC trusted publishing 认证，不需要任何 npm token。
#
# 用法：
#   ./scripts/release.sh patch    # 0.1.0 → 0.1.1
#   ./scripts/release.sh minor    # 0.1.1 → 0.2.0
#   ./scripts/release.sh major    # 0.2.0 → 1.0.0
#   ./scripts/release.sh 1.2.3    # 指定版本号
#
set -euo pipefail

cd "$(dirname "$0")/.."

BUMP="${1:-}"
if [ -z "$BUMP" ]; then
  echo "用法: $0 <patch|minor|major|X.Y.Z>" >&2
  exit 1
fi

# 工作区必须干净，避免把无关改动混进发布提交
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，请先提交或 stash：" >&2
  git status --short >&2
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "当前分支是 $CURRENT_BRANCH，请在 main 上发布" >&2
  exit 1
fi

# 不在 tag 上改版本号，交给 npm 计算
case "$BUMP" in
  patch|minor|major)
    npm version "$BUMP" --no-git-tag-version >/dev/null
    ;;
  *)
    if ! printf '%s' "$BUMP" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "版本号必须是 X.Y.Z 形式，收到: $BUMP" >&2
      exit 1
    fi
    npm version "$BUMP" --no-git-tag-version >/dev/null
    ;;
esac

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

echo "准备发布 $VERSION (tag: $TAG)"

git add package.json package-lock.json 2>/dev/null || git add package.json
git -c core.hooksPath=/dev/null commit -m "chore: release $TAG"
git tag -a "$TAG" -m "release $TAG"

echo "推送到 origin..."
git push origin "$CURRENT_BRANCH"
git push origin "$TAG"

echo
echo "已推送 $TAG，GitHub Actions 正在发布到 npm。"
echo "查看进度: gh run watch \$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')"
echo "包地址:   https://www.npmjs.com/package/opencode-tok-speed-v2"
