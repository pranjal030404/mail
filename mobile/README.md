# ARTHVEX Mail – Android (Flutter)

Native-feeling mail client for the ARTHVEX platform. Each signed-in user sees only the mailbox(es)
assigned to them; every mailbox is a separate Stalwart account with its own inbox.

## How the app authenticates
The app signs in with the user's platform email + password (`POST /api/v1/auth/login` with
`X-Client: mobile`), receives an opaque session token, stores it in Android Keystore-backed
secure storage and sends it as `Authorization: Bearer …`. Two-factor codes are supported.
Mail is read/sent through the same webmail API as the website, so permissions, quotas, audit
logging and rate limits are identical. The app refuses non-HTTPS servers.

## Build
```bash
export PATH=$PATH:~/development/flutter/bin
cd mobile
flutter pub get
flutter test && flutter analyze
flutter run --dart-define=API_BASE_URL=https://mail.yourdomain.com       # debug on a device
```

## Release (Play Store / sideload)
1. Create a signing key once and **back it up** (losing it means you cannot update the app):
   ```bash
   keytool -genkey -v -keystore ~/arthvex-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias arthvex
   ```
2. Create `mobile/android/key.properties` (git-ignored):
   ```
   storeFile=/home/you/arthvex-release.jks
   storePassword=...
   keyAlias=arthvex
   keyPassword=...
   ```
3. Build:
   ```bash
   flutter build appbundle --release --dart-define=API_BASE_URL=https://mail.yourdomain.com   # Play Store
   flutter build apk --release --dart-define=API_BASE_URL=https://mail.yourdomain.com         # direct install
   ```
   Outputs: `build/app/outputs/bundle/release/app-release.aab` and `build/app/outputs/flutter-apk/app-release.apk`.

Before publishing, change `applicationId`/`namespace` in `android/app/build.gradle.kts` if you want
your own package name, and replace the launcher icon.

## Creating users and separate inboxes for your domain
1. Deploy the backend (see top-level README), with `MAIL_ADAPTER=stalwart`.
2. Sign up / create a workspace, add your domain, publish the DNS records shown (MX, SPF, DKIM, DMARC) and verify.
3. For each person: **Mailboxes → Create** (e.g. `alice@yourdomain.com`), then invite/assign them as a
   member bound to that mailbox (role `mailbox user`), or use reset-credentials to set a password.
4. Each user installs the app and signs in with their own platform login; they only see their mailbox.
