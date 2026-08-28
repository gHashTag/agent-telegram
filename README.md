# agent-telegram — read-only Telegram for agents

    tg login          once, by hand, in a terminal (phone + code + 2FA)
    tg whoami         session state, no secrets
    tg unread         chats with unread messages
    tg dialogs -n 40  chats, newest first
    tg messages <chat|@user> -n 30
    tg search "текст" -n 20
    tg selftest       proves the tool offline, including that it cannot send

`api_id` / `api_hash`: https://my.telegram.org → API development tools.
Both, and the session string, live in the macOS Keychain under service
`telegram-agent`. Nothing is written here.

**It cannot send.** No `sendMessage`, `sendFile`, `forwardMessages`,
`deleteMessages` or `editMessage` call exists in `tg.mjs`, and `tg selftest`
greps the file for one. That check is registered in the campaign loop
(`tri jobs-guards`), so acquiring write authority stops an iteration.

Rationale and traps: `~/skills/telegram-read/SKILL.md`.
