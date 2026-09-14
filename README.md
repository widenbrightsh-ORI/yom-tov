# יום טוב

צ'קליסט יומי לתקופת מילואים. PWA — מתקינים למסך הבית של האייפון, עובד מלא אופליין.

- `index.html` / `app.js` / `styles.css` — האפליקציה (ללא build)
- `sw.js` — service worker (network-first, נופל למטמון אופליין)
- `manifest.webmanifest`, `icons/` — התקנה למסך הבית

הנתונים נשמרים מקומית במכשיר (localStorage). ייצוא CSV/JSON ממסך ההגדרות.
