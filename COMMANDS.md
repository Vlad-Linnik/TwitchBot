# Bot Commands

Signatures shown are the defaults from `config/channelSettings.js`'s `DEFAULT_CHANNEL_SETTINGS` — each channel can override them via its `ChannelConfig` doc (edited on the TwitchBot-Web settings pages).

## Custom commands (mod-managed)

| Command | Access | Description |
|---|---|---|
| `!addcommand !name text` | mod | Create a custom command, or edit its text if it already exists (existing timer, if any, is kept). |
| `!delcommand !name` | mod | Delete a custom command. |
| `!settimer !name <seconds>\|off` | mod | Auto-post that command's text every `<seconds>` seconds (minimum 60); `off` disables auto-posting. Commands sharing an identical interval are spread evenly across it so they don't fire together. A manual `!name` trigger in chat resets that command's auto-post clock. An auto-post only actually fires when the stream is live (skipped in debug mode, see `DEBUG_MODE` in `.env`) and at least `commands.customCommandTimer.minMessagesBetween` ordinary chat messages (default 10, configurable per channel) have happened since the last auto-post — this also guarantees no two auto-posts land back-to-back. |
| `!setpin !name on\|off` | mod | Toggle auto-pin: when on, every send of that command (manual trigger or timer auto-post) pins the sent message via Twitch's chat pin, staying pinned until the stream ends (replacing any message already pinned). Since only mods can pin, a pin-enabled command can only be triggered by mods — non-mods' `!name` is silently ignored. A command can't have `timer` and `pin` on at the same time — `!settimer`/`!setpin` reject the change with an explanation if the other attribute is already active; disable it first. |
| `!setannounce !name on\|off` | mod | Toggle sending that command as a Twitch chat announcement (a colored, highlighted system-style message) instead of a plain message — works for both manual triggers and timer auto-posts. The color is configured on the TwitchBot-Web `/<channel>/commands` page (default: primary). Mutually exclusive with `pin` (an announcement is a self-contained send with no message ID to pin) — `!setpin`/`!setannounce` reject the change if the other is already active. If the bot's token lacks the `moderator:manage:announcements` scope, the send falls back to a plain message instead of failing silently. |
| `!customcommands` | all | List all custom command names for the channel. |
| `!name` | all (mod-only if auto-pin is on for that command) | Trigger a custom command (`#counterName` inside its text is replaced with the counter's live value). |

## Counters

| Command | Access | Description |
|---|---|---|
| `!addcounter #name [mod]` | mod | Create a counter, starting at 0. Add `mod` to restrict updates to mods. |
| `!delcounter #name` | mod | Delete a counter. |
| `!counters` | mod | List all counter names. |
| `#name` / `#name + N` / `#name - N` | all (or mod / exception-listed user if counter is mod-restricted) | Increment/decrement a counter; bare `#name` adds 1. Updates to the same counter are rate-limited to once per `commands.counterUpdate.cooldownMs` (default 10s) — see "Counter update cooldown" below. |
| `!addexception username` | mod | Add a user to the channel's shared exception list — see "Exceptions" below. |
| `!remexception username` | mod | Remove a user from the channel's shared exception list. |

### Exceptions

A mod-restricted counter (`!addcounter #name mod`) normally only accepts updates from mods. `!addexception username` / `!remexception username` let mods grant specific non-mod users the right to update those counters too, without making them a moderator.

- The list is **shared across the whole channel**, not per-counter: adding `someuser` as an exception lets them update *every* mod-restricted counter in that channel, not just one. There's a single list per channel rather than a separate one per counter.
- `username` is matched case-insensitively and doesn't need an `@` prefix (`!addexception Someuser` and `!addexception someuser` are equivalent).
- The list persists in the database and is cached in memory, so it survives bot restarts and takes effect immediately on add/remove (no need to re-add a counter).
- Regular counters (created without `mod`) ignore the exception list entirely — everyone can already update those.

### Counter update cooldown

Twitch chat has real network/render latency, so two people can both try to update the same counter within a few seconds of each other without having seen the other's message land yet — e.g. both typing `#wins +1` almost back-to-back, unintentionally double-counting the same event.

To prevent this, each counter enforces its own cooldown (`commands.counterUpdate.cooldownMs`, default 10000ms/10s, configurable per channel): once a counter is updated, further updates to that *same* counter are rejected with a "please wait" message until the cooldown elapses. This is a per-counter cooldown, not global — updating one counter doesn't block updates to a different counter in the same channel.

## Chat stats

| Command | Access | Description |
|---|---|---|
| `!topchatters [day\|week\|month\|all]` | all | Top chatters leaderboard for the period (default: day). |
| `!topsmiles [period]` | all | Most-used emotes for the period. |
| `!countword <word>` | all | How many times `<word>` was said today. |
| `!countmsg [period]` | all | Your message count and rank for the period. |
| `!countunique [period]` | all | Count of unique chatters for the period. |
| `!botinfo` | mod | Bot uptime and DB stats summary. |
| `!randomclip` | all | Posts a random clip from the channel's top 100 most-viewed clips (Twitch Helix Get Clips). |

## Moderation

| Command | Access | Description |
|---|---|---|
| `!update7tv` | mod | Re-fetch the channel's configured 7TV emote set (`sevenTv.emoteSetUrl` in channel config) and sync it into the whitelist used for `!topsmiles` tracking — adds new emotes, removes ones no longer in the set (their accumulated emote stats are pruned so they leave the web emote cloud; a brand-new emote's previously-counted word-cloud rows are purged too). Previously manually-tracked words (from the removed `!addword` command) are unaffected. The bot also re-syncs automatically: at startup, and while the stream is live — on stream start plus every 4 hours, capped at 3 scheduled syncs per 24h. |

Banned-word/obfuscated-spam messages are auto-timed-out (escalating duration) with no command needed; known spam signatures trigger an immediate ban.

## Mini-games

| Command | Access | Description |
|---|---|---|
| `!muteduel [@user] [seconds]` | all | Challenge chat or a specific user to a dice-roll duel; loser gets timed out (default 300s, min 300s, max 2 weeks). |
| `!muteaccept` | all | Accept a pending mute duel. |
| `!совет` | all | Get a random (expensive) Dota 2 item suggestion. |

## Talking to the bot

Mention `@chatwizardbot` in a message:
- If it contains `?`, the bot answers yes/no/maybe.
- Otherwise it replies with a "busy" filler response.
- It also reacts automatically to `mistercopus_bot`'s duel messages (auto-accepts, reacts to results) — no user command needed.

## Passive chat behavior (no command)

- Repeats "+", "я" (and variants) back if said within the event cooldown.
- Replies "`@user maaaaan`" if someone posts "`@user maaaaan`".
