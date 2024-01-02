#!/bin/bash
cd "`dirname \"$0\"`"
script_path="`pwd`"

cd ..
embed-markdown # Update .md files before embedding the .md files into docs

cd "$script_path"
rm -rf generated
npx jsdoc --configure jsdoc.config.json `find ../src -name '*.js' -type f`

gitHash=`git rev-parse HEAD`
cat ./generated/index.html | sed -e "s/GIT_HASH/${gitHash}/g" > tmp
mv tmp ./generated/index.html
