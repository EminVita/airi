# Autonomous livestream with sentence preparation

Status: Accepted for this fork.

## Context

The operator supplies a main topic and fixed story details. The character continues without waiting for a user message.
Audience comments arrive in event batches. Interesting comments can change the topic or interrupt a story at a sentence boundary.
The operator prioritizes continuous audio. An unfinished audience response cannot block an available story sentence.

## Decision

The existing desktop chat composer exposes a collapsed livestream control. The mounted Stage owns generation, synthesis, playback, and cancellation.
Ordinary chat remains separate. A normal response or character change pauses or stops the loop. Speech mute pauses voice mode only.

The feature reuses the selected character's chat and speech providers. It adds no dependency and no separate scoring service.
The model selects comments and prepares the next sentence in one request. It has no tools and cannot browse.
ChatGPT GPT-5 and GPT-6 requests use low reasoning for this loop. Ordinary chat settings remain unchanged.
This follows the [OpenAI reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning) and reduces planning overhead.
MiniMax sentence synthesis produces audio before playback. Providers that only support bidirectional speech are not supported by this loop.

## Scheduling and narrative state

`libs/livestream/session.ts` owns scheduling policy. `composables/use-livestream-host.ts` owns external calls and delivery.

Text rehearsal uses the same policy with timed text delivery. It never opens a speech output or calls synthesis.
Its 30-minute clock includes model waits and excludes pauses. A host timer enforces the limit during stalled requests.
Displayed text commits on pause or stop because the complete sentence is already visible.
The next request receives elapsed and remaining time for pacing and closing.

The operator imports or pastes an episode brief before a text rehearsal. The limit is 12000 characters.
Every planner request includes the full writing skill, host rules, workflow rules, and brief.
These Markdown imports are build assets. They are not discovered through Codex's `AGENTS.md` or loaded from arbitrary filesystem paths.
See [the operator guide](../../livestream/README.md) for file ownership, reload behavior, and the writing skill's runtime scope.

- One sentence plays while at most one sentence waits with prepared audio.
- One preparation request runs at a time. It contains at most 20 candidate comments and eight completed sentences.
- A new audience response can replace waiting audio. Existing audio stays available until the replacement finishes synthesis.
- If replacement synthesis is slow, playback takes the available story sentence first.
- Only completed audio commits the narrative checkpoint or marks comments answered.
- A short reply preserves the interrupted story position. An audience topic keeps a separate mainline bookmark.
- After two consecutive audience answers, the next preparation reserves space to complete the current story beat.
- A new operator direction invalidates pending preparation and waiting audio. The current sentence finishes normally.
- Pause stops audio immediately. Resume uses the last completed checkpoint, so an interrupted sentence can repeat.
- Stop, pause, and redirect invalidate asynchronous preparation. Late results cannot enter playback or another broadcast's metrics.

Story details remain fixed during a broadcast. A new direction changes the main topic, but does not erase the supplied details.
The model decides whether a sentence completes a story beat. Narrative quality and content checks remain model-dependent.

## Comment contract

`services/livestream.ts` defines Eventa commands, snapshots, and `livestreamBatch`.
Renderer clients share the `proj-airi:livestream` BroadcastChannel. The Stage registers listeners while mounted.

Collectors read `livestreamSnapshot` and use its current `sessionId`. They send this payload through `livestreamBatch`:

```ts
import { getLivestreamContext, livestreamBatch } from '@proj-airi/stage-ui/services/livestream'

getLivestreamContext().emit(livestreamBatch, {
  sessionId: activeBroadcastId,
  batchId: 'collector-batch-42',
  source: 'douyin',
  messages: [{
    id: 'platform-comment-123',
    userId: 'viewer-7',
    nickname: 'Viewer',
    text: 'What happened after the teacher opened the door?',
    createdAt: Date.now(),
  }],
})
```

This example runs inside an application renderer with the same origin. An external collector needs a transport bridge into this contract.
The first version includes no Douyin collector, public HTTP listener, or OBS control.

