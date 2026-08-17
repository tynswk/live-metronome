pdf.js 4.10.38 (Mozilla, Apache License 2.0)
https://github.com/mozilla/pdf.js

pdf.js        = 配布物 build/pdf.min.mjs をリネームしたもの
pdf.worker.js = 配布物 build/pdf.worker.min.mjs をリネームしたもの

拡張子を .mjs から .js に変えているのは、.mjs を text/plain で返す
静的サーバーがあり、その場合モジュールとして読み込めなくなるため。
