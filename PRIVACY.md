# Privacy

Discord Privacy Eraser keeps its work inside the Discord browser tab.

## Data it reads

- The current channel or DM ID
- Your signed-in Discord account ID
- Message history and author-filtered search results
- Discord rate-limit information
- The Discord session already held by the web client

## Data it sends

Requests go only to the active Discord origin for:

- Account verification
- Message search and history
- Deleting queued messages

The script has no telemetry, ads, remote dependencies, webhooks, or third-party requests. It does not download attachments.

## Local data

Your userscript manager stores preferences and recovery checkpoints. A checkpoint may include settings, Discord IDs, timestamps, counters, and queued message IDs.

Tokens, cookies, message text, attachments, and activity logs are not stored in checkpoints.

Matched-message and diagnostic logs stay in page memory. Diagnostics are copied only when you click **Copy diagnostics**.

Use **Clear checkpoint** to remove saved run data.
