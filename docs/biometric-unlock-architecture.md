# Biometric Unlock — Architecture Audit & Redesign

Audit date: 2026-10-06 · Scope: `c168_mobile` (Android shell + React SPA) · Status: **audit only, no code changed**

---

## 0. Premise corrections (read this first)

The task brief assumes a native Android application. **This project is not one.** Several sections
of the brief describe components that do not exist here. Designing to them would build on sand,
so the corrections come first.

| Brief assumes | Actually present | Consequence |
|---|---|---|
| `LoginActivity`, `SettingsActivity`, `SplashActivity`, `MainActivity`, fragments | One custom Activity (`MainActivity extends BridgeActivity`). **No biometric code in it at all.** | §4 "don't duplicate across Activities" is satisfied trivially: there is nothing to duplicate. The real duplication risk is across React modules. |
| `SharedPreferences` | **WebView `localStorage`** + Android Keystore (via plugin) for the credential | §15 maps onto localStorage, not SharedPreferences. Process death = WebView recreated + localStorage reloaded. |
| `ViewModel` / static state | React component state (`useState`) | "Do not store only in memory" maps onto: don't keep it in component state only. |
| Native Android UI for biometrics | **Remote web UI** loaded from `https://www.count168.com/c168_mobile/frontend/dist/` | Any UI change ships by deploying the web app — **no APK rebuild needed**. Good: faster iteration. Risk: the APK caches the WebView (see BUG-6). |
| Android-only problem statement | iOS is a **Safari Add-to-Home-Screen PWA** | The platform split must be explicit and the two paths must not share gates. |

### 0.1 The Android app is a thin shell

`c168_mobile/app/android/app/src/main/java/com/count168/mobile/MainActivity.java` contains only
system-bar insets and back-button handling. Biometric work happens **entirely** through two
Capacitor plugins (`@aparajita/capacitor-biometric-auth`, `@aparajita/capacitor-secure-storage`).
There is no `FingerprintManager`, no `BiometricPrompt` subclass, no Keystore code of our own.

### 0.2 Config landmine (must be fixed regardless of everything else)

| File | `server.url` |
|---|---|
| `c168_mobile/app/capacitor.config.json` (source) | `https://count168.site/...` ✗ |
| `c168_mobile/app/android/app/src/main/assets/capacitor.config.json` (**what is actually packaged**) | `https://www.count168.com/...` ✓ |

The shipped APK loads **com** ✓, but the source of truth says **site**. A future `npx cap sync`
would repoint the APK at the site deployment — a repo the client has explicitly forbidden us to
touch. Treat as a latent outage.

---

## A. Current architecture (as built)

### A.1 Files

| File | Role |
|---|---|
| `lib/biometricStore.js` | Native adapter: `isNative`, `loadToken/saveToken/clearToken`, `authenticate()`, `readModalityPref()`, `isAvailable()`, `describeBiometry()`, `biometryInfo()` |
| `lib/biometricLogin.js` | Native login: biometric → local credential → session swap |
| `lib/deviceTokenApi.js` | Backend calls for device tokens |
| `lib/webauthn.js` | Passkey (iOS path): register/login/verify, local flags |
| `hooks/useBiometricUnlock.js` | Android startup gate state machine (`checking/locked/unlocked/disabled`) |
| `components/lock/BiometricLockGate.jsx` | The lock screen UI |
| `App.jsx` | Mounts the gate |
| `pages/login/LoginPage.jsx` | Passkey path (iOS) + post-login enrolment modal (Android) |
| `pages/more/SettingsPage.jsx` | The on/off row + method row |
| `translateFile/authTranslate.js`, `moreTranslate.js` | Strings |
| `includes/device_token.php`, `includes/webauthn.php` + 9 API endpoints | Server side |

### A.2 Platform split

```
isNative()  ==  window.androidBridge !== undefined
            || (Array.isArray(window.Capacitor?.PluginHeaders) && length > 0)
```

