# Ferdium recipe template

Copy this directory to `recipes/<service-name>` and replace the placeholder files.

Typical recipe files:

- `package.json` — Recipe manifest. Contains metadata (ID, name, version) and service URLs.
- `index.js` — the recipe’s “backend”. Can be used, for example, to spoof the User-Agent.
- `webview.js` — the recipe’s “frontend”. As a rule, it is responsible for counting the number of notifications (unread) and intercepting clicks on links.
- `service.css` — CSS edits for the service.
- `icon.svg` — the service icon.

# Шаблон рецепта Ferdium

Скопируйте этот каталог в `recipes/<service-name>` и замените файлы-заглушки.

Типичные файлы рецептов:

- `package.json` — Манифест рецепта. Содержит метаданные (ID, название, версию) и URL-адреса сервиса.
- `index.js` — "бэкенд" рецепта. Может использоваться к примеру для подмены User-Agent. 
- `webview.js` — "фронтенд" рецепта. Как правило отвечает за подсчет количества уведомлений (непрочитанных), перехват кликов по ссылкам.
- `service.css` — CSS правки для сервиса.
- `icon.svg` — иконка сервиса.
