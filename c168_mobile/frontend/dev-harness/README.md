# dev-harness (dev only — not part of the build)

Headless-browser harness for the mobile add-transaction **account picker**
(`src/pages/transaction/AddTransactionSheet.jsx` → `AccountPicker`) and for the **login form**
(`src/pages/login/LoginPage.jsx`). It exists because the repo has no test runner and these bugs
(typing on a phone losing characters, deleting after filtering: "卡着几秒") can only be reproduced in
a real browser at a phone CPU speed. Both screens now use `src/components/KeyboardOwnedInput.jsx`, so
these checks cover that component too.

Nothing here is bundled: `vite build` only builds `index.html`, so this folder never reaches `dist/`.

## Run

```bash
cd c168_mobile/frontend
npm run dev -- --port 5200 --strictPort   # in another shell
node dev-harness/picker-loop.mjs --n=2000 --throttle=10
```

The login form is the one screen that renders without a backend, so the Android *"the keyboard's text
disappears again"* bug is reproduced on the **real page** there — run the app on 5174 first:

```bash
npm run dev -- --port 5174 --strictPort
node dev-harness/login-loop.mjs                      # 5 checks, all 5 fail on the pre-fix code
node dev-harness/search-sweep.mjs                    # wiring check for the other search boxes
node dev-harness/pin-lock-loop.mjs                   # 15 checks: lock screen + PIN pad + PIN setup
```

`search-sweep.mjs` walks `/account`, `/maintenance/payment`, `/report/*`, `/more/auto-renew`,
`/more/domain`. Those pages need a session: without the PHP backend they redirect to `/login` and
the sweep reports them as `skipped` (never as a pass). Run it with the dev stack up
(`docs/local-mobile-dev-runbook.md`) to get real readings.

`pin-lock-loop.mjs` drives `pin-lock.html` because the startup lock screen only renders inside the
Android shell (`isNative()`). The harness fakes exactly two things — the native bridge and
`device_login_api.php`; the PIN crypto, localStorage, gate and keypad are the real code.
`--shots=1` also writes the screenshots next to it. Design notes: `docs/mobile-pin-unlock.md`.

Manual testing in a browser (no backend needed — the list/token are mocked):

| URL | What it shows |
|---|---|
| `…/dev-harness/account-picker.html` | the fixed sheet |
| `…/dev-harness/account-picker.html?legacyZ=1` | pre-fix stacking order (the reported bug) |
| `…/dev-harness/account-picker.html?mark=1` | red dashed box over the date row's hidden hit band |
| `…/dev-harness/account-picker.html?n=20000` | account count (default 2000) |
| `…/dev-harness/pin-lock.html` | the PIN-only lock screen (no biometric credential on the device) |
| `…/dev-harness/pin-lock.html?bio=1` | a device that also has a fingerprint: biometric card with both fallbacks |
| `…/dev-harness/pin-lock.html?setup=1` | the "set up PIN" modal on its own |
| `…/dev-harness/pin-lock.html?pin=4821&len=4` | a 4-digit PIN (the default is 6) |

Recipe: open the To Account field, type a few digits (the mock codes run `1001…`), keep the panel
up, then click inside the date row's band (add `&mark=1` to see it). `legacyZ=1` → the OS date
picker opens over the list; fixed → the tap reaches the panel.

- `--n` = accounts in the mock list (a group scope can return thousands).
- `--throttle` = CDP `Emulation.setCPUThrottlingRate`; 10 approximates a mid/low-end phone, 1 is desktop.
- `CHROME_PATH` overrides the Chromium binary (default: the Playwright cache under `%LOCALAPPDATA%`;
  an installed Chrome works too, e.g. `CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"`).

Exit code 0 = all checks pass, 1 = a check failed, 2 = harness error.

## What it checks

| Check | Guards against |
|---|---|
| `open: mounting the picker shows a page of the list, not every account` | opening the picker mounting the whole account list (measured 6.0s freeze at 2000 accounts before the fix) |
| `ime: list filters while composing` / `typing is not rewritten` / `typing survives the next keystroke` | phone IME / word-mode keyboards being fought by the search field |
| `ime: text the keyboard typed survives the next render and still filters the list` | the field being **controlled**: Gboard writes the composing text into the DOM out of React's sight, so the next render (any state change) puts its own, older string back — the typed characters vanish, the list keeps filtering on something else, and only a delete (a fresh event) re-aligns them (reported 2026-10 as "typing finds nothing until I delete a character") |
| `ime: a burst of composition updates stays cheap and still catches up` | a Chinese IME on an old phone (Sogou keeps a composition open): four updates landing in one tick must be coalesced without leaving the list on a stale query — see `docs/mobile-android-ime-input.md` |
| `reopen: the search field starts empty and the list is not still filtered` | the field being uncontrolled: clearing it is the panel's job, not React's |
| `delete: list re-expands to the full match set` | filtering correctness after the windowed rendering |
| `delete: max frame gap …` | the reported "delete freezes for seconds" |
| `pick: tapping an account selects it and closes the picker` | selection |
| `date: a tap over the panel must not reach the row's hidden native date input` | the sheet's `DateTapRow` overlaying an `opacity-0` `<input type="date">` (`.m-tx-date-input`, `z-index: 10`) on its whole row: that row always sits somewhere behind the picker panel, so if the panel loses the paint-order contest (`z-index: 20`) a tap meant for the list focuses the date field and the OS date picker opens over the list (filmed repro 2026-10: search `max` in To Account → tap a result → native calendar over the picker, flickering, account never selected) |
| `perf: delete jank at N accounts stays near the M-account floor` | per-keystroke work scaling with the account count (2.1s at 2000 accounts before the fix) |

`profile-open.mjs` is a one-off CPU-profile helper (`node dev-harness/profile-open.mjs --n=5000`) that
attributes the open cost per function — it is what showed the remaining open time is layout work in the
shared portal positioning, not the account rows.

The `date:` check probes with a real CDP mouse tap, so it may also select a row (which closes the
panel); the loop re-opens the picker before the IME phase. It runs before phase A for that reason.

Delete this folder once these components have a proper test seam (vitest + a DOM environment, or Playwright in CI).
