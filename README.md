# @openmaxai/email-mcp

A stdio [MCP](https://modelcontextprotocol.io) server that lets an AI agent send email over **SMTP** and read email over **IMAP** or **POP3**, using any provider that supports app passwords / authorization codes (QQ Mail, 163, Tencent Exmail, Aliyun enterprise mail, Outlook, Gmail, self-hosted servers...).

- One connection per tool call, closed right after (no long-lived IDLE sessions).
- Every network operation has a timeout.
- All configuration comes from environment variables. `EMAIL_PASSWORD` is the only secret.
- Logs go to stderr only (stdout carries the MCP protocol). Passwords and message bodies are never logged.

Requires Node.js 20.11 or newer.

## Install (Claude Code)

```bash
claude mcp add-json email '{
  "command": "npx",
  "args": ["-y", "@openmaxai/email-mcp@0.1.0"],
  "env": {
    "EMAIL_USER": "me@example.com",
    "EMAIL_PASSWORD": "<app password / authorization code>",
    "RECEIVE_PROTOCOL": "imap",
    "IMAP_HOST": "imap.example.com", "IMAP_PORT": "993", "IMAP_SECURE": "ssl",
    "SMTP_HOST": "smtp.example.com", "SMTP_PORT": "465", "SMTP_SECURE": "ssl"
  }
}'
```

To receive over POP3 instead, set `"RECEIVE_PROTOCOL": "pop3"` and replace the `IMAP_*` keys with `"POP3_HOST": "pop.example.com", "POP3_PORT": "995", "POP3_SECURE": "ssl"`.

Any other MCP client works the same way: run `npx -y @openmaxai/email-mcp` with the environment below.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `EMAIL_USER` | yes | | Login name, usually the full email address. Also used as the From address. |
| `EMAIL_PASSWORD` | yes | | App password / authorization code. The only secret. |
| `EMAIL_FROM_NAME` | no | | Display name for the From header. |
| `RECEIVE_PROTOCOL` | no | `imap` | `imap` or `pop3`. |
| `IMAP_HOST` | if imap | | |
| `IMAP_PORT` | no | 993 (ssl) / 143 | |
| `IMAP_SECURE` | no | from port, else `ssl` | `ssl` (implicit TLS), `starttls`, or `none`. |
| `POP3_HOST` | if pop3 | | |
| `POP3_PORT` | no | 995 (ssl) / 110 | |
| `POP3_SECURE` | no | from port, else `ssl` | `ssl` or `none` (STARTTLS is not supported for POP3). |
| `SMTP_HOST` | yes | | |
| `SMTP_PORT` | no | 465 (ssl) / 587 (starttls) / 25 (none) | |
| `SMTP_SECURE` | no | from port, else `ssl` | `ssl`, `starttls`, or `none`. |
| `EMAIL_TLS_VERIFY` | no | `true` | Verify server TLS certificates. Set to `false` only for servers with self-signed certificates. |
| `EMAIL_SAVE_SENT` | no | `true` | IMAP only: after sending, save a copy (marked read, Bcc kept) to the Sent folder. |
| `EMAIL_ATTACHMENT_ROOTS` | no | working directory + OS temp dir | Directories that attachments may be read from, separated by `:` (`;` on Windows). |
| `EMAIL_MAX_ATTACHMENT_MB` | no | `25` | Size limit for each attachment and for the total per message. `get_email` also skips saving attachments above it. |
| `EMAIL_ALIASES` | no | | Other addresses of this mailbox, comma-separated. Excluded from reply-all recipients. |
| `EMAIL_TIMEOUT_MS` | no | `30000` | Timeout for each tool call's network work (1000 to 600000). |
| `EMAIL_LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, or `error` (stderr). |

**Security from the port.** If `*_SECURE` is not set but `*_PORT` is, the security mode follows the port: SMTP 465 is `ssl`, 587 and 25 are `starttls`; IMAP 993 is `ssl`, 143 is `starttls`; POP3 995 is `ssl`. Other ports default to `ssl`. POP3 on port 110 is plaintext, so it needs an explicit `POP3_SECURE=none`. An explicit `*_SECURE` always wins.

`starttls` requires the upgrade: the connection fails if the server does not offer STARTTLS. `none` sends credentials in plaintext and logs a warning; use it only for local test servers.

The configuration is checked at startup. If something is missing or invalid, the server exits with code 2 and lists every problem it found. The password is never printed.

## Provider presets

Before you start, most providers require you to **enable IMAP/SMTP (or POP3/SMTP) in the web mail settings** and to **use an authorization code / app password** instead of your normal login password.

| Provider | IMAP | POP3 | SMTP | Notes |
|---|---|---|---|---|
| QQ Mail (`qq.com`) | `imap.qq.com:993` ssl | `pop.qq.com:995` ssl | `smtp.qq.com:465` ssl | Settings → Account → enable IMAP/SMTP, then generate an authorization code (授权码). |
| NetEase 163 (`163.com`) | `imap.163.com:993` ssl | `pop.163.com:995` ssl | `smtp.163.com:465` ssl | Settings → POP3/SMTP/IMAP → enable, then use the authorization code (授权码). |
| Tencent Exmail (`exmail.qq.com`) | `imap.exmail.qq.com:993` ssl | `pop.exmail.qq.com:995` ssl | `smtp.exmail.qq.com:465` ssl | Enable IMAP/SMTP in client settings. If "secure login" is on, create a client-specific password (客户端专用密码). |
| Aliyun enterprise mail | `imap.qiye.aliyun.com:993` ssl | `pop.qiye.aliyun.com:995` ssl | `smtp.qiye.aliyun.com:465` ssl | The admin may need to allow IMAP/POP/SMTP. Use a third-party client password if one is required. |
| Outlook / Microsoft 365 | `outlook.office365.com:993` ssl | `outlook.office365.com:995` ssl | `smtp.office365.com:587` starttls | Needs an app password (account with 2-step verification). Many Microsoft 365 tenants turn off basic auth for IMAP/POP/SMTP, and this server does not support OAuth. |
| Gmail | `imap.gmail.com:993` ssl | `pop.gmail.com:995` ssl | `smtp.gmail.com:465` ssl | Turn on 2-Step Verification, then create an App Password. Enable IMAP/POP in Gmail settings. |

Provider settings can change. Check the provider's help pages if a connection fails.

## Tools

| Tool | Available | Description |
|---|---|---|
| `send_email` | always | `to[]`, `cc[]`, `bcc[]`, `subject`, `text`, `html`, `attachments[]` (local file paths under the allowed directories). Under IMAP the result includes `saved_to_sent`, or `warnings` if the Sent copy failed. The send itself still succeeds in that case. |
| `reply_email` | always | Reply to a message by `uid` or `message_id` (and `folder`). Sets `In-Reply-To` / `References` and adds `Re:` to the subject. The reply goes to Reply-To if present, otherwise From. `reply_all` also adds the original To/Cc, removing duplicates and your own addresses (`EMAIL_USER` and `EMAIL_ALIASES`). |
| `list_emails` | always | `folder` (default `INBOX`), `limit` (1–100, default 20), `unread_only`. Returns summaries, newest first: `uid`, `message_id`, `from`, `to`, `subject`, `date`, `flags`, `seen`, `snippet`. |
| `get_email` | always | `uid`, `folder`, `format` (`full` or `headers`), `include_attachments`. Attachments are saved to a private temp directory (mode 0600) and their paths are returned. Bodies longer than 100k characters are truncated and flagged. |
| `search_emails` | always | `from`, `to`, `subject`, `text`, `since`, `before` (YYYY-MM-DD; `since` inclusive, `before` exclusive), `folder`, `limit`. |
| `list_folders` | IMAP only | Folders with message and unseen counts. |
| `mark_read` | IMAP only | `uid`, `folder`, `read` (true sets `\Seen`, false clears it). |

Reading a message never marks it as read. Use `mark_read` to do that.

**Sent folder.** The Sent folder is found through IMAP SPECIAL-USE `\Sent`. If the server doesn't advertise one, the first folder named `Sent`, `Sent Messages`, `Sent Items`, `已发送` or `已发送邮件` is used. If none of these exists, no folder is created and the result carries a warning.

### POP3 limitations

- Only `INBOX` exists. Any other folder returns `INVALID_INPUT`.
- `uid` is the POP3 **UIDL** value (a string).
- POP3 has no read/unread flags: `seen` is `null`, `flags` is empty, and `unread_only` returns the newest messages with a `note` saying the filter is not supported.
- POP3 has no server-side search. `search_emails` downloads and filters the newest 200 messages locally. Older messages are not searched.
- `list_folders` and `mark_read` are not registered.

## Errors

Failed tool calls return `isError: true` with a JSON body `{"error": {"code", "message"}}`. The codes are stable:

| Code | Meaning |
|---|---|
| `AUTH_FAILED` | Wrong user/password, IMAP/SMTP not enabled, or an authorization code is required. The message includes a hint for the provider, detected from the host name. |
| `UNREACHABLE` | DNS failure, connection refused or reset, or a TLS/certificate problem. The message suggests port/security fixes. |
| `SEND_REJECTED` | The SMTP server rejected the recipients or the message. |
| `NOT_FOUND` | No such message (uid / Message-ID) or folder. |
| `INVALID_INPUT` | Bad arguments, for example a missing body, an unreadable attachment or a bad date. |
| `TIMEOUT` | The server did not respond within `EMAIL_TIMEOUT_MS`. |
| `UNKNOWN` | Anything else. Set `EMAIL_LOG_LEVEL=debug` for details on stderr. |

## Security notes

- The only secret is `EMAIL_PASSWORD`. It is removed from every error message and log line.
- TLS certificates are verified by default.
- Attachments can only be read from the allowed directories: the working directory and the OS temp dir, or `EMAIL_ATTACHMENT_ROOTS`. Paths are resolved with `realpath`, so `../` traversal and symlinks that point outside those directories are rejected.
- Message bodies, subjects and addresses are never written to logs.

## Development

```bash
npm install
npm run build
npm test                  # unit tests
npm run test:integration  # needs Docker: starts greenmail/standalone automatically
```

Integration tests start a throwaway [GreenMail](https://greenmail-mail-test.github.io/greenmail/) container. To use an existing GreenMail instance instead, set `GREENMAIL_HOST` (and optionally `GREENMAIL_SMTP_PORT`, `GREENMAIL_IMAP_PORT`, ...).

## License

MIT