Verified in the shipped bundle: `PluginHeaders` is only ever *read* by `@capacitor/core`
(`.find(p => p.name === f)`); only a real native shell writes it. iOS Safari cannot produce it.
So this is trustworthy — unlike every *biometric capability* probe (see BUG-3).

### A.3 Runtime paths

```
Android APK ──► isNative() ──► gate (useBiometricUnlock) ──► device_token in Keystore
                                                            └─► BiometricAuth.authenticate()

iOS PWA    ──► !isNative() ──► LoginPage passkey effect ──► webauthn login endpoints
```

### A.4 Persistence (current)

| Key | Store | Meaning |
|---|---|---|
| `count168_biometric_device_token` | Keystore | the credential (Android) |
| `count168_biometric_device_id` | Keystore | device id |
| `ec_biometric_device_id` | localStorage | device id (fallback/lookup) |
| `ec_biometric_modality` | localStorage | `"fingerprint"` \| `"face"` |
| `ec_bio_prompt_optout` | localStorage | user declined the enrolment prompt |
| `ec_passkey_on_device`, `ec_passkey_id` | localStorage | local passkey flags (iOS) |

### A.5 Lifecycle

| Moment | What happens today |
|---|---|
| App start | gate checks `isNative()` → `loadToken()` → lock or password |
| App resume | **nothing biometric-related** ✗ |
| Settings change | writes modality, revokes/creates token |
| Logout | revokes token, clears company id |

---

## B. Root causes of the two reported bugs (with evidence)

### BUG-1 (§13) "Pick FACE → kill app → reopen → still fingerprint"

**Three independent causes. Only two are ours.**

**(a) The lock screen hard-codes fingerprint — this is ours and it is the visible symptom.**

```
components/lock/BiometricLockGate.jsx:144   <i className={... "fas fa-fingerprint"} />   ← main lock icon
components/lock/BiometricLockGate.jsx:122   <i className="fas fa-fingerprint" />          ← retry button
components/lock/BiometricLockGate.jsx:29    bioFailed: "指纹未识别，请重试"
components/lock/BiometricLockGate.jsx:35    byCode.authenticationFailed: "指纹未识别，请重试。"
```

After a restart the **first** thing shown is the lock screen. It draws a fingerprint glyph and,
on failure, says "指纹未识别" — **regardless of the selected method**. The user reads that as
"it is still doing fingerprint". The persisted state is irrelevant to what they see.

**(b) The system prompt's modality is chosen by Android, not by us — this is a platform limit.**

Evidence chain:

1. `@aparajita/capacitor-biometric-auth/dist/esm/base.js` → `authenticate(options)` calls
   `internalAuthenticate(options)` — the whole object is forwarded, nothing is stripped.
2. `BiometricAuthNative.java` → `call.getInt("androidBiometryStrength", WEAK)` — the value arrives.
3. `AuthActivity.java:65` → `builder.setAllowedAuthenticators(authenticators)` where the only
   values used anywhere in the plugin are `BIOMETRIC_STRONG`, `BIOMETRIC_WEAK`, `DEVICE_CREDENTIAL`.

There is **no fingerprint-vs-face dimension in the Android API**. With `weak` (which face requires)
the system presents the strongest enrolled authenticator — normally fingerprint. Therefore:

> **"Force face" is not implementable on Android.** Not by us, not by any app, including banking apps.

**(c) A silent fallback exists — ours, and a spec violation (§7).**

```js
// lib/biometricStore.js
export function readModalityPref() {
  return window.localStorage.getItem(MODALITY_KEY) === "face" ? "face" : "fingerprint";
}                                            //  ↑ anything unexpected silently becomes fingerprint
```

If the stored value is empty, corrupt, or written by an older build, the app silently reports
FINGERPRINT. The spec forbids exactly this.

### BUG-2 (§14) "Password login still shows fingerprint enabled"

