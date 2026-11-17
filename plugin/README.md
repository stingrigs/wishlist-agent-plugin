# Wishlist for AI assistants

Wishlist is a private wish list in Telegram. This plugin lets an AI assistant (Claude, Codex or ChatGPT) read and change
**your own** wishes and collections when you ask it to.

## What you can ask

- «Show my wishes.»
- «Add a wish: a coffee grinder, with this link.»
- «Put the coffee grinder in my Birthday collection.»
- «Which of my wishes are not in any collection?»
- «Archive the wish about the old headphones.»

This is an early version. You need Telegram, the [Wishlist bot](https://t.me/wishlist4ubot) and your account in it.
Connecting is currently open to a limited group of people: if the bot refuses to connect you, you are probably not in the group
yet, so write to the bot. The plugin is only configuration: it holds no code, no hooks and no secrets. The assistant talks to
this address:

```text
https://mcp.wishlist-bot.duckdns.org/mcp
```

## Install

The first sign-in sends you to the Wishlist bot, where you confirm the connection.

### ChatGPT

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), press the plus button and choose **Add custom MCP server**.
2. Name: `Wishlist`. Under **Connection**, choose the public address (not **Tunnel**) and paste the address above as the **Server URL**.
3. **Authentication**: choose **OAuth**. Do not choose «OAuth or no authentication»: ChatGPT then stops with «The MCP server denied access».
4. Open the advanced OAuth settings: registration method **Client Identifier Metadata Document (CIMD)**, which is how ChatGPT
   identifies itself to the server, and tick the default scopes (permissions) `wishlist:read` and `wishlist:write`.
5. Tick **I understand and want to continue**, press **Create as a plugin**, then **Connect Wishlist**, and confirm in the Wishlist bot.

A step-by-step guide with the same steps is in
[docs/chatgpt.md](https://github.com/stingrigs/wishlist-agent-plugin/blob/main/docs/chatgpt.md).

### Claude Code

```bash
claude mcp add --transport http --scope user wishlist https://mcp.wishlist-bot.duckdns.org/mcp
```

Then run `/mcp` inside Claude Code and sign in to `wishlist`.

### Codex

```bash
codex mcp add wishlist --url https://mcp.wishlist-bot.duckdns.org/mcp
codex mcp login wishlist
```

## Safety and privacy

- The assistant works with your own wishes and collections. In a collection you own or co-author (one you share with people
  who add their own wishes) it also reads the titles and descriptions of other people's wishes. What it reads goes to the AI
  service you use.
- It cannot delete anything for good, accept an invitation, or see likes or who liked.
- A change that other people would see needs your confirmation in the assistant.
- You confirm every connection in the Wishlist bot, and you can disconnect any time: **Settings, Connected apps** in the bot (the bot speaks Ukrainian, where they are «Налаштування» and «Підключені застосунки»).
- The privacy notice and terms are not published yet; they will be linked here.

## If it does not work

- The bot says «🔒 Підключення недоступне» (connection unavailable, in Ukrainian): the link lasts 10 minutes. Start connecting again. If it happens again, you may not be in the group that can connect yet: write to the bot.
- The code in the bot differs from the code on the page: do not confirm. Cancel and start again.
- ChatGPT says «The MCP server denied access»: check that **Authentication** is **OAuth**.
- The assistant sees no wishlist tools after connecting: start a new chat.
- Anything else: write to the [Wishlist bot](https://t.me/wishlist4ubot).

## More

MIT license (see `LICENSE`). The icon is the Wishlist mark and is not covered by the MIT license: do not reuse it for other
products.
