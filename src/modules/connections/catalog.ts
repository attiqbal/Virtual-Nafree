/**
 * What the owner can connect, and the plain-English steps for each. Pure data: the service turns it into the
 * Connections page. Screens at Meta change often, so each step says what to look for, not just where to click.
 */
export type ConnKey = "facebook" | "instagram" | "whatsapp" | "resend" | "google" | "microsoft" | "slack" | "xero" | "square" | "stripe" | "runpod" | "anthropic";

export interface FieldDef {
  key: string;
  label: string;
  help: string;
  /** A secret is stored encrypted and never sent back to the browser. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
  /** The page offers to make a random value for this field. */
  generate?: boolean;
}
export interface GuideStep { text: string; link?: { href: string; label: string } }
export interface ConnDef {
  key: ConnKey;
  title: string;
  summary: string;
  /** social/messaging: asked for by the owner's own team. clients: what clients sign in with or connect. platform: runs the site. */
  group: "social" | "messaging" | "clients" | "platform";
  /** True when the owner can enter the details in the browser. False: set on the server, shown here as status + test. */
  editable: boolean;
  fields: FieldDef[];
  guide: GuideStep[];
  usedBy: string[];
  /** What clients see once this works, in their words. */
  clientsSee?: string;
  /** Addresses to paste into the provider's screens, as paths on this site (shown with the site's address in front). */
  copies?: { label: string; path: string }[];
}

const META_APPS = { href: "https://developers.facebook.com/apps/", label: "Meta for Developers: your apps" };
const BUSINESS_SETTINGS = { href: "https://business.facebook.com/settings/", label: "Meta Business settings" };
const SYSTEM_USERS = { href: "https://business.facebook.com/settings/system-users", label: "Business settings: System users" };