Audited: **no "fingerprint enabled" indicator exists on the login page.**
`authTranslate.js` has `bioLogin: "Sign in with Face ID / fingerprint"` and `bioBody: "...with your
fingerprint or face..."` — both neutral. The enrolment modal title is `bioTitle: "Biometric Unlock"`.

The fingerprint claims the user sees come from the **lock screen** (BUG-1a). In the observed flow
the lock screen renders before the login page, so "the login system says fingerprint" and BUG-1a
are the same defect.

### BUG-3 Capability probes are unreliable — never gate on them (this has already cost two outages)

`BiometricAuth.checkBiometry()` does not answer on at least one reporter's handset. Two historical
outages traced to gating on it:

| Where it was used as a gate | Result on device |
|---|---|
| Settings row support (`describeBiometry()`) | row greyed out on both platforms |
| Enrolment prompt (`isAvailable()`) | prompt suppressed |

Additionally `platformAuthenticatorAvailable()` gives a **false negative on iOS** (documented in a
warning above its own definition) and a false negative on Android WebView.

**Rule adopted:** capability is *advisory display only*. The only accepted evidence that biometrics
work is a real `authenticate()` call and its error code.

### BUG-4 Two sources of truth for "enabled"

`enabled` is currently **inferred** (`Boolean(await loadToken())`) while the method is **stored**
(`ec_biometric_modality`). The spec's §2 invariant — never `enabled: true, method: NONE` — cannot
be enforced while enablement is inferred. Two stores can disagree after a partial failure.

### BUG-5 Nothing re-validates capability on resume (§6)

`grep visibilitychange` finds hooks in `useMobileDashboard`, `useMobileTransaction`,
`useRealtimeDomain` — **none biometric**. Enrollment changes made in Android Settings are therefore
never noticed until the next cold start.

### BUG-6 Stale WebView / config landmine

`webContentsDebuggingEnabled: false` (no console on Android) and, per §0.2, the source config
points at a different deployment than the packaged one.

---

## C. New architecture

### C.1 Single source of truth — one persisted object

```
localStorage["ec_biometric"] = {
  v: 1,
  enabled: boolean,
  method: "NONE" | "FINGERPRINT" | "FACE"
}
```

- Written atomically as **one** `JSON.stringify` — there is no intermediate state where enabled and
  method disagree.
- Normalised on read (`normalizeSettings()`), which enforces the invariant
  `enabled === true ⇒ method !== "NONE"`.
- **Capability is never written here.** Capability is runtime-only and recomputed.

### C.2 Capability — separate, runtime, never persisted

```js
{
  fingerprintAvailable, faceAvailable,     // advisory: from checkBiometry(), may be unknown
  canAuthenticate,                          // from checkBiometry(); unknown is a value, not false
  strength: "NONE" | "WEAK" | "STRONG",
  apiLevel,
  state: "AVAILABLE" | "UNAVAILABLE" | "NOT_ENROLLED" | "TEMPORARILY_LOCKED" | "SECURITY_REQUIREMENT_FAILED"
}
```

`unknown` is a first-class value. Conflating unknown with false is what caused BUG-3.

### C.3 The resolver — the only component allowed to decide

```js
resolveBiometric(settings, capability) -> {
  strategy: "NONE" | "NATIVE_FINGERPRINT" | "NATIVE_FACE" | "NATIVE_ANY" | "PASSKEY",
  startable: boolean,
  reason: "" | "FACE_UNAVAILABLE" | "FINGERPRINT_UNAVAILABLE" | "NOT_ENROLLED" | "LOCKED" | "UNKNOWN",
  promptStrength: "strong" | "weak",
  expectedModality: "FINGERPRINT" | "FACE" | "ANY",   // what we ASK for
  guaranteedModality: "FINGERPRINT" | "ANY"           // what the OS will actually honour
}
```

`expectedModality` vs `guaranteedModality` is the honesty mechanism demanded by §9: the UI may say
"face" only in the `ANY`/guaranteed sense, never as a promise.

