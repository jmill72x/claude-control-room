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

A key lasts as long as it is used: every message and every arrive-home report starts
its 30 days again. One that sends nothing for 30 days stops working, and you run
Jarvis Setup again with a new code.

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
   "Receive Any input from Share Sheet". Tap **Any** and leave only **Images**,
   **PDFs**, **Files**, **Text** and **URLs** ticked. (Without Images, PDFs and Files
   the Shortcut doesn't show up when you share a photo or a file.)
2. In **Ask for Input**, change the prompt to `Note for Jarvis (optional)`.
3. In **Get Contents of URL**:
   - change `via` to `share`
   - Add new field › Text. Key `shared`. Value: the **Shortcut Input** variable.
4. Replace **Show Result** with **Show Notification** (same variable).

Check **Allow Running When Locked** under the **ⓘ** of the copy too: it must be off
here as on Ask Jarvis.

Try it: in Safari tap Share › **Send to Jarvis**, type "worth a read?", Done.

### Photos and files

A link goes to Jarvis as words, which is what the Shortcut does so far. A photo, a PDF
or a file has to go as a file, and that takes a second **Get Contents of URL** of
another kind. An **If** picks between the two. On the file side a photo is first made a
JPEG on the phone, with its place and time taken out; the mini takes no HEIC photos.

If you built Send to Jarvis before 2026-11-12: do step 1 above again (tick Images,
PDFs and Files), then these.

1. Add **If** and drag it to sit just above **Get Contents of URL**.
   - Input: tap it › Select Variable › **Shortcut Input**. Then tap the **Shortcut
     Input** you just placed and set its type to **Text**.
   - Condition: **begins with**. Text: `http`
2. Drag the **Get Contents of URL** you already have to sit just under the **If**
   line, above **Otherwise**. That one keeps sending links.
3. Under **Otherwise**, add **Set Variable**. Variable Name: `Share`. Input:
   **Shortcut Input**.
4. Under it, add a second **If**. This one is for photos only, so a PDF or a text file
   is never touched.
   - Input: tap it › Select Variable › **Shortcut Input**. Tap the **Shortcut Input**
     you just placed and choose **File Extension**.
   - Condition: **is**. Text: `heic`
   - Tap **Add to Condition**, switch **All** to **Any**, and add four more of the same
     kind: is `heif`, is `jpg`, is `jpeg`, is `png`.
5. Inside that second If, add **Convert Image**. Image: **Shortcut Input**. Format:
   **JPEG**. Tap the arrow and turn **Preserve Metadata** off.
6. Under Convert Image, still inside the second If, add **Set Variable**. Variable
   Name: `Share`. Input: **Converted Image**.
7. Delete the **Otherwise** line that came with the second If (not the first one's),
   so its **End If** sits right under step 6.
8. Under that **End If**, add a new **Get Contents of URL**. Paste the `/send` address.
   Open it:
   - Method: **POST**
   - Headers › `Authorization` = `Bearer`, a space, the **File** variable (the key
     file, as in the first one).
   - Request Body: **Form**
   - Add new field › Text. Key `text`. Value: the **Ask for Input** variable.
   - Add new field › Text. Key `via`. Value: `share`
   - Add new field › **File**. Key `file`. Value: the **Share** variable.
9. In **Get Dictionary Value** (now under the last **End If**), change the input from
   Contents of URL to **If Result**.

Top to bottom the Shortcut now reads: Ask for Input, Get File from Folder, If (begins
with http), Get Contents of URL (JSON), Otherwise, Set Variable Share, If (a photo),
Convert Image, Set Variable Share, End If, Get Contents of URL (Form), End If, Get
Dictionary Value, Show Notification.

Try it: in Photos open a photo › Share › **Send to Jarvis** › Done. It says "Sent to
Jarvis." and the photo is in the chat. Then a PDF from Files, and a Safari page again
to see that links still work.

**Check on first try.** Three things in the steps above were written without a phone:

- **Whether the second If offers File Extension** for Shortcut Input (step 4). If it
  doesn't, say so; until it is sorted, leave the second If out and use Most Compatible
  (below).
- **Whether "is" minds capitals.** Photos names a file `IMG_1234.HEIC`. If the first
  photo comes back with "Jarvis OS does not take HEIC photos", add `HEIC`, `JPG` and
  `PNG` to the list in step 4.
- **Whether Convert Image keeps the photo's name.** Look at the name under the photo
  in the chat; it only matters for finding it later.

**The fallback: Most Compatible.** Without the Convert Image step, or whenever it does
not run, a HEIC photo is refused with "Jarvis OS does not take HEIC photos". In the
share sheet tap **Options** at the top, choose **Most Compatible**, and share again:
the phone then hands over a JPEG. That way keeps the photo's place and time in the
file.

What goes: photos (as JPEGs, see above; PNG and WebP are taken too), PDFs, and text or
Markdown files. Up to 4 files in one share, 10 MB each, 25 MB together, 200 MB a day.
No videos. Selected text still arrives as an attached text file.

What Jarvis gets: your note is your message. A link goes in the message under the
line "Shared link, outside content:". Any other shared text (a very long link too)
and every photo or file goes as an attachment. Jarvis treats all of it as someone
else's content, never as instructions from you.

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
- **"not paired … its key expired after 30 days without use"**: a key stops working
  when it has sent nothing for 30 days. Make a new code (Jarvis OS › Chat › ⋮ ›
  Shortcut keys › **New key**) and run Jarvis Setup again; it saves the new key over
  the old one, so the other Shortcuts need no change. The Shortcut keys list shows
  when each key expires if unused. Arrive home fails without a word on the phone, so
  an expired key that is tried is also reported in #pepper, once a day.
- **"Too many messages"**: 20 in 10 minutes, 100 a day. Use the app.
- **"Too big for Jarvis OS"**: a file is over 10 MB, or the share is over 25 MB
  together. Share fewer at once, or send it from the Jarvis OS app.
- **"It can't take that one"**: the file is not a photo, a PDF or a text file (a
  video, a Word file). **"not what its name or type says"**: the file's contents and
  its name disagree, so it was refused.
- **"could not read that share"**: the second Get Contents of URL is not as written.
  Check that Request Body is **Form**, and that the `file` field is of type **File**
  with the key spelled `file`.
- **A photo arrives as a text file, or a link arrives as a file or is refused**: the
  **If** is sending it down the wrong side. Tell Jarvis which one did what. Until it
  is fixed, a second Shortcut works without the first If: duplicate Send to Jarvis as
  `Send file to Jarvis`, tick only Images, PDFs and Files, delete the first If, its
  Otherwise and the JSON Get Contents of URL, and keep everything from Set Variable
  down to the Form one.
- **"Jarvis OS does not take HEIC photos"**: the photo reached the mini as HEIC, so
  Convert Image did not run on it. See "Check on first try" under Photos and files.
  To send it right now: in the share sheet tap **Options** at the top, choose **Most
  Compatible**, and share again.
- **"still taking an earlier share"**: two shares from this phone are still on their
  way. Wait a few seconds.
- **"took too long to reach Jarvis OS"**: the share has two minutes to upload. Try
  again on Wi-Fi, or with fewer photos at once.
- **Lost phone, or you want it off**: Jarvis OS on another device › Chat › ⋮ ›
  Shortcut keys › **Revoke**. Or on the mini: `bin/chat-pair shortcut-revoke iPhone`.
  Revoking the phone itself under Paired devices also revokes the keys it made. An
  expired key can be revoked the same way; do that for a phone you no longer have.
- **Everything off at once** (mini): `touch ~/.local/state/jarvis-os/shortcuts-off`.
  Remove the file to turn them back on.
