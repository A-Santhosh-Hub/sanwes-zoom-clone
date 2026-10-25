# Accounts

Everyone needs a SanWe's account to join, create or schedule a meeting. Accounts live **on the computer that runs SanWe's**
(no outside service). Analysis of how Zoom does it: [ZOOM_ACCOUNTS_REPORT.md](ZOOM_ACCOUNTS_REPORT.md).

## For people using it

1. Open the link. You see **Sign in / Create account**.
2. **Create account**: username, password (twice), email (twice), and optionally the name shown in meetings.
   Passwords need 8+ characters with letters and a number. Your email is not verified or shared.
3. **Sign in** with the username or the email. Tick **Keep me signed in** to stay signed in for 30 days.
4. The round picture at the top right is your **account menu**: My profile (name, picture, change password, sign out of all
   devices, delete my account), Settings, Sign out.
5. Forgot your password? Ask the administrator (see below). Nothing is sent by email.

An invitation link (`...?room=ID`) works as before: sign in (or create an account), then the Join dialog opens for that meeting.

## For the administrator (the person running SanWe's)

- **The first account created on a computer is the administrator.** Create yours before sharing the link.
- Avatar menu > **Accounts on this computer**: every account with its email, role and last sign-in; **Reset password** (tell the
  person the new one; they can change it), **Make admin / Remove admin**, **Delete**.
- Forgot your own administrator password and nobody else is an administrator? With SanWe's stopped:
  `node server\tools\users.mjs reset <username> <new password>`, then start it again. Other commands: `list`, `admin <username>`, `delete <username>`.
- Files (back them up together with `data\meetings.json`): `data\users.json` (accounts, password hashes) and `data\sessions.json`
  (signed-in browsers, token hashes only). Keep them private; do not commit them.

## The password list (for the administrator)

People forget the password they chose. So that you can tell it back to them, SanWe's keeps a **separate, encrypted record** of the passwords people choose:

- **Where:** avatar menu > **Accounts on this computer** > **Password list**. Each row has **Show** (visible for 10 seconds) and **Copy**; **Download the list (.txt)** makes a text file on demand.
  Only an administrator can open it. Every opening or download is written to `data\logs\admin.log`.
- **What is recorded:** the password chosen at sign-up, a password the person changed, a password you reset. Not recorded: passwords of accounts made **before** this
  feature existed (their row says "not saved"): click **Reset password** for that person once, tell them the new one, and it is recorded from then on.
- **How it is kept:** in `data\vault\passwords.vault`, each password encrypted (AES-256-GCM); the key is the separate file `data\vault\vault.key`. Sign-in does **not** use
  this file: it still checks the scrambled hash in `users.json`. The sign-up form tells people that the administrator can look up their password, and not to reuse one from another website.
- **Trade-off, honestly:** a readable record of everybody's password is less safe than none. Anyone who gets the administrator account, or both vault files, can read them,
  and people often reuse passwords. Give a password back only to its owner, in person; delete downloaded `.txt` lists after use; do not back up `data\vault\vault.key` next to the vault.
  `make-copy-for-another-pc.bat` never copies `data\`, so the vault stays on its own computer.
- **Switch it off** with `KEEP_PASSWORDS=off` in `.env` (nothing is recorded then; `data\vault` can be deleted). The command-line tool `node server\tools\users.mjs reset <username> <password>` also records the new password.

## Meetings and roles

- You are **host** of the meetings you create or schedule, from any browser, as long as you are signed in. You can make others
  **co-host** and **hand the host role over**; these follow accounts, so they survive reloads and rejoining.
- Scheduled meetings, Personal Meeting ID and reminders belong to your account and appear wherever you sign in.
  Meetings scheduled **before accounts existed** belonged to a browser key and can no longer be opened (they are not deleted).
- Your name in a meeting is your account's display name.

## Safety measures

| What | How |
|---|---|
| Passwords | salted scrypt hash, never stored or logged; common and too-short passwords refused |
| Guessing | 5 wrong tries for one name (or 12 from one address) within 10 minutes locks sign-in for that name for a while; unknown names get the same message and take the same time |
| Sessions | random token in an HttpOnly, SameSite=Lax cookie (Secure over HTTPS); only a hash is kept on the server; sliding expiry; revoked on sign-out, password change, delete |
| Other websites | state-changing requests from another origin are refused |
| New accounts | limited per address per hour (`SIGNUP_RATE_MAX`, default 10) |

## Limits

- No email is sent or verified, so there is no "reset link". Recovery is the administrator.
- Anyone who can reach your public link can create an account. If you do not want that, share the link only with people you
  trust, or ask them to tell you their username and watch the Accounts list; an approval step is not built yet.
- Everything is on one computer: if its disk is lost, so are the accounts.
