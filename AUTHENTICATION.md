# Seller dashboard authentication

The seller dashboard uses one administrator account. The server reads these
environment variables and does not provide a default password:

- `ADMIN_USERNAME`: the administrator's sign-in name.
- `ADMIN_PASSWORD`: a unique password of at least 12 characters.
- `SESSION_SECRET`: a random secret of at least 32 characters used to sign
  eight-hour, HttpOnly session cookies.

If any setting is missing or too short, login is unavailable rather than
falling back to an unprotected dashboard.

## Local development

The project root has a private `.env` file for local credentials. The `start`
script loads it automatically; keep it out of source control.

To create your own credentials, copy `.env.example` to `.env` and replace both
placeholder values. Generate a session secret in PowerShell with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Put the printed value in `SESSION_SECRET` in `.env`, then run `npm start`.
Open `http://localhost:3000/dashboard.html`; unauthenticated requests are
redirected to the sign-in page. Sign in using the username and password from
`.env`, then use **Sign out** in the dashboard when finished. Sessions expire
after eight hours.

Node.js 22.9 or newer is required for loading the optional `.env` file. You can
also set the same three variables in your shell instead.

## Netlify

Set all three variables in the site's environment-variable settings, then
redeploy. Netlify serves the `frontend` directory and routes dashboard access
through the authenticated function. Session cookies are marked `Secure` on
Netlify and in production.

The storefront can read published templates and categories without signing in.
Seller data and all API writes require a valid administrator session.

## Customer accounts

The storefront Cart and Favorites actions open customer sign-in. Customers can
register or sign in with an email and password, or continue with Google. Customer
accounts and password hashes are kept out of the public data API and seller
dashboard data response.

Set `CUSTOMER_SESSION_SECRET` to a separate random value of at least 32
characters. If it is not set, the customer session cookie uses `SESSION_SECRET`.
To enable Google sign-in, create a **Web application** OAuth client ID in Google
Cloud Console, add each storefront origin to its authorized JavaScript origins,
and set `GOOGLE_CLIENT_ID` to that client ID in `.env` and your Netlify
environment settings. The application verifies Google's ID token on the server;
no Google client secret is needed for this sign-in flow. Restart the local server
or redeploy Netlify after configuring the values.
