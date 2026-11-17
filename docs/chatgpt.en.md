# Connect Wishlist to ChatGPT

[Українською](chatgpt.md)

Wishlist is a private wish list in Telegram. Once ChatGPT is connected, it can show and add **your own** wishes and
collections when you ask. You need ChatGPT, Telegram and your account in the [Wishlist bot](https://t.me/wishlist4ubot).
Connecting is currently open to a limited group of people.

The server address:

```text
https://mcp.wishlist-bot.duckdns.org/mcp
```

## Add the server in ChatGPT

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), press the plus button and choose **Add custom MCP server**.
2. **Name**: `Wishlist`. **Description** is optional.
3. **Choose icon** is optional. It takes a PNG of up to 10 KB.
4. Under **Connection**, choose the public address (not **Tunnel**) and enter the address above as the **Server URL**. It must
   end with `/mcp`.
5. **Authentication**: choose **OAuth**. Do not choose «OAuth or no authentication»: ChatGPT then stops with «The MCP server
   denied access».
6. Open **Advanced OAuth settings**:
   - **Registration method**: **Client Identifier Metadata Document (CIMD)**. This is how ChatGPT identifies itself to the server.
   - **Default scopes**: tick `wishlist:read` and `wishlist:write`. Leave **Base scopes** empty.
   - Leave OIDC off. The form says «This server did not advertise an OIDC configuration URL»: that is expected.
7. Tick **I understand and want to continue** and press **Create as a plugin**.
8. ChatGPT shows **Connect Wishlist**. Press it: a Wishlist page opens in your browser.

## Confirm in Telegram

1. The page asks you to open Telegram. Press **Open in Telegram** (the page is in Ukrainian: «Відкрити в Telegram»). The link works for
   10 minutes.
2. The bot shows «Connect «ChatGPT»?» («🔌 Підключити «ChatGPT»?») with a short code. **The code must match the one on the page.**
   If it does not, do not confirm.
3. Press «✅ Підключити» (Connect). To refuse, press «✖️ Не підключати» (Do not connect).
4. The bot says «✅ Підключено «ChatGPT»» (Connected), and the page returns you to ChatGPT.

## Try it

Start a new chat and ask:

- «Who am I in Wishlist?»: ChatGPT names your account and how many wishes and collections you have.
- «Create a wish called Test.»: the wish appears in the bot.

## If it does not work

| What you see | What to do |
| --- | --- |
| «The MCP server denied access» in the form | **Authentication** must be **OAuth**, not «OAuth or no authentication». The address must end with `/mcp`. |
| There is no **Add custom MCP server** | Your ChatGPT account or workspace may not allow custom servers. Ask the administrator. |
| The bot says «🔒 Підключення недоступне» (Connection unavailable) | The link lasts 10 minutes or was already used. Press **Connect Wishlist** again. If it happens again, you may not be in the group that can connect yet: write to the bot. |
| The code in the bot differs from the code on the page | Do not confirm. Press «✖️ Не підключати» and start again. |
| ChatGPT sees no Wishlist tools | Start a new chat. If that does not help, open the connection on **ChatGPT Plugins** and press **Refresh**. |

For anything else, write to the [Wishlist bot](https://t.me/wishlist4ubot).

## Disconnect

In the Wishlist bot open **Settings, Connected apps** (in Ukrainian: «⚙️ Налаштування», «🔌 Підключені застосунки») and press
«✖️ Відключити ChatGPT» (Disconnect ChatGPT). Access stops at once.
