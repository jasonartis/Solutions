# 29 — Backup keys: what they are, where they live, what to do

> **For Jason, written 2026-11-09.** Follow it top to bottom; every step is a click or a short action.
> It holds **no secrets**, only where they are kept. Background and reasoning:
> [docs/28](28-vendor-accounts-and-evacuation-plans.md) B.7 and B.8.
>
> **This file is committed, and the repo is PUBLIC: anyone can read it.** Keep it to
> descriptions ("account 1", "paper at home"). **Never write a key, a password, or WHICH
> account (email address or service name) into it.** The key file itself lives on `C:`,
> outside the project folder on `D:`, so git never sees it and it is never committed.

## 1. The two keys, in one minute

| | **B2 read key** | **Backup decryption key** |
|---|---|---|
| Looks like | three values: keyID, keyName, applicationKey | ONE line of text, about 77 characters, starting `AGE-SECRET-KEY-` |
| What it does | lets you **download** the backup files from Backblaze | **opens** the downloaded backup files |
| Think of it as | the key to the storage unit | the combination to the safes inside |
| If you lose it | no harm: make a new one on backblaze.com (section 5) | **every backup is unreadable forever.** It cannot be remade. |
| Where it lives | your cloud doc (account 1) | paper at home + a drive at home + a cloud copy (account 2) |

**The one rule:** never keep the two together. Either one alone is harmless. Both in one place
opens every user's data.

## 2. Where everything lives (fill in the ✔ as you go)

| Copy | Key | Status 2026-11-09 |
|---|---|---|
| Cloud doc, account 1 | B2 read key | ✔ done |
| Cloud, account 2 (not account 1) | decryption key | ✔ done |
| This PC: `C:\Users\yarmishj.AEI-LT-JYARMISH\platform-backup-key\platform-backup-key.txt` | decryption key | ✔ (original) |
| **Paper, at home** | decryption key | ☐ **to do: section 3** |
| **Separate drive, at home** | decryption key | ☐ **to do: section 4** |

## 3. Print the decryption key (10 minutes)

1. Press **Windows key + R**, paste this, press Enter:
   `notepad C:\Users\yarmishj.AEI-LT-JYARMISH\platform-backup-key\platform-backup-key.txt`
2. In Notepad: **Format → Font → Consolas, size 14** (so `0`/`O` and `1`/`l` look different).
3. **File → Print.** Close Notepad **without saving**.
4. Check the printout: one long line starting `AGE-SECRET-KEY-`, nothing cut off at the edge.
   If it runs off the page, print again in landscape or a smaller size.
5. Write on the paper: *"Platform backup decryption key. Made 2026-11-09. Do not throw away."*
   Do **not** write what it's for in more detail, and do not write the B2 keys on it.
6. Keep it at home somewhere safe and dry (with other important papers). Not in the laptop bag.
7. Update the table in section 2.

## 4. Copy it to the separate drive (5 minutes, once you have the drive)

1. Plug in the drive. Make a folder on it called `keys`.
2. Copy (don't move) `platform-backup-key.txt` from the folder in section 3 into `keys`.
3. Open the copy on the drive once, to check it shows the same line. Close without saving.
4. Unplug it and keep it **at home**, apart from the laptop bag.
5. Later, the backup snapshot files (docs/28 B.8) will go on this same drive. That's fine:
   it lives at home and you hold both anyway.
6. Update the table in section 2.

**Optional, once sections 3 and 4 are done:** delete the copy on the PC (docs/12 suggests this),
so a stolen laptop carries no key. A restore then needs the paper or the drive.

## 5. If the B2 read key is lost or leaked (10 minutes, no harm done)

1. Go to **backblaze.com → Sign In**.
2. Left menu: **Application Keys** → **Add a New Application Key**.
3. Name: anything, e.g. `restore-read-2027`. Bucket: **the backup bucket only.**
   Type of access: **Read Only.** → **Create New Key**.
4. **Copy keyID and applicationKey right away: Backblaze shows the applicationKey only once.**
   Paste both, plus the key name, into the cloud doc in account 1, replacing the old ones.
5. In the same Application Keys list, **delete the old read key.**
6. Don't touch the "write-only" key that GitHub uses for the nightly backup.

## 6. If the decryption key is lost (paper, drive and cloud all gone)

There is no way to get it back, and old backups stay locked forever. Then:
1. Tell a Claude session: *"The backup decryption key is lost; make a new key pair (docs/29 §6)."*
   It runs `scripts/backup-keygen.mts`, which makes a new key and updates the lock the backups use.
   (For the session: the script refuses to overwrite `scripts/backup-recipient.txt`, on purpose.
   Remove that file in a commit that says why, then run it.)
2. Do sections 3 and 4 again for the new key, plus a cloud copy in account 2.
3. From that night on, new backups use the new key. Take a fresh `pnpm backup:prod` the same day.

## 7. GitHub two-step: do this when the first customer signs (10 minutes)

GitHub is the one login that opens both the code and the database, and today it is guarded by a
single password.
1. Install an authenticator app on your phone (Google Authenticator or Microsoft Authenticator).
2. **github.com → profile picture (top right) → Settings → Password and authentication.**
3. **Two-factor authentication → Enable.** Choose **Authenticator app**, scan the QR code with
   the phone app, type the 6-digit code it shows.
4. GitHub then shows **recovery codes**: **download and print them.** Keep the paper with the
   decryption key printout. They get you in if you lose the phone.
5. Sign out and back in once to check the phone code works.

## 8. Once a year (5 minutes): check every copy still works

- ☐ The paper is readable.
- ☐ The drive opens and `keys\platform-backup-key.txt` shows the same line as the paper.
- ☐ You can still sign into cloud account 1 (B2 key) and account 2 (decryption key).
- ☐ The two keys are still in different accounts.

A Claude session also runs a real restore test every 3 months (docs/28 B.6). You only type the
decrypt command; the key never goes into the chat.

## 9. Never

- Never paste the decryption key into a chat with Claude (or anyone), a SENT email, a text message
  or the repo. A sent message leaves copies on other people's servers that you can never delete,
  and a Claude chat is kept in its history and in this project's session logs.
- **An email DRAFT you never send** is allowed, but understand what it is: the email service
  stores drafts on its servers, so it is a **cloud copy in that email account**. It counts as the
  "account 2" copy, with the same rules: not in the account holding the B2 keys, not in the
  account holding the snapshot files.
- Never keep the decryption key in the same account as the B2 read key.
- Never keep the decryption key in the same cloud account as the backup snapshot files.
- Never throw away the paper without first checking the drive copy works.
