# UETMap Web Client 🚋

> Публичный легковесный веб-клиент интерактивной карты городского электротранспорта (трамваи и троллейбусы) города Ульяновска.

[![Production Status](https://img.shields.io/badge/status-live%20production-emerald.svg)](https://uet-map.ru/)
[![Platform](https://img.shields.io/badge/platform-Web%20%7C%20PWA-blue.svg)](https://uet-map.ru/)
[![Mapping](https://img.shields.io/badge/mapping-Leaflet%201.9-orange.svg)](https://leafletjs.com/)

---

## 📌 Overview

**UETMap Web Client** — клиентское веб-приложение для пассажиров городского транспорта. Обеспечивает интерактивное отображение трамвайных и троллейбусных маршрутов в реальном времени, список остановок с прогнозом прибытия (ETA), предупреждения об изменениях схемы движения (объезды, ремонты путей) и адаптивный интерфейс как для мобильных устройств, так и для десктопа.

* **Рабочий сайт (Production):** [https://uet-map.ru/](https://uet-map.ru/)
* **Русскоязычное зеркало:** [https://ует-мап.рф/](https://ует-мап.рф/)
* **Android-приложение:** [gamedich/uetmap-passenger](https://github.com/gamedich/uetmap-passenger)

---

## 🚀 Key Features

* **🛰️ Мониторинг транспорта в реальном времени:** отображение подвижного состава на линиях с интерполяцией движения и расчётом курсового угла.
* **🗺️ Интерактивная карта маршрутов:** схемы движения трамваев (1, 4, 22, 22К, 107 и др.) и троллейбусов с детализацией остановочных пунктов.
* **⚠️ Оповещения об инцидентах и объездах:** модуль закрытий путей и динамических объездов (`closures_controller`) с автоматической подкраской участков и баннерами предупреждений.
* **⏱️ Расчёт времени прибытия (ETA):** оценка расчётного времени движения вагона до выбранной остановки с учётом средней эксплуатационной скорости.
* **📱 Адаптивный мобильный Bottom Sheet:** удобное жестовое управление списком маршрутов и карточками транспорта на смартфонах.
* **⚡ PWA & Offline Caching:** сервисный воркер (`sw_passenger_beta.js`) и манифест для мгновенной загрузки статических ассетов и автономной работы интерфейса.

---

## 🏛️ Architecture

Веб-клиент спроектирован по принципу модульного SPA (Single Page Application) без тяжелых сторонних фреймворков для максимального быстродействия и минимального потребления памяти:

```
[ Browser / Client ]
  ├── public_beta.html (Semantic HTML5 + Dynamic Bottom Sheet)
  ├── js/
  │    ├── public_app.js (Application Lifecycle, Event Bus, Map Engine)
  │    └── modules/
  │         ├── closures_controller.js (Incident & Detour Overlays)
  │         └── eta_calculator.js (Arrival Prediction Math)
  └── sw_passenger_beta.js (PWA Service Worker & Asset Caching)
         │
         ▼  (HTTPS / Non-blocking REST)
[ Upstream Reverse Proxy / Backend API ]
```

---

## 🛠️ Technology Stack

* **Ядро интерфейса:** Semantic HTML5, Vanilla ES6+ JavaScript, CSS3 + Tailwind Utility Classes.
* **Картография:** [Leaflet 1.9+](https://leafletjs.com/), GeoJSON layer management, custom SVG markers & smooth polyline decorators.
* **Оффлайн / PWA:** Service Worker API, Cache Storage API, Web App Manifest.
* **Сетевой слой:** Fetch API с экспоненциальным backoff и обработкой сетевых сбоев.

---

## 📂 Project Structure

```text
├── frontend/
│   ├── favicon.svg                  # SVG фавикон проекта
│   ├── passenger_beta_manifest.json # PWA Web App Manifest
│   ├── public_beta.html             # Главная страница интерфейса
│   ├── sw_passenger_beta.js         # Service Worker кэширования
│   ├── js/
│   │   ├── public_app.js            # Основная точка входа приложения
│   │   └── modules/
│   │       ├── closures_controller.js # Контроллер инцидентов и объездов
│   │       └── eta_calculator.js      # Модуль оценки времени прибытия
│   └── vendor/                      # Локальные библиотеки (Leaflet, Lucide)
├── .gitignore
└── README.md
```

---

## 🔒 Security & Privacy Boundary

Данный репозиторий содержит **исключительно публичный клиентский код интерфейса**.

В целях безопасности и защиты муниципальной инфраструктуры следующие компоненты изолированы в закрытом серверном репозитории:
* Серверный движок генерации и динамического маскирования картографических тайлов.
* Диспетчерская база данных инцидентов и расписаний.
* Протоколы авторизации служебного персонала и кадровый шлюз (HR).
* Внутренние токены, сессии и сетевые ключи.

---

## 🚦 Project Status

Проект находится в активной стадии публичной эксплуатации (**Public Beta / Live Production**). Регулярно обновляется для поддержки изменений в маршрутной сети города.
