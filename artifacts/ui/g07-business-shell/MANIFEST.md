# G07 Business Workspace V1 - screenshots

Served build: assets index-lgqX5Ef_.js + index-C8Qbw5_b.css | git HEAD 1a80168 | /api/v1/version commitSha=null

Captured against the live kernel on http://127.0.0.1:18181 with a real sign-in, an English/Chinese
locale preference and a light/dark theme preference set before first paint.

| file | URL | viewport | theme | locale | scrollWidth - clientWidth |
| --- | --- | --- | --- | --- | --- |
| app-home-1440-light-zh-CN.png | /app/home | 1440 | light | zh-CN | -15px |
| app-incidents-1440-light-zh-CN.png | /app/incidents | 1440 | light | zh-CN | -15px |
| app-home-1024-light-zh-CN.png | /app/home | 1024 | light | zh-CN | -15px |
| app-incidents-1024-light-zh-CN.png | /app/incidents | 1024 | light | zh-CN | -15px |
| app-home-390-light-zh-CN.png | /app/home | 390 | light | zh-CN | -15px |
| app-incidents-390-light-zh-CN.png | /app/incidents | 390 | light | zh-CN | -15px |
| app-home-1440-dark-zh-CN.png | /app/home | 1440 | dark | zh-CN | -15px |
| app-incidents-1440-dark-zh-CN.png | /app/incidents | 1440 | dark | zh-CN | -15px |
| app-home-1024-dark-zh-CN.png | /app/home | 1024 | dark | zh-CN | -15px |
| app-incidents-1024-dark-zh-CN.png | /app/incidents | 1024 | dark | zh-CN | -15px |
| app-home-390-dark-zh-CN.png | /app/home | 390 | dark | zh-CN | -15px |
| app-incidents-390-dark-zh-CN.png | /app/incidents | 390 | dark | zh-CN | -15px |
| app-home-1440-light-en.png | /app/home | 1440 | light | en | -15px |
| app-incidents-1440-light-en.png | /app/incidents | 1440 | light | en | -15px |
| app-home-1024-light-en.png | /app/home | 1024 | light | en | -15px |
| app-incidents-1024-light-en.png | /app/incidents | 1024 | light | en | -15px |
| app-home-390-light-en.png | /app/home | 390 | light | en | -15px |
| app-incidents-390-light-en.png | /app/incidents | 390 | light | en | -15px |
| app-home-1440-dark-en.png | /app/home | 1440 | dark | en | -15px |
| app-incidents-1440-dark-en.png | /app/incidents | 1440 | dark | en | -15px |
| app-home-1024-dark-en.png | /app/home | 1024 | dark | en | -15px |
| app-incidents-1024-dark-en.png | /app/incidents | 1024 | dark | en | -15px |
| app-home-390-dark-en.png | /app/home | 390 | dark | en | -15px |
| app-incidents-390-dark-en.png | /app/incidents | 390 | dark | en | -15px |
| app-403-workspace-only.png | /admin/nodes -> /403 | 1440 | light | zh-CN | 0px |

`scrollWidth - clientWidth` is measured on `documentElement`. The reserved scrollbar gutter
(`scrollbar-gutter: stable`) makes a page that does not scroll report `-15px`; a positive value
would mean horizontal scrolling.

The 403 shot stubs only the server grant (workspace-only), exactly like tests/ui/dual-surface.spec.ts;
the guard, the page and the denial are the real implementation.