#!/bin/sh
# Publish .ghpages/ to the gh-pages branch of the origin remote.
set -e
cd .ghpages
git init -q
git checkout -q -b gh-pages
git add -A
git -c user.name="$(git -C .. config user.name)" -c user.email="$(git -C .. config user.email)" commit -q -m "Deploy"
git push -f "$(git -C .. remote get-url origin)" gh-pages
cd ..
rm -rf .ghpages
