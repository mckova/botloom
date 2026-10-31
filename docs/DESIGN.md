# Design direction

BotLoom is a workbench. The people using it are the owners and staff of small businesses (a physio clinic, a gadget shop) who wire up an agent once, then come back daily to answer the conversations it hands them. The interface is built for the hundredth visit, not the first, so it opens on the inbox.

## Product read

A shared inbox, an index of agents, and one canvas (the flow builder), for an operator at standard density. Data is tens of agents and hundreds of conversations. Most actions are reversible (edit a note, hand a chat back). Deleting an agent is the one destructive action and it goes through a confirm dialog.

## Dials

| Dial | Value | Why |
|---|---|---|
| Energy | 1 | People come here to answer a customer or fix a flow. Nothing on screen competes with that. |
| Rhythm | 2 | Four columns in the inbox (folders, list, conversation, context), two everywhere else. |
| Motion | 1 | Motion is feedback: a press scales to 0.97, sheets fade in over 160ms. Reduced motion turns it off. |
| Density | 2 | Standard rows, generous type in the conversation. |
| Consequence | 2 | Reversible by default, one confirmed delete. |

## Decisions and the reason for each

- **The inbox is the home page, across all agents.** A small team does not think per bot; it thinks "who is waiting for me". Folders on the left are the three questions people ask: who is waiting, what the agents handled alone, and everything. Agents and channels are filters under them.
- **Waiting is sorted oldest first.** The person who has waited longest is answered first. Everything else is newest first.
- **Every answer explains itself.** Under each agent answer the inbox names the knowledge note it came from and quotes the passage the agent read. The fix sits next to the cause: "Edit this note" opens the note in place, "Teach a better answer" saves a correction note the agent searches like any other. This is how a non-technical owner improves an AI agent without opening the flow.
- **The brief leads the context panel.** When an agent hands a chat over, Claude writes what happened and the next step. It is set large because it is read first. It says when it came from the rule-based fallback instead of Claude.
- **One primary action per screen: "Send and hand back".** Replying and returning the chat to the agent is one step, because forgetting to hand back leaves the agent silent.
- **Colour lives in the background, not on the controls.** A warm dawn gradient (peach #f6c9a8, lavender #b9a8e6, rose #f2b8c6 over #e3d6ea) sits behind frosted glass panels (white at 50 to 72 percent, 28px blur, 22px radius, a white hairline edge). Text, buttons and selection are one ink, #121821, at three strengths. Nothing competes with the conversation for attention, and the screen still feels alive.
- **The primary button is a lifted pane of glass with dark text.** A solid black or coloured block would be the loudest thing on screen; a brighter pane with a soft shadow is found without shouting.
- **Text buttons, no icons in the inbox.** Each action is a short verb phrase. Icons appear only on the flow canvas, where each step type needs a shape you can scan.
- **Geist, with Noto Sans Hebrew for Hebrew text.** Geist is a neutral grotesque with tight, even spacing that stays quiet at 13 to 22px. Agents here talk to customers in Hebrew and English in the same inbox, so Hebrew falls back to Noto Sans Hebrew, whose proportions sit close to Geist. Weights are 400 and 500 only. Geist Mono is used for ids, durations and trace data.
- **Mixed-direction text picks its own direction.** Names and messages use `dir="auto"` with `unicode-bidi: plaintext`, so a Hebrew message reads right to left inside the English interface without breaking the layout.
- **Every number comes from the database.** Reports are counted from runs; nothing on screen is invented.
- **No em dashes, no emoji in UI text.**

## Tokens

Spacing on a 4px scale, radii 6/10/14/22px, glass levels at 50 and 72 percent white, a fixed z-index scale (toolbar 10, sheet 40, dialog 50, toast 60). All in `web/src/styles.css`.