export const CATALOG: readonly ConnDef[] = [
  {
    key: "facebook", title: "Facebook Page", group: "social", editable: true,
    summary: "Lets the promotion agent publish approved posts to your Facebook Page and read their likes and comments.",
    usedBy: ["promotion-agent"],
    fields: [
      { key: "accessToken", label: "Access token", secret: true, required: true, placeholder: "Starts with EAA…", help: "The long code from step 4. Also used for Instagram (and WhatsApp unless you give WhatsApp its own)." },
      { key: "pageId", label: "Facebook Page ID", secret: false, required: true, placeholder: "e.g. 105839201234567", help: "A number, not the Page's name." },
      { key: "appSecret", label: "App secret (recommended)", secret: true, required: false, placeholder: "32 letters and numbers", help: "Adds a second lock to every call. WhatsApp needs it. From your app's Settings, Basic." },
    ],
    guide: [
      { text: "Open Meta for Developers and click Create app. Choose \"Other\", then the type \"Business\". Give it any name, for example \"MAIZ Agents\". The app can stay in Development mode: it works on your own Page without any review while you are its admin.", link: META_APPS },
      { text: "In Meta Business settings, make sure your Facebook Page is listed under Accounts, then Pages. If not, add it. If you have no business portfolio yet, Meta offers to create one: do that.", link: BUSINESS_SETTINGS },
      { text: "In Business settings, go to Users, then System users, and click Add. Name it \"MAIZ agent\" and give it the role Admin. Then click Add assets, choose Pages, pick your Page and switch on Full control. If the app is not yet attached to the business, Meta asks you to add it under Accounts, then Apps.", link: SYSTEM_USERS },
      { text: "With that system user selected, click Generate new token. Choose your app, set the expiry to Never, and tick: pages_show_list, pages_manage_posts, pages_read_engagement, business_management. (For Instagram also tick instagram_basic and instagram_content_publish; for WhatsApp also whatsapp_business_messaging and whatsapp_business_management.) Copy the token and paste it into the box below. Meta shows it only once." },
      { text: "Your Page ID: open your Page on Facebook, choose About, then scroll to Page transparency and copy the number called Page ID. It is also shown in Business settings when you click the Page under Accounts, then Pages." },
      { text: "Optional but recommended: in your app, open App settings, then Basic, click Show next to App secret, and paste it into the third box." },
      { text: "Click Save, then Test connection. A green message with your Page's name means it works." },
    ],
  },
  {
    key: "instagram", title: "Instagram", group: "social", editable: true,
    summary: "Lets the promotion agent publish approved picture posts to your Instagram professional account.",
    usedBy: ["promotion-agent"],
    fields: [{ key: "instagramId", label: "Instagram account ID", secret: false, required: true, placeholder: "e.g. 17841400000000000", help: "A long number, not the @username." }],
    guide: [
      { text: "Instagram must be a Professional account (Business or Creator). In the Instagram app: Settings, then Account type and tools, then Switch to professional account." },
      { text: "Link it to your Facebook Page: on Facebook open your Page, Settings, then Linked accounts, then Instagram, and connect it." },
      { text: "In Meta Business settings, open Accounts, then Instagram accounts, add yours if it is not there, and assign it to the same system user as the Page (Full control).", link: BUSINESS_SETTINGS },
      { text: "Click the Instagram account in that list. The Instagram account ID is the number shown at the top. Paste it below." },
      { text: "Instagram uses the access token from the Facebook Page card above, so connect that first, with the Instagram permissions ticked when you generate the token (step 4 there)." },
      { text: "Click Save, then Test connection. Pictures must be public https links; Instagram cannot post text alone." },
    ],
  },
  {
    key: "whatsapp", title: "WhatsApp (your line to the agent)", group: "messaging", editable: true,
    summary: "The agent messages your own WhatsApp when something waits for approval, and you can reply APPROVE, REJECT or POST. Only your number is obeyed.",
    usedBy: ["promotion-agent", "decisions"],
    fields: [
      { key: "phoneNumberId", label: "Phone number ID", secret: false, required: true, placeholder: "e.g. 109876543210987", help: "The business number's ID from Meta, not the phone number itself." },
      { key: "ownerNumber", label: "Your own WhatsApp number", secret: false, required: true, placeholder: "+447700900123", help: "With country code. Only messages from this number are obeyed." },
      { key: "verifyToken", label: "Webhook verify token", secret: false, required: true, generate: true, help: "Any private phrase of 16+ letters and numbers. Press Make one for me, save, then paste the same value into Meta (step 7)." },
      { key: "accessToken", label: "Access token (optional)", secret: true, required: false, help: "Leave empty to use the Facebook Page token. Fill only if you made a separate token for WhatsApp." },
      { key: "appSecret", label: "App secret (optional)", secret: true, required: false, help: "Leave empty to use the one from the Facebook card. It signs the messages Meta sends us, so it is required one way or the other." },
      { key: "alertTemplate", label: "Alert template name", secret: false, required: false, placeholder: "maiz_owner_alert", help: "Only change this if you named the template differently in step 6." },
      { key: "templateLanguage", label: "Template language", secret: false, required: false, placeholder: "en_GB", help: "Must match the language you chose for the template." },
    ],
    guide: [
      { text: "Do the Facebook Page card first. It gives you the app, the system user and the access token that WhatsApp also uses (tick the two whatsapp_ permissions when you generate the token).", link: META_APPS },
      { text: "In your Meta app, click Add product and add WhatsApp. Choose your business portfolio when asked." },
      { text: "Register the business phone number. It must NOT be active on the normal WhatsApp or WhatsApp Business app (remove it from there first, or use a new SIM or a number that can receive a text or call). In your app open WhatsApp, then API Setup, and add the number. Meta sends it a code." },
      { text: "On the same API Setup screen, copy the Phone number ID (a long number, not the phone number) and paste it below." },
      { text: "Type your own WhatsApp number below with the country code, press Make one for me next to the verify token, add the access token if WhatsApp has its own, then click Save." },
      { text: "Create the message template. In WhatsApp Manager open Message templates, Create template: category Utility, name maiz_owner_alert, language English (UK), body \"MAIZ Agents: {{1}}\" with the sample \"2 waiting for your approval. Reply HELLO to read them.\" Submit it. Approval usually takes minutes to a day. The agent can only start a conversation with this template.", link: { href: "https://business.facebook.com/wa/manage/message-templates/", label: "WhatsApp Manager: message templates" } },
      { text: "Tell Meta where to send your replies. In your app open WhatsApp, then Configuration, click Edit next to Webhook, paste the Callback URL and Verify token from the box below, click Verify and save, then next to Webhook fields click Manage and switch on Subscribe for \"messages\". Save the details here first: Meta checks them straight away." },
      { text: "From your own phone, send any message (for example \"hello\") to the business number. This opens the conversation. If your app is in Development mode, also add your number under API Setup, To, Manage phone number list." },
      { text: "Click Test connection (checks the number with Meta), then Send test WhatsApp message. If the second one fails because the template is not approved yet, wait for approval and try again." },
    ],
  },
  {
    key: "resend", title: "Email sending (Resend)", group: "platform", editable: true,
    summary: "Sends sign-in links, receipts, your decisions digest and the promotion agent's approved emails.",
    usedBy: ["decisions", "promotion-agent"],
    clientsSee: "Their sign-in links and receipts arrive in seconds, from your own address.",
    fields: [
      { key: "apiKey", label: "Resend API key", secret: true, required: true, placeholder: "Starts with re_", help: "A Sending access key is safest. Resend shows it only once." },
      { key: "from", label: "Send emails from", secret: false, required: true, placeholder: "MAIZ Agents <hello@maizagents.com>", help: "A name and an address on your verified domain." },
    ],
    guide: [
      { text: "Create a Resend account (free to start), then add your domain, for example maizagents.com.", link: { href: "https://resend.com/domains", label: "Resend: domains" } },
      { text: "Resend shows a few DNS records. Add each one where your domain's DNS lives (for maizagents.com that is Cloudflare: DNS, then Records, then Add record). Turn the orange cloud off for them. Press Verify in Resend; it can take a few minutes." },
      { text: "In Resend open API keys, click Create API key, choose Sending access and your domain, and copy the key.", link: { href: "https://resend.com/api-keys", label: "Resend: API keys" } },
      { text: "Paste the key below, type the From address (a name, then the address in angle brackets), and click Save. Emails switch over straight away." },
      { text: "Click Test connection. It checks the key and, when the key is allowed to, that your domain is verified. It sends nothing." },
    ],
  },
  {
    key: "google", title: "Sign in with Google", group: "clients", editable: true,
    summary: "Adds a Continue with Google button to sign-up and log-in, so clients do not need another password.",
    usedBy: [],
    clientsSee: "A Continue with Google button on sign-up and log-in.",
    copies: [{ label: "Authorised redirect URI", path: "/api/signin/oauth/google/callback" }],
    fields: [
      { key: "clientId", label: "Client ID", secret: false, required: true, placeholder: "…apps.googleusercontent.com", help: "Ends in .apps.googleusercontent.com." },
      { key: "clientSecret", label: "Client secret", secret: true, required: true, placeholder: "Starts with GOCSPX-", help: "Shown next to the client ID in Google Cloud." },
    ],
    guide: [
      { text: "Open Google Cloud and create a project (any name, for example MAIZ Agents).", link: { href: "https://console.cloud.google.com/projectcreate", label: "Google Cloud: new project" } },
      { text: "Open Google Auth Platform (it used to be called the OAuth consent screen). Click Get started, give the app name MAIZ Agents and your support email, choose External, and finish. Under Branding add your home page, privacy page and terms page addresses.", link: { href: "https://console.cloud.google.com/auth/overview", label: "Google Auth Platform" } },
      { text: "Under Audience, click Publish app, so anyone can sign in (not just test users). Sign-in with only the basic profile and email needs no review by Google." },
      { text: "Under Clients, click Create client. Type: Web application. Under Authorised redirect URIs click Add URI and paste the address from the box below. Click Create.", link: { href: "https://console.cloud.google.com/auth/clients", label: "Google Auth Platform: clients" } },
      { text: "Copy the Client ID and Client secret into the boxes below and click Save. The Google button appears on sign-up and log-in straight away." },
      { text: "Click Test connection. It asks Google whether it knows your app, using a made-up code, so nothing is created. Then try it yourself on the log-in page." },
    ],
  },
  {
    key: "microsoft", title: "Sign in with Microsoft", group: "clients", editable: true,
    summary: "Adds a Continue with Microsoft button, for clients who use Outlook or Microsoft 365 at work.",
    usedBy: [],
    clientsSee: "A Continue with Microsoft button on sign-up and log-in.",
    copies: [{ label: "Redirect URI (Web)", path: "/api/signin/oauth/microsoft/callback" }],
    fields: [
      { key: "clientId", label: "Application (client) ID", secret: false, required: true, placeholder: "e.g. 1a2b3c4d-…", help: "The long id with dashes on the app's Overview page." },
      { key: "clientSecret", label: "Client secret value", secret: true, required: true, help: "The Value column, not the Secret ID. Shown only once." },
      { key: "tenant", label: "Who can sign in", secret: false, required: false, placeholder: "common", help: "Leave empty for any work or personal Microsoft account." },
    ],
    guide: [
      { text: "Open Microsoft Entra, App registrations, and click New registration. Name it MAIZ Agents. Under Supported account types choose \"Accounts in any organizational directory and personal Microsoft accounts\".", link: { href: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade", label: "Microsoft Entra: app registrations" } },
      { text: "Under Redirect URI choose Web and paste the address from the box below. Click Register." },
      { text: "On the Overview page, copy the Application (client) ID into the first box below." },
      { text: "Open Certificates and secrets, click New client secret, pick the longest expiry, and copy the Value (not the Secret ID) into the second box. Put a reminder in your calendar a week before it expires." },
      { text: "Open Token configuration, click Add optional claim, choose ID, tick xms_edov and click Add (tick the box Microsoft offers to add the Graph permission too). Without this, people signing in with a work account are turned away, because MAIZ cannot trust their email address otherwise." },
      { text: "Click Save. The Microsoft button appears straight away. Click Test connection: it asks Microsoft for a token with no permissions, which shows whether it knows your app, and creates nothing." },
    ],
  },
  {
    key: "slack", title: "Slack (clients' teams)", group: "clients", editable: true,
    summary: "Lets each client chat with their AI employees in Slack. This is the platform's one Slack app, shared by every client.",
    usedBy: [],
    clientsSee: "An Add to Slack button in their workspace settings, then their AI team answers in Slack.",
    copies: [
      { label: "Redirect URL (OAuth and permissions)", path: "/api/slack/callback" },
      { label: "Request URL (Event subscriptions)", path: "/api/slack/events" },
    ],
    fields: [
      { key: "clientId", label: "Client ID", secret: false, required: true, placeholder: "e.g. 1234567890.1234567890", help: "Two numbers with a dot between them." },
      { key: "clientSecret", label: "Client secret", secret: true, required: true, help: "From Basic information, App credentials." },
      { key: "signingSecret", label: "Signing secret", secret: true, required: true, help: "Also from App credentials. It proves messages really come from Slack." },
    ],
    guide: [
      { text: "Open Slack's app page, click Create New App, choose From scratch, name it MAIZ Agents and pick any workspace of yours to build it in.", link: { href: "https://api.slack.com/apps", label: "Slack: your apps" } },
      { text: "Open OAuth and Permissions. Under Redirect URLs paste the first address from the box below and save. Under Bot token scopes add: app_mentions:read, chat:write, im:history, im:read, im:write." },
      { text: "Open Basic information, App credentials. Copy the Client ID, Client secret and Signing secret into the boxes below and click Save. Save before the next step, because Slack checks the address straight away." },
      { text: "Open Event subscriptions, switch it on, and paste the second address from the box below as the Request URL. Wait for Verified. Under Subscribe to bot events add app_mention and message.im, then Save changes." },
      { text: "Open Manage distribution and click Activate public distribution, so clients' workspaces can add it." },
      { text: "Click Test connection. It asks Slack whether it knows your app, using a made-up code, so nothing is installed anywhere." },
    ],
  },
  {
    key: "xero", title: "Xero (clients' accounts)", group: "clients", editable: true,
    summary: "Lets clients connect their Xero books with one click, so their finance employee can read their accounts.",
    usedBy: [],
    clientsSee: "A Connect Xero button that opens Xero's own sign-in, instead of uploading files.",
    copies: [{ label: "Redirect URI", path: "/api/integrations/callback" }],
    fields: [
      { key: "clientId", label: "Client id", secret: false, required: true, placeholder: "32 letters and numbers", help: "From your app's Configuration page." },
      { key: "clientSecret", label: "Client secret", secret: true, required: true, help: "Press Generate a secret there. Shown only once." },
    ],
    guide: [
      { text: "Open Xero Developer, My Apps, and click New app. Name it MAIZ Agents, choose Web app, and give your home page address.", link: { href: "https://developer.xero.com/app/manage", label: "Xero Developer: my apps" } },
      { text: "As the Redirect URI paste the address from the box below. Tick the terms and click Create app." },
      { text: "Open Configuration, copy the Client id, then press Generate a secret and copy it. Paste both below and click Save." },
      { text: "Click Test connection. It asks Xero whether it knows your app, using a made-up code, so nothing is connected. A new Xero app can connect up to 25 organisations; apply for more in Xero Developer when you grow." },
    ],
  },
  {
    key: "square", title: "Square (clients' tills)", group: "clients", editable: true,
    summary: "Lets clients connect their Square account with one click, so daily sales arrive without file uploads.",
    usedBy: [],
    clientsSee: "A Connect Square button that opens Square's own sign-in.",
    copies: [{ label: "Redirect URL", path: "/api/integrations/callback" }],
    fields: [
      { key: "clientId", label: "Application ID", secret: false, required: true, placeholder: "Starts with sq0idp-", help: "From the app's Credentials page (Production)." },
      { key: "clientSecret", label: "Application secret", secret: true, required: true, placeholder: "Starts with sq0csp-", help: "From the app's OAuth page. Press Show." },
    ],
    guide: [
      { text: "Open the Square Developer dashboard and click the + to create an application named MAIZ Agents.", link: { href: "https://developer.squareup.com/apps", label: "Square Developer: applications" } },
      { text: "At the top switch to Production. Open OAuth, paste the address from the box below as the Redirect URL, and save." },
      { text: "Copy the Application ID (Credentials page) and the Application secret (OAuth page, press Show) into the boxes below and click Save." },
      { text: "Click Test connection. It asks Square whether it knows your app, using a made-up code, so nothing is connected." },
    ],
  },
  {
    key: "stripe", title: "Payments (Stripe)", group: "platform", editable: false,
    summary: "Takes card payments and subscriptions from clients.",
    usedBy: [],
    fields: [],
    guide: [
      { text: "Payments stay a server setting on purpose: a mistake here takes real money, and the server checks live and test keys before it starts. PAYMENTS_PROVIDER, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set once. Test connection checks that the server's key is accepted by Stripe.", link: { href: "https://dashboard.stripe.com/apikeys", label: "Stripe: API keys" } },
      { text: "The webhook endpoint in Stripe should point to your site's /api/payments/webhook.", link: { href: "https://dashboard.stripe.com/webhooks", label: "Stripe: webhooks" } },
    ],
  },
  {
    key: "runpod", title: "AI engine (RunPod)", group: "platform", editable: false,
    summary: "Does the heavy AI work for every agent, cheaply.",
    usedBy: ["promotion-agent", "community-growth-manager"],
    fields: [],
    guide: [
      { text: "Create a restricted API key and a serverless endpoint.", link: { href: "https://www.runpod.io/console/serverless", label: "RunPod: serverless" } },
      { text: "RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID are set once on the server, because every agent's work depends on them. Test connection asks the endpoint for its health, which costs nothing." },
    ],
  },
  {
    key: "anthropic", title: "Claude (quality checking)", group: "platform", editable: false,
    summary: "Claude checks the AI engine's work and handles the light jobs.",
    usedBy: ["promotion-agent", "community-growth-manager"],
    fields: [],
    guide: [
      { text: "Create an API key and set a monthly spend limit.", link: { href: "https://console.anthropic.com/settings/keys", label: "Anthropic Console: API keys" } },
      { text: "ANTHROPIC_API_KEY is set once on the server. Test connection lists one model, which is free." },
    ],
  },
] as const;

export const CONN_KEYS = CATALOG.map((c) => c.key) as ConnKey[];
export const defOf = (key: string): ConnDef | undefined => CATALOG.find((c) => c.key === key);
