# Security

## Reporting a problem
Please do **not** open a public issue for a security problem. Use GitHub's **Security > Report a vulnerability** (private reporting) on this repository, and describe what you found and how to repeat it.

## What this project does to protect people
- Everyone signs in (passwords stored with scrypt; the first account is the administrator). Sessions use cookies; joining a room needs a server-signed token.
- Rate limits on sign-up, sign-in, token requests and wrong passwords; optional room passcodes and waiting room.
- The administrator's password list is kept in a separate AES-256-GCM encrypted file (`data/vault`), and can be switched off (`KEEP_PASSWORDS=off`).
- **Game Hub** (viewers playing on the streamer's PC) is off by default, and only the streamer's own computer can control it: the local agent refuses anything that arrives through a public link or from another website, input only works while a chosen window is in front, dangerous keys are blocked, there is an emergency stop, and every allow/stop is logged. See [docs/GAME_HUB.md](docs/GAME_HUB.md).

## What you must do when you run it
- The files `.env`, `livekit.yaml` and the `data/` folder hold your secrets and your users' accounts. They are in `.gitignore`; **never commit or share them**. Setup creates fresh ones for every computer.
- Put it behind HTTPS (see `deploy/Caddyfile`) before exposing it to the internet.
- Keep Node.js and the dependencies up to date.

## Known limits
This is a portfolio / learning project that is about 70% finished. It has not had an independent security audit. Do not use it for anything where a breach would be serious.
