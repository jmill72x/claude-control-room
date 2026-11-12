# Jarvis OS Shortcuts: setup on the iPhone

About 15 minutes, once. Four Shortcuts: **Jarvis Setup** (pairs the phone), **Ask
Jarvis**, **Send to Jarvis**, and the **Arrive home** automation. The design and the
reasons are in `docs/design/2026-11-12-jarvis-os-shortcuts.md`.

Written from the Shortcuts app as of iOS 18, without a phone to try it on: a label may
differ by a word. If a step doesn't match what you see, say which one.

## Before you start

- The server needs `chat.shortcuts: true` and a restart (NEXT.md §10 has the order).
- Tailscale must be connected on the phone whenever a Shortcut runs.
- You need three addresses. They are the Jarvis OS address with a path on the end:
  - `https://<mini-hostname>.<tailnet>.ts.net/api/shortcut/pair`
  - `https://<mini-hostname>.<tailnet>.ts.net/api/shortcut/send`
  - `https://<mini-hostname>.<tailnet>.ts.net/api/shortcut/event`

  Ask Jarvis to send the three real ones in chat, then long-press each to copy it.

## 1. Jarvis Setup (run once)

Build it:

1. Shortcuts › **+** › name it `Jarvis Setup`.
2. Add **Ask for Input**. Type: Text. Prompt: `Code from Jarvis OS`.
3. Add **Get Contents of URL**. Paste the `/pair` address. Tap the arrow to open it:
   - Method: **POST**
   - Request Body: **JSON**
   - Add new field › Text. Key `code`. Value: the **Ask for Input** variable.
4. Add **Get Dictionary Value**. Get **Value** for `say` in **Contents of URL**.
5. Add **Show Alert**. Message: the **Dictionary Value** variable.
6. Add **Get Dictionary Value**. Get **Value** for `key` in **Contents of URL** (tap
   the input, Select Variable, pick the Contents of URL from step 3).
7. Add **If**. Input: that **Dictionary Value**. Condition: **has any value**.
8. Inside the If, add **Save File**. File: the **Dictionary Value** from step 6.
   - Ask Where to Save: **off**
   - Folder: tap it and pick a folder under **On My iPhone** (make one called
     `Shortcuts`). This keeps the key out of iCloud Drive.
   - Subpath: `jarvis-key.txt`
   - Overwrite If File Exists: **on**

Run it:

1. Open Jarvis OS › Chat › **⋮** › Shortcut keys. Name: `iPhone` (plain letters and
   digits only, 22 at most). Tap **New key**.
2. It shows a 6-letter code, good for 10 minutes.
3. Run **Jarvis Setup** and type the code.
4. It says "Paired with Jarvis OS." The page says the same a few seconds later.

The key is never shown. If it says "Wrong code", make a new code and run it again.

## 2. Ask Jarvis (Siri)

1. Shortcuts › **+** › name it `Ask Jarvis`. The name is what you say to Siri.
2. Add **Ask for Input**. Type: Text. Prompt: `What do you want to ask?`
3. Add **Get File from Folder**. Folder: the one from Setup. Path: `jarvis-key.txt`.
4. Add **Get Contents of URL**. Paste the `/send` address. Open it:
   - Method: **POST**
   - Headers › Add new header. Key `Authorization`. Value: type `Bearer`, a space,
     then insert the **File** variable from step 3.
   - Request Body: **JSON**
   - Add new field › Text. Key `text`. Value: the **Ask for Input** variable.
   - Add new field › Text. Key `via`. Value: `siri`
5. Add **Get Dictionary Value**. Get **Value** for `say` in **Contents of URL**.
6. Add **Show Result**. The **Dictionary Value** variable.
7. Tap the **ⓘ** at the bottom › turn **Allow Running When Locked** off. Otherwise
   anyone holding the locked phone can speak a message as you.

Try it: "Hey Siri, Ask Jarvis". Siri asks, you answer, Siri says "Sent to Jarvis. His
answer comes to Jarvis OS." The answer arrives as a normal Jarvis OS notification.

If it says "not paired": tap the File variable in the header and set its type to
**Text**.

## 3. Send to Jarvis (share sheet)

The quick way: long-press **Ask Jarvis** › **Duplicate**, rename the copy `Send to
Jarvis`, then change four things:

1. Tap the **ⓘ** › turn **Show in Share Sheet** on. A line appears at the top:
   "Receive Any input from Share Sheet". Tap **Any** and leave only **Text** and
   **URLs** ticked.
2. In **Ask for Input**, change the prompt to `Note for Jarvis (optional)`.
3. In **Get Contents of URL**:
   - change `via` to `share`
   - Add new field › Text. Key `shared`. Value: the **Shortcut Input** variable.
4. Replace **Show Result** with **Show Notification** (same variable).

Try it: in Safari tap Share › **Send to Jarvis**, type "worth a read?", Done.

What Jarvis gets: your note is your message. A link goes in the message under the
line "Shared link, outside content:". Any other shared text (a very long link too)
goes as an attached file. Jarvis treats both as someone else's words, never as
instructions from you.

## 4. Arrive home (automation)

1. Shortcuts › **Automation** tab › **+** › **Arrive**.
2. Location: your home. Time Range: Any Time. Pick **Run Immediately**. Next.
3. **New Blank Automation**.
4. Add **Get File from Folder**. Same folder. Path: `jarvis-key.txt`.
5. Add **Get Contents of URL**. Paste the `/event` address. Open it:
   - Method: **POST**
   - Headers › `Authorization` = `Bearer`, a space, the **File** variable.
   - Request Body: **JSON**
   - Add new field › Text. Key `event`. Value: `arrived-home`

Nothing shows on the phone. In Jarvis OS a grey line appears in the chat: "Presence:
arrived home at 18:02 (from the Shortcut key iPhone)". It tells Jarvis you are home.
It is not an instruction, and it sends at most once every 10 minutes.

## If something goes wrong

- **"could not connect"**: Tailscale is off on the phone.
- **"not paired"**: run Jarvis Setup again with a new code.
- **"Too many messages"**: 20 in 10 minutes, 100 a day. Use the app.
- **Lost phone, or you want it off**: Jarvis OS on another device › Chat › ⋮ ›
  Shortcut keys › **Revoke**. Or on the mini: `bin/chat-pair shortcut-revoke iPhone`.
  Revoking the phone itself under Paired devices also revokes the keys it made.
- **Everything off at once** (mini): `touch ~/.local/state/jarvis-os/shortcuts-off`.
  Remove the file to turn them back on.
