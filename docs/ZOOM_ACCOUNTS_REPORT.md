# Report: how Zoom signs people in and out, and what SanWe's took from it

Audience: the SanWe's developer team. Produced with REA (read-only string scan of the installed Zoom Workplace 7.1.9
components) plus a look at the real client's account menu. Nothing was decompiled and nothing was copied.

## What was and was not done

- Done: REA scan of `zWebService.dll`, `zPreMeetingApp.dll`, `zUIClient.dll`, `zSettingUI.dll`, `zCCIUI.dll` for sign-in, sign-out
  and session identifiers; the account menu of the running client was opened and read (the screenshot was deleted afterwards).
- **Not done, on purpose: signing out of the real Zoom account.** It would lock the account's owner out (nobody here has the
  password), and everything that matters about the sign-in screen is visible in the component names below.
- Not done: decompiling the login code. Zoom's network protocol and credential handling are proprietary and not needed.

## What REA found

| Identifier (file) | What it tells us |
|---|---|
| `login_window_welcome_page`, `login_window_signin_page`, `login_finished`, `LoginFinishedNotify` (zPreMeetingApp) | the login window is a **welcome page, then a sign-in page**, and the app is told when login finishes |
| `zCheckLoginTypeProtocol`, `loginType` (zWebService) | the client first asks the server **what kind of account** it is (password, SSO, Google, ...), then shows the right form |
| `AutoLoginREQ` (`user_name`, `password`, `osec_password`), `autoSignInToken`, `zGetLoginTokenProtocol`, `/app/smartphone/login_token` (zWebService) | "keep me signed in" works with a **token** the server hands out; the password is not kept (the obscured password is only for the one-time automatic login) |
| `passkey_login`, `passkey_bind`, `LoginPasskey`, `/client/passkey/...` | passkeys as another way in |
| `RequestDoneForForgotPassword`, `ZWS::RDFForgotPassword` | forgot-password is a **server request** (the server emails a reset link) |
| `Logout`, `NotifyLogout`, `RequestDoneForLogout`, `clientapi/v1/lobby/logout` | sign-out tells the server, then every part of the client is notified |
| `btn_signout_all` (zSettingUI) | **sign out of all devices** |
| `e2e_autologoff_time`, `SSOEnforceLogoutTime`, `" %logout% Automatically sign users out"` (zWebService) | automatic sign-out after inactivity, set by policy |
| `HandleSignoutAction`, `CalendarLoginMgr::Logout` | linked services (calendar) are signed out with the account |
| `NotifySIPSDKBeforeLogOut`, `CCIUINotifyBeforeLogOut` (zCCIUI) | parts of the app get a "about to sign out" notice so they can stop cleanly |

The account menu of the real client (read on screen): picture and name, the email **masked** (`ab***@example.com`) with a
drop-down, status, **Profile**, **Settings**, **Add account**, **Sign out**.

## How SanWe's follows it

| Zoom | SanWe's |
|---|---|
| Welcome / sign-in pages | one **Sign in / Create account** screen with two tabs; nothing else in the app is reachable before it |
| Ask the account type first | not needed (one kind of account: username or email + password) |
| Token instead of a stored password | the server keeps only a **hash of a random session token**; the browser holds the token in an HttpOnly cookie. **Keep me signed in** = 30 days since last visit; otherwise the sign-in ends when the browser closes or after 24 h idle |
| Passwords | never stored: a **salted scrypt hash** (data/users.json). Rules: 8+ characters, letters and a number, not a common password, not containing the username. Typed twice, as requested; email typed twice too |
| Forgot password by email | **no email is sent** (there is no mail server on this computer). The **administrator resets it** in the Accounts list, or with `node server/tools/users.mjs reset <user> <password>` |
| Sign out, sign out of all devices | both; changing a password also signs out every other device |
| Automatic sign-out after inactivity | 24 h idle for a normal sign-in, 30 days for "keep me signed in" |
| Masked email in the menu | the same (`adm***@host`) |
| Add account | no second account in one browser; sign out and sign in as someone else |
| Policy / SSO / passkeys | not built |

## Roles follow accounts, like a meeting host follows an account in Zoom

- Whoever **creates** a meeting is its **host** and has the co-host tools too. The server remembers the account, so the host is
  the host again after a reload, from another device, or after joining by link; there is no host secret to lose.
- The host can **make co-hosts** and **hand over the host role**. Both are stored against accounts, so a co-host who leaves and
  comes back is still a co-host.
- A person's name in a meeting is their account's **display name**. The browser cannot choose another one.

## Not covered by this change

Automatic start, playing a video and recording on a schedule ("tasks") come next and build on these accounts.
