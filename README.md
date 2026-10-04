# DeviantArt mobile fix

Пользовательский стиль для [Stylus](https://add0n.com/stylus.html), который чинит мобильную вёрстку deviantart.com (проверялось в Firefox для Android).

## Что исправляет

- Картинки в лентах («More like this», главная, подписки) показываются целиком, на всю ширину экрана, а не обрезаются под одну высоту.
- Скрыта плашка «Use the DeviantArt Web App» внизу экрана.

## Установка

1. Установите Stylus: [Firefox](https://addons.mozilla.org/firefox/addon/styl-us/) (в том числе Firefox для Android).
2. Откройте ссылку и подтвердите установку в Stylus:
   **[deviantart-fix.user.css](https://raw.githubusercontent.com/a-bugaev/deviantart-fix/main/deviantart-fix.user.css)**

Stylus будет сам проверять обновления по этой ссылке.

## Отладка

`userAgent.html` — вспомогательная страница: показывает User Agent, размер вьюпорта и DPR устройства, удобно для настройки режима адаптивного дизайна в десктопном Firefox.
