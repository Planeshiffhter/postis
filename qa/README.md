# Postiz feature verification

These checks exercise the existing application through its local HTTP endpoints and, for scheduling, through its PostgreSQL and Temporal instances. Use a disposable local database. The suite creates test accounts and organizations with randomly generated credentials and addresses under `example.invalid`. Some of those records remain available for inspection after the run. Disable external email, analytics, billing, and social integrations for the test instance.

## Run

Use Node.js 22.23.4, pnpm 10.6.1, and the [native development instructions](../README.md#run-the-workspace-directly). Start the frontend and backend with `pnpm run dev-backend` and the Temporal worker in another session with `pnpm run dev:orchestrator`. Check that the local database schema is initialized with `pnpm prisma-db-push`.

From the repository root:

```sh
node --test --test-concurrency=1 qa/*.test.mjs
```

The API, frontend, and worker default to ports 3000, 4200, and 3002. Set `POSTIZ_QA_API`, `POSTIZ_QA_WEB`, and `POSTIZ_QA_WORKER` to use other loopback HTTP origins. The scheduling test reads the database and Temporal addresses from the root `.env` or existing environment variables. It uses a disabled synthetic channel and cancels its future workflow before removing the post and channel fixtures.

With Chromium and the workspace's Playwright package installed, run `node qa/browser-check.mjs` against the default native ports. Set `POSTIZ_QA_CHROMIUM` if Chromium is installed outside `/usr/bin/chromium`. The browser check submits the login form, then opens authenticated pages and checks logout.

The core suite uses the backend output produced by the native dev command for isolated API fixtures and media adapters. Run `FRONTEND_URL=http://localhost:4200 pnpm run build:extension` and then `node --test qa/extension-check.mjs` to exercise the built extension background bundle with mocked Chrome APIs.

### Loopback provider fixtures

Use a disposable local instance with no production credentials. Stop any existing test worker that polls the same Temporal namespace. Run the following commands in separate shells from the repository root. The application flag for private provider endpoints is scoped to these two processes.

```sh
PORT=3310 NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3310 DISABLE_SSRF_PROTECTION=true pnpm run start:prod:backend
ORCHESTRATOR_PORT=3312 DISABLE_SSRF_PROTECTION=true pnpm run start:prod:orchestrator
```

After both services start:

```sh
POSTIZ_QA_API=http://127.0.0.1:3310 POSTIZ_QA_LOCAL_PROVIDER=1 node --test --test-concurrency=1 qa/provider-publishing.test.mjs qa/rss-polling.test.mjs
```

Stop the two dedicated processes after the run. Both fixtures listen only on loopback and remove their database records. The RSS fixture seeds its source in the test database because the normal feed configuration API requires a public HTTPS URL.

## Coverage

| Area                            | Local verification                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Startup                         | Frontend login markup, anonymous calendar redirect, API root, and Temporal-backed worker health                                                                                |
| Accounts and team               | Registration, bad password rejection, login, logout, profile, timezone, preferences, invitations, membership removal, and organization switching                               |
| Email and recovery              | Activation, resend, password reset, and login with the replacement password through a loopback SMTP server                                                                     |
| Calendar and scheduling         | Calendar queries and next slot, tags, draft creation, schedule, reschedule, and cancellation with Temporal workflow history                                                    |
| Draft review                    | Public preview page and API, anchored guest comments, replies, resolution and reopening, and cross-organization resolution rejection                                           |
| Media                           | PNG upload, search, download and byte comparison, and removal from the library                                                                                                 |
| AI image generation             | Prompt refinement, model request, base64 output, and saving the generated PNG through a loopback OpenAI mock                                                                   |
| Media processors                | Local R2 URL signing, RunPod request and response handling against a mock, and absent-provider feature states                                                                  |
| Billing                         | Initial subscription state and raw-body Stripe signature verification on both webhook routes                                                                                   |
| Settings                        | Short links preference, signatures, and saved sets                                                                                                                             |
| Integrations and analytics      | Provider catalog, channel groups and display names, posting times, empty connected channels, and analytics lookup for an unknown post                                          |
| Notifications and announcements | Unread counts, read tracking, organization isolation, announcement visibility, and rejection of unauthorized publishing                                                        |
| Automation                      | Feed configuration and polling, draft creation, deactivation, and unlinked webhook management                                                                                  |
| Publishing                      | Channel setup, Temporal publication, and release storage against a loopback WordPress fixture                                                                                  |
| API, OAuth, and MCP             | Identity and key rotation, OAuth consent and token revocation, authenticated MCP tool calls, upload widget resources, and posting schemas for every advertised social provider |

The full production image built and ran in a disposable `docker-compose.local.yml` project. Its login page, API, and Temporal-backed worker health passed before teardown. The browser extension bundle passed tests for origin checks, provider discovery, cookies, token storage, and refresh requests against mocked Chrome APIs. Chromium administrator policy blocked unpacked installation. The Node SDK built and made an authenticated request to the local integrations API.

## Findings and coverage gaps

- Autopost creation with `lastUrl` omitted returned HTTP 500. The DTO treats the field as optional, but the database write requires it. The current UI includes an empty `lastUrl` and its payload passed.
- Both Stripe webhook routes returned HTTP 500 for missing or invalid signatures and for a payload changed after signing. The correctly signed fixture returned HTTP 201.
- On the native HTTP configuration, Chromium received a successful login response and stored the session cookie, but initially stayed on the login page. Opening the calendar directly with that session rendered the authenticated page. The cause of the initial navigation behavior remains unverified.
- Live social OAuth, publishing and analytics, outbound webhook delivery, an external SMTP provider, hosted AI and clipping, cloud uploads, billing transactions, and third-party automations still require sandbox accounts, endpoints, or credentials. Email and publication fixtures stay on loopback.
- The repository's Jest config imports undeclared `@nx/jest` and stops before test discovery. The commands above use Node's test runner.
