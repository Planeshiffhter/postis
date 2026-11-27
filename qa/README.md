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

## Coverage

| Area                            | Local verification                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Startup                         | Frontend login markup, anonymous calendar redirect, API root, and Temporal-backed worker health                                                  |
| Accounts and team               | Registration, bad password rejection, login, logout, profile, timezone, preferences, invitations, membership removal, and organization switching |
| Calendar and scheduling         | Calendar queries and next slot, tags, draft creation, schedule, reschedule, and cancellation with Temporal workflow history                      |
| Draft review                    | Public preview page and API, anchored guest comments, replies, resolution and reopening, and cross-organization resolution rejection             |
| Media                           | PNG upload, search, download and byte comparison, and removal from the library                                                                   |
| Settings                        | Short links preference, signatures, and saved sets                                                                                               |
| Integrations and analytics      | Provider catalog, channel groups and display names, posting times, empty connected channels, and analytics lookup for an unknown post            |
| Notifications and announcements | Unread counts, read tracking, organization isolation, announcement visibility, and rejection of unauthorized publishing                          |
| Automation                      | Inactive feed and unlinked webhook management                                                                                                    |
| API and OAuth                   | Organization identity, key rotation, OAuth app management, consent, authorization-code exchange, approved-app revocation, and MCP discovery      |

The full production image built and ran in a disposable `docker-compose.local.yml` project. Its login page, API, and Temporal-backed worker health passed before teardown. The Chrome extension built and its archive passed ZIP integrity validation. The Node SDK built and made an authenticated request to the local integrations API. Extension behavior in social sites remains unverified.

## Findings and coverage gaps

- Autopost creation with `lastUrl` omitted returned HTTP 500. The DTO treats the field as optional, but the database write requires it. The current UI includes an empty `lastUrl` and its payload passed.
- On the native HTTP configuration, Chromium received a successful login response and stored the session cookie, but initially stayed on the login page. Opening the calendar directly with that session rendered the authenticated page. The cause of the initial navigation behavior remains unverified.
- Live OAuth and posting for each social provider, provider analytics, outbound webhooks, active RSS polling, email delivery, account recovery by email, AI generation and clipping, cloud media storage, billing, and third-party automations require sandbox accounts, endpoints, or credentials. The local tests use no live provider credentials and send no posts, emails, or webhooks.
- The repository's Jest config imports undeclared `@nx/jest` and stops before test discovery. The commands above use Node's test runner.
