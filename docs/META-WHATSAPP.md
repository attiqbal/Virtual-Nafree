# Facebook, Instagram and WhatsApp for the promotion agent

Owner only. Code: `src/modules/meta` (Graph API), `src/modules/whatsapp` (Cloud API and the owner bot), `PromoterService.publishToMeta`. Tests: `test/meta-whatsapp.test.ts`.

## What it does

**Publishing (Facebook Page and Instagram professional account).** On `/owner-promoter.html`, an approved social post shows "Publish for me" with a target, an image link and an optional schedule. Facebook: text, link or photo post, now or scheduled 10 minutes to 30 days ahead. Instagram: one image plus caption, published now (the Instagram API cannot schedule this way). After publishing, "Refresh numbers" reads likes, comments and shares.

**WhatsApp (to and from the owner).**
- When a draft is written, the agent messages the owner's WhatsApp.
- Reply `LIST`, `SHOW code`, `APPROVE code`, `REJECT code reason`, `POST code FB` (or `POST code IG image-link`), `SEND code` (approved emails). `code` is five characters shown in each message.
- Only `WHATSAPP_OWNER_NUMBER` is obeyed. Every other sender is ignored with no reply. Webhook calls without a valid `X-Hub-Signature-256` are refused (401). Redelivered messages are handled once.
- 24-hour rule: free text is only allowed within 24 hours of the owner's last message. Outside it, the agent sends the approved template `maiz_owner_alert` (one variable, the summary). Replying to it, even with "hello", opens the window and the agent then answers in full.

## Safety rules (enforced in code)

- Nothing posts, sends or spends without the owner's approval. `APPROVE` and `POST` are separate steps, so approving never publishes by itself.
- Organic posts only. **No ads are created and no ad money is spent by this code.** The Marketing API is not built. The existing per-campaign budget rule still applies to money you record yourself. Before ads are added they will need their own daily cap and approval.
- A post is marked "publishing" before Meta is called, so double presses publish once. A clear refusal from Meta puts it back to "approved" to retry. An unclear failure (timeout, Meta fault) marks it "failed" and says to check the page first, so it is never posted twice by accident.
- Tokens are read only from server environment variables, sent in an Authorization header (never in a URL), and masked in errors. With `META_APP_SECRET` set, every Graph call also carries `appsecret_proof`.
- Settings are all-or-nothing: the server refuses to start on a half-set group.

## Connecting (no server login)

Open **Connections** in the owner menu (`/owner-connections.html`). The Facebook Page, Instagram and WhatsApp cards each have the steps below in plain words with links to the right Meta screens, boxes to paste the ids and tokens into, **Test connection** (a harmless read: the Page's name, the Instagram username, the WhatsApp number), **Disconnect**, and for WhatsApp the webhook URL and verify token to copy plus **Send test WhatsApp message**. Saving takes effect at once, without a restart.

Details typed there are stored encrypted (AES-256-GCM with `TOKEN_KEY`, in `platform_records` as `connection_secret`), never returned to the browser after saving, never logged. Code: `src/modules/connections`, tests `test/connections.test.ts`.

The same page also takes the platform's own keys, so none of them needs a server login: **Email sending (Resend)**, and under **For your clients**, **Sign in with Google**, **Sign in with Microsoft**, **Slack**, **Xero** and **Square**, each with its steps, the redirect addresses to copy and a test (tests: `test/connections-platform.test.ts`). The sign-in app tests send the provider a made-up code (Microsoft: a request for a token with no permissions), so nothing is created; Google's and Microsoft's answers to wrong keys were checked live on 2026-11-14, Slack's, Xero's and Square's follow their documentation. Stripe, RunPod and Claude stay server settings on purpose.

The environment variables below still work and **win** when a whole group is set (the page then shows "Set on the server" and cannot change it). Use them only if you prefer server settings.

## What you must do at Meta (the page walks you through it)

1. **Meta developer app** (developers.facebook.com, type Business). Development mode is fine: your own Page, Instagram account and WhatsApp number work without app review while you hold a role on the app.
2. **Facebook Page and Instagram.** Instagram must be a Professional (Business or Creator) account linked to the Page. Add the Page and Instagram account to a Meta Business portfolio.
3. **Access token.** In Business settings, Users, System users: create a system user, assign the Page, the Instagram account and the WhatsApp account, and generate a token with `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`, `business_management`, `whatsapp_business_messaging`, `whatsapp_business_management`. Put it in `META_ACCESS_TOKEN` and `WHATSAPP_ACCESS_TOKEN` (same token is fine). Never paste it into chat or git. Note the Page id and Instagram account id.
4. **WhatsApp.** Add the WhatsApp product to the app and register a business phone number that is **not** currently on any WhatsApp or WhatsApp Business app (a number must be removed from the app first, or use a new SIM or a landline/VoIP that can receive a code). Note the **Phone number ID** (not the phone number).
5. **Webhook.** In the app's WhatsApp, Configuration: callback URL `https://maizagents.com/api/whatsapp/webhook`, verify token = the value you set in `WHATSAPP_VERIFY_TOKEN` (16+ random characters), subscribe to the `messages` field. Deploy the env vars first, because Meta checks the URL when you save.
6. **Template.** In WhatsApp Manager, Message templates, create `maiz_owner_alert`, category Utility, language English (UK), body: `MAIZ Agents: {{1}}` with a sample such as `2 waiting for your approval. Reply HELLO to read them.` Wait for approval (usually minutes to a day). Different name or language: set `WHATSAPP_ALERT_TEMPLATE` / `WHATSAPP_TEMPLATE_LANGUAGE`.
7. **Your own number.** Set `WHATSAPP_OWNER_NUMBER`. Send any message from it to the business number once so the first conversation is open. In Development mode Meta may require your number on the app's allowed recipient list.
8. **Paste the details into the Connections page** and press Save, then Test. Or, instead, set these env vars on the server and restart:

| Variable | Value |
|---|---|
| `META_ACCESS_TOKEN` | system user token |
| `META_FACEBOOK_PAGE_ID` | numeric Page id (omit if no Facebook) |
| `META_INSTAGRAM_ACCOUNT_ID` | numeric Instagram account id (omit if none) |
| `META_APP_SECRET` | app secret (required for WhatsApp, also used for `appsecret_proof`) |
| `META_GRAPH_VERSION` | optional, default `v23.0` |
| `WHATSAPP_ACCESS_TOKEN` | token (can equal `META_ACCESS_TOKEN`) |
| `WHATSAPP_PHONE_NUMBER_ID` | numeric id from Meta |
| `WHATSAPP_VERIFY_TOKEN` | your chosen string, 16+ characters |
| `WHATSAPP_OWNER_NUMBER` | e.g. `+447700900123` |
| `WHATSAPP_ALERT_TEMPLATE`, `WHATSAPP_TEMPLATE_LANGUAGE` | optional, defaults `maiz_owner_alert`, `en_GB` |

Instagram images must be public https JPEG links Meta can fetch (the agent does not generate or host pictures yet).

## Limits to know

- Whoever controls the owner's SIM can command the agent by WhatsApp. Approvals by WhatsApp are as strong as that number: keep SIM and phone locked.
- Production use beyond your own accounts needs Meta app review and business verification.
- Tokens from a system user do not expire but can be revoked; if publishing starts failing with "Meta said no", regenerate the token.
- Meta's API versions and rules change; if a call is refused the message is shown as Meta wrote it.
