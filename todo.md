

### optimisations
[] the loading animation bar in the top right over the name of the agent should be 4 hight not 3, so it takes up full height of the pill.

[] tools & running command headers should be collapsed by default, and only expand when clicked.

[] notifications should come with the sirus logo

[] highlighting input bar only highlights within the input bar.

[] remove the 5h from codex in the usage menu since codex doesn't have a 5h limit.

[] skills/commands can be run in the middle of a prompt too not just at the start.

[] when a message is addressed to a given agent, it should automatically navigate to that agent's session. if a message tags multiple agents, it should navigate to the first agent's session and display all the other agent's messages in that session too for that turn (as in through the current method where it appears both in their session but also in the selected session if u get what i mean, this is a convenience/UX addition not a structural change). note that a tag being NOT the first thing indicates the first agent being "tagged" (not really, but in terms of the user's intent) is sirus. so it shuld stay in sirus in that case. 

[] @name model thinking should be allowed from anywhere in a prompt. also, in a prompt, suppose i do /model opus [prompt] it should apply the /model. it should also work with /model [model] [thinking mode] prompt. as in all commands should work like that.
## features
[] auto-rag + breadcrumb memory system (copy from ../sirius)