Each batch accepts up to 100 messages. Each message accepts up to 500 characters.
The candidate pool keeps the newest 50 comments. Comments expire after 90 seconds.
Message IDs and repeated text from the same source and viewer are deduplicated for 120 seconds, within a bounded cache.
`createdAt` uses Unix milliseconds. Candidate ages help the planner prioritize recent conversation.
The host validates batches and model plans with Valibot. A response must reference actual pending candidate IDs.

`MockComments` uses the same event. The UI supplies 16 sample messages, including repeats, topic changes, and rejected requests.
The simulator sends one to four comments every three to twelve seconds. Pause and stop cancel its timer.
The manual sample button emits one batch. Neither mode fabricates real viewers or reads a live platform.
The manual comment command accepts a nickname and text. It emits the same batch contract with a unique message ID.

## Content and failure policy

The planner preserves operator details in original fiction or a named literary work.
It excludes political and historical debate and promotion of illegal conduct or bullying.
An operator can request classical literature. The retelling preserves the supplied plot and excludes graphic violence and real-world political commentary.
The character narrates in the first person with conversational Mandarin. It takes the protagonist's role while preserving supplied names and details.
The opening establishes the fictional role once. Later sentences avoid repeated disclaimers, formal narration, and excessive filler words.
It allows mild teasing, reflection after mistakes, and stories that oppose bullying.
Audience messages are conversation data. They cannot change system rules or execute commands.
The model uses supplied material and existing knowledge. It must acknowledge uncertainty about factual claims.

## Prompt ownership

The operator maintains three Markdown inputs: a stable Soul, stable livestream rules, and a brief for each episode.
`constants/prompts/soul.md` joins the character card identity in the existing card store.
Ordinary chat and proactive notifications use that identity with their existing task instructions.
The livestream reads the same identity through `getIdentityPrompt`, without stage controls or artistry tool instructions.
It adds `libs/livestream/prompts/livestream-rules.md` and the complete writing skill to each system prompt.
The episode stays in `settings.details` in user context. It can assign a temporary story role, not overwrite permanent identity.
The workspace at `/settings/livestream` edits all three inputs. Markdown files supply defaults, while explicit saves create local overrides.
`stores/livestream-settings.ts` validates and persists one versioned snapshot through a leader-owned synchronized action.
Editors keep drafts outside synchronized state. A stale revision cannot overwrite a newer save from another window.
Persistence completes before the live snapshot changes. Storage failures leave the saved configuration intact.
Ordinary chat reads saved Soul edits on its next request. The host freezes identity and rules at broadcast start.
Closing the settings window does not stop the Stage-owned broadcast. Source defaults still require a rebuild after edits.
Standalone integrations have separate prompt ownership. They do not load the Stage UI Soul.

The content decision comes from the same model request. It is not an independent moderation guarantee.
Each preparation has a 45-second deadline. Failures retry after two seconds and pause after three consecutive failures.
Playback failures pause immediately. The UI shows the error and leaves resume and stop available.

## Measurement and retention

The panel shows recent generation time, synthesis time, audio gap, and comment-to-playback wait.
It counts synthesized characters and discarded prepared characters. These are estimates, not provider billing records.
Actual charges depend on the selected voice and provider. A cancelled request can still incur charges.

Broadcast state stays in memory and resets on a new start. The loop stores no cross-broadcast memory or account credentials.
The review log retains the latest 5000 output, comment, and direction entries. The copy action includes the brief and available log as Markdown.
Closing only the chat control does not stop the Stage. Use Pause or Stop to end autonomous output.

## Verification

Policy tests cover slow replacements, sentence commits, return bookmarks, expiry, deduplication, cancellation, and bounded retries.
A browser test covers real controls and Eventa transport across separate BroadcastChannel instances.
Desktop verification uses the existing ChatGPT and MiniMax configuration. It measures actual speech and checks the existing lip-sync path.
Development tests use simulated generation and audio without provider calls. A short real speech check runs only after the other checks pass.
Text rehearsal tests advance a simulated clock through 30 minutes and a pause. They assert that no speech output opens.
Rehearsal verification does not require a real speech check.
