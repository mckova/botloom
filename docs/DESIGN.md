# Design direction

BotLoom is a workbench. The people using it are the owners and staff of small businesses (a physio clinic, a gadget shop) who wire up an agent once, then come back daily to answer the handoffs it leaves them. The interface is built for the hundredth visit, not the first.

## Product read

An index + detail tool (agents, runs, inbox) around one canvas (the flow builder), for an operator at standard density. Data is tens of agents and hundreds of runs per agent. Most actions are reversible (edit a step, hand a chat back). Deleting an agent is the one destructive action and it goes through a native confirm dialog.

## Dials

| Dial | Value | Why |
|---|---|---|
| Energy | 1 | People come here to fix a flow or answer a customer. Nothing on screen competes with that. |
| Rhythm | 2 | Three densities only: chrome (sidebar), lists (36 to 40px rows), and the canvas. |
| Motion | 1 | Motion is feedback: a press scales to 0.97, panels enter in 160ms with an ease-out curve. Nothing animates on its own, and reduced motion turns all of it off. |
| Density | 2 | Standard rows, compact numbers. |
| Consequence | 2 | Reversible by default, one confirmed delete. |

## Decisions and the reason for each

- **Olive chrome sidebar (#22251b).** The sidebar is where you switch agents, so it reads as furniture: dark, low contrast, out of the way. Olive instead of grey or navy because the product is about weaving threads, and undyed linen and loom wood sit in that range.
- **Mineral canvas (#f1f2ed) and off-white surfaces (#fbfbf8).** A slightly green-grey ground keeps long sessions calm and lets the white cards for selected steps lift without shadows doing the work.
- **One accent: brick (#b4441f).** Used for the primary action on each screen, the live-run state, and text selection. Never for decoration. A warm red-brown reads as "thread" next to the olive and stays distinct from the error red.
- **Step-type colors are muted (moss, slate, ochre, rust, steel).** On the canvas a person needs to tell a trigger from an AI step from an integration at a glance. They are desaturated so five of them together still look like one palette.
- **IBM Plex Sans, Plex Sans Hebrew, Plex Mono.** Agents here talk to customers in Hebrew and English in the same chat. Plex is one of the few families drawn with a Hebrew companion at matching weights and x-height, so a mixed transcript does not jump between two typefaces. Its engineered grotesque shapes suit a tool for building machinery. Mono is used only for ids, durations and token counts.
- **Rows, not cards.** Agents, runs, conversations and examples are lists with hairline dividers. Cards exist only for a selected step on the canvas and the inbox brief.
- **Icons only where they identify something.** Each step type and each channel has one glyph, so a flow can be read from its shapes. No icon sits next to a heading for decoration. Strokes use square caps and mitred joins to match the logo's straight warp and weft.
- **Dot grid on the canvas only.** It gives a spatial reference while dragging steps into rows. Nowhere else has a background pattern.
- **Underline tabs in the top bar.** Flow, Inbox, Runs, Knowledge, Channels and Settings are views of one agent, not separate apps, so they sit as tabs under the agent's name.
- **The copilot is a command bar, not a chat bubble.** Editing a flow in words ("add a step that asks for the order number") returns a list of proposed changes with Apply and Discard. Nothing changes until you apply it.
- **The inbox opens on the brief.** When an agent hands a chat to a person, Claude writes a short brief (what the customer wants, mood, urgency, next step) so staff do not read the whole transcript first. It says who wrote it: Claude or the rule-based fallback.
- **Absolute dates after a week, relative before.** "3h ago" helps when triaging today; "12 Oct" is what you need when looking back.
- **No em dashes, no emoji in UI text, no invented numbers.** Every number on screen comes from the database.

## Tokens

Spacing on a 4px scale, radii 4/6/8px, three elevations, a fixed z-index scale (toolbar 10, dialog 50, toast 60). All in `web/src/styles.css`.
