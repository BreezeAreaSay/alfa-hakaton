# Презентация для жюри

Слайды решения: 16:9, один слайд — одна страница PDF. Исходник — [slides.html](slides.html) (HTML и CSS), сборка — [build.mjs](build.mjs), результат — `docs/Презентация.pdf`.

## Как пересобрать

```bash
cd tools/presentation
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node build.mjs
```

Без `PW_CHROMIUM_PATH` берётся браузер Playwright (`npx playwright install chromium` в `tools/docs-pdf`). Сборка занимает несколько секунд и печатает заголовки слайдов, масштаб экранов, путь к PDF, число страниц и размер.

Нужно: Node.js 22.12 или новее; `frontend/node_modules` (`cd frontend && npm ci`) — шрифт Onest и логотип из `@alfalab/icons-logotype`; `tools/docs-pdf/node_modules` (`cd tools/docs-pdf && npm ci`) — Playwright. `pdfinfo` и `pdffonts` из poppler-utils — по желанию, для проверок готового PDF.

## Что где менять

- **Числа** — объект `DATA` в начале `slides.html`, у каждого числа указан источник. В тексте на них ссылается атрибут `data-v="ключ"`; `data-forms="тест|теста|тестов"` добавляет слово в нужной форме.
- **Экраны** — из `docs/screenshots`. Кадр задаёт `data-crop="x y ширина высота"` у картинки, размер рамки — `data-w` или `data-h`. Исходные PNG не меняются: кадр вырезается при сборке, и в PDF попадает только он.
- **Предпросмотр** — `slides.html` через любой локальный веб-сервер из корня репозитория, например `python3 -m http.server` и <http://localhost:8000/tools/presentation/slides.html>.

## Проверки при сборке

Сборка останавливается с ошибкой, если в `DATA` нет значения или не загрузились шрифт, логотип или экран. Предупреждает, если блок выходит за край слайда или текст не помещается в свой блок, шрифт мельче 20 px, слайдов не 13–14, в PDF другое число страниц или есть шрифты кроме Onest. `--strict` превращает предупреждения в код выхода 1, `--out <путь>` меняет путь к PDF.
