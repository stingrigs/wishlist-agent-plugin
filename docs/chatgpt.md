# Підключення Wishlist до ChatGPT

[English](chatgpt.en.md)

Wishlist — це приватний список бажань у Telegram. Коли ChatGPT підключено, він може показувати й додавати **твої власні**
бажання та добірки, коли ти просиш. Тобі потрібні ChatGPT, Telegram і твій акаунт у [боті Wishlist](https://t.me/wishlist4ubot).
Підключення зараз відкрите для обмеженого кола людей.

Адреса сервера:

```text
https://mcp.wishlist-bot.duckdns.org/mcp
```

## Додай сервер у ChatGPT

1. Відкрий [ChatGPT Plugins](https://chatgpt.com/plugins), натисни плюс і вибери **Add custom MCP server**.
2. **Name**: `Wishlist`. **Description** — за бажанням.
3. **Choose icon** — за бажанням. Підходить PNG до 10 КБ.
4. У розділі **Connection** обери публічну адресу (не **Tunnel**) і введи адресу вище як **Server URL**. Вона має закінчуватися
   на `/mcp`.
5. **Authentication**: вибери **OAuth**. Не вибирай «OAuth or no authentication»: тоді ChatGPT зупиняється з повідомленням
   «The MCP server denied access».
6. Відкрий **Advanced OAuth settings**:
   - **Registration method**: **Client Identifier Metadata Document (CIMD)**. Так ChatGPT представляється серверу.
   - **Default scopes**: познач `wishlist:read` і `wishlist:write`. **Base scopes** лиши порожніми.
   - OIDC не вмикай. Форма пише «This server did not advertise an OIDC configuration URL»: це нормально.
7. Познач **I understand and want to continue** і натисни **Create as a plugin**.
8. ChatGPT покаже **Connect Wishlist**. Натисни: у браузері відкриється сторінка Wishlist.

## Підтверди в Telegram

1. Сторінка просить відкрити Telegram. Натисни «Відкрити в Telegram». Посилання діє 10 хвилин.
2. Бот покаже «🔌 Підключити «ChatGPT»?» з коротким кодом. **Код має збігатися з кодом на сторінці.** Якщо не збігається,
   не підтверджуй.
3. Натисни «✅ Підключити». Щоб відмовитися, натисни «✖️ Не підключати».
4. Бот напише «✅ Підключено «ChatGPT»», а сторінка поверне тебе до ChatGPT.

## Спробуй

Почни нову розмову й запитай:

- «Хто я у Wishlist?»: ChatGPT назве твій акаунт і скільки в тебе бажань та добірок.
- «Створи бажання «Тест».»: бажання з’явиться в боті.

## Якщо не працює

| Що ти бачиш | Що робити |
| --- | --- |
| У формі: «The MCP server denied access» | У **Authentication** має бути **OAuth**, а не «OAuth or no authentication». Адреса має закінчуватися на `/mcp`. |
| Немає пункту **Add custom MCP server** | Твій акаунт ChatGPT або робочий простір може не дозволяти власні сервери. Спитай адміністратора. |
| Бот пише «🔒 Підключення недоступне» | Посилання діє 10 хвилин або його вже використано. Натисни **Connect Wishlist** ще раз. Якщо знову те саме, імовірно, тебе ще немає в колі, якому відкрите підключення: напиши боту. |
| Код у боті не збігається з кодом на сторінці | Не підтверджуй. Натисни «✖️ Не підключати» і почни спочатку. |
| ChatGPT не бачить інструментів Wishlist | Почни нову розмову. Якщо не допомогло, відкрий підключення в **ChatGPT Plugins** і натисни **Refresh**. |

З усім іншим напиши [боту Wishlist](https://t.me/wishlist4ubot).

## Відключення

У боті Wishlist відкрий «⚙️ Налаштування» › «🔌 Підключені застосунки» і натисни «✖️ Відключити ChatGPT». Доступ зупиняється
одразу.
