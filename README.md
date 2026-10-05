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

## Secrets never enter the repository

No password, API key, token or credentials file is committed, not even in docs or examples. Read secrets from the environment or from a gitignored file.

The gate has three layers, all driven by [`.gitleaks.toml`](.gitleaks.toml):

1. **pre-commit** (lefthook) scans staged changes with gitleaks.
2. **pre-push** (lefthook) scans every commit that is not yet on a remote.
3. **CI** ([`secret-scan`](.github/workflows/secret-scan.yml)) scans the PR range, so `--no-verify` does not get a secret past it.

Set up once per clone: `brew install gitleaks lefthook && lefthook install`.

A secret that was ever pushed is compromised. Removing it from the tree does not unpublish it, so rotate it at the provider.