Callers (the four real ones in this codebase, replacing the brief's Activity list):
lock gate · login page · settings page · enrolment modal. **None of them may branch on modality
themselves.**

### C.4 Diagram

```
persisted ──┐
            ├──► resolveBiometric() ──► strategy ──► (gate | login | settings | modal)
runtime ────┘                              │
capability                                 └──► reason ──► user-facing message
```

---

## D. State machine

**Persistent (user preference)** — `DISABLED | ENABLED_FINGERPRINT | ENABLED_FACE`
**Runtime (device)** — `AVAILABLE | UNAVAILABLE | NOT_ENROLLED | TEMPORARILY_LOCKED | SECURITY_REQUIREMENT_FAILED | UNKNOWN`

Legal transitions (persistent):

| From | Event | To |
|---|---|---|
| DISABLED | user enables, capability has exactly one modality | ENABLED_<that> |
| DISABLED | user enables, both modalities, no pick yet | ENABLED_FINGERPRINT **(explicit user action required — never automatic)** |
| ENABLED_* | user switches method | ENABLED_<other>, only after capability validation (§11) |
| ENABLED_* | user disables | DISABLED (+ opt-out recorded) |
| ENABLED_FACE | face becomes unavailable | **stays ENABLED_FACE** + runtime UNAVAILABLE (§7 — never rewritten) |
| ENABLED_FINGERPRINT | fingerprint becomes unavailable | **stays ENABLED_FINGERPRINT** + runtime UNAVAILABLE |

The last two rows are the whole point: the preference is owned by the user, the device state is
owned by the OS, and the app never converts one into the other.

---

## E. Data model & migration

| Key | Action |
|---|---|
| `ec_biometric` (new) | authoritative `{v, enabled, method}` |
| `ec_biometric_modality` (old) | migrate then delete |
| `ec_bio_prompt_optout` | keep (unrelated to the model) |
| `count168_biometric_device_token` | keep (the credential; presence no longer *defines* enabled) |

Migration, run once, with validation:

```
if (ec_biometric exists and v === 1) → use it
else if (ec_biometric_modality exists):
     method = value === "face" ? FACE : value === "fingerprint" ? FINGERPRINT : NONE
     if (method === NONE) → DISABLED            // do NOT guess
     enabled = tokenPresent()                   // validated against the Keystore, not assumed
     write ec_biometric; delete ec_biometric_modality
else → DISABLED
```

Explicitly **not** done: treating a legacy `fingerprintEnabled`-style boolean as authoritative
(there is no such key here — a fact worth recording, since the brief assumes one exists).

---

## F. Lifecycle flow

| Moment | Action |
|---|---|
| Cold start | read settings → `normalizeSettings()` → capability probe (**timeout-tolerant, never blocking**) → `resolveBiometric()` → if `startable`, gate locks and prompts; else password |
| Resume (`visibilitychange → visible`) | re-probe capability only. **Never rewrite `method`.** If the selected modality became unavailable → runtime state flips to UNAVAILABLE and the UI says so with a "Change method" action |
| Login success (password) | enrol prompt unless `ec_bio_prompt_optout` |
| Enrol / method switch | validate capability → persist → re-resolve → **verify the next authenticate call actually reflects it** |

---

## G. Android BiometricPrompt strategy — what is and is not guaranteeable

| User method | `promptStrength` | What the OS does | Guaranteed? |
|---|---|---|---|
| FINGERPRINT | `strong` | fingerprint only (face on Android is almost always Class 2 / weak, so it is excluded) | **Yes** |
| FACE | `weak` | presents the strongest enrolled authenticator — **usually fingerprint** | **No** |
| (auto) | `weak` | whatever the device has | n/a |

Consequences, applied per §9 (explicit and safe, never a false claim):

1. The Settings option is labelled **"Face or fingerprint"**, not "Face" — it authorises face, it
   does not promise it.
2. The system prompt's `reason` text is modality-neutral ("Verify your identity to sign in").
3. When `method = FACE` **and** the device reports face as the only enrolled modality, face really
   is used. That case is genuinely served.
4. When both are enrolled, `resolveBiometric()` returns `expectedModality: FACE` but
   `guaranteedModality: ANY`; the UI must not claim face.
5. Keystore: no modality-specific key constraints are possible either. Keys stay
   `BIOMETRIC_*`-class based. If a key requires STRONG and only weak face is enrolled,
   `SECURITY_REQUIREMENT_FAILED` is surfaced as a distinct state rather than a generic failure.

---

## H. Migration strategy

1. Ship the new model behind a one-time migration (§E) that **deletes** the legacy key only after
   the new value is read back successfully.
2. Keep the old reader as a fallback for one release so a partially-migrated device cannot end up
   with neither key.
3. Record the build marker (`BIO_BUILD`) in the diagnostic line so the running bundle is always
   identifiable — this was decisive earlier and should stay until the model is stable.
4. Fix §0.2 (config) in the same release: the APK must not be repointable at a forbidden
   deployment by an unrelated `cap sync`.

---

## I. Test matrix

Legend: **E** = verifiable from code/CI · **D** = requires a real device · **X** = not achievable
on Android (must be handled explicitly per §9, not "fixed")

| # | Case | How | Expectation |
|---|---|---|---|
| 1 | Fingerprint only → enable → login → restart → login | D | works; `method=FINGERPRINT` |
| 2 | Face only → enable → login → restart → login | D | works; `method=FACE`; face actually shown |
| 3 | Both → pick Fingerprint → kill → reopen | D | stays FINGERPRINT |
| 4 | Both → pick Face → kill → reopen | D | **stays FACE** (preference); prompt may be fingerprint → **X (guarantee)**, UI must not claim otherwise |
| 5 | Pick Face → Android Settings → remove face → return | D | **no silent switch**; state UNAVAILABLE + "Face unavailable" + "Change method" |
| 6 | Pick Fingerprint → remove fingerprint → return | D | same, mirrored |
| 7 | Biometric OFF → restart | E+D | password only; no prompt (opt-out honoured) |
| 8 | Face selected → password login → UI wording | E (grep) + D | **zero occurrences of a fingerprint claim when method=FACE** |
| 9 | Switch Face → Fingerprint → kill → reopen | D | FINGERPRINT |
| 10 | Switch Fingerprint → Face → kill → reopen | D | FACE |
| 11 | Both, method=FACE → activity recreation | D | stays FACE |
| 12 | Enrollment changes while backgrounded → resume | D | capability revalidated, preference untouched |

**Automatable now (no device):** the resolver is a pure function — cases 3,4,5,6,9,10,11,12 can all
be asserted against `resolveBiometric()` inputs/outputs, plus a migration test, plus a
"no fingerprint claim when method=FACE" string test (case 8). This is the part I can prove in CI;
the rest needs your handsets.

---

## Deliverable summary — what will change, and what cannot

**Will be fixed in code**
1. Lock screen stops hard-coding fingerprint (icon + wording) — **this is the reported symptom**
2. One persisted settings object with an enforced invariant (§2)
3. Capability split from preference; `unknown` no longer collapses to `false`/`fingerprint` (§3)
4. `resolveBiometric()` becomes the only decision point (§4)
5. No silent modality fallback; unavailable → explicit message + "Change method" (§7)
6. Capability re-validated on resume (§6)
7. Diagnostic reports `enabled/method/capability/resolvedStrategy` (§18) — settles §13 on-device
8. Config landmine (§0.2)

**Cannot be fixed — will be handled explicitly instead**
- Forcing face when the phone also has fingerprint (Android API has no such selector). Handled by
  honest labelling, neutral prompt text, and `guaranteedModality` in the resolver — **never by
  claiming the app is using face when it is not.**

**Not applicable to this codebase**
- Activity/ViewModel/fragment/SplashActivity state coordination, SharedPreferences migration,
  `setAllowedAuthenticators(FACE)`.
