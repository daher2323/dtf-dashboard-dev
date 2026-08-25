# Claude Code Cheat Sheet

## Daily startup

1. Open **Terminal** (Cmd + Space, type "Terminal")
2. Go to the repo:
   ```
   cd ~/Documents/dtf-dashboard-dev
   ```
3. Start Claude Code:
   ```
   claude
   ```
   - Add `--continue` to resume yesterday's conversation: `claude --continue`

## Common requests (just type these at the prompt)

- "What's in index.html?" — ask Claude to summarize a file
- "Add a button that does X" — make a change
- "Undo the last change"
- "Revert index.html to the last commit"
- "Commit these changes with message: <your message>"
- "Show me the current git status"

## Saving your work

- After changes you like: **"commit these changes"**
- Commits are your safety net — you can always roll back to one.

## Previewing

- Double-click `index.html` in Finder to open in browser
- Reload browser after each change

## Promoting dev to prod

1. Copy `index.html` from `dtf-dashboard-dev/` to your prod repo folder
2. In prod repo: commit and push to GitHub
   - Or just ask Claude Code to do it: "copy index.html to my prod repo and push"

## Ending a session

- Type `/exit` inside Claude Code (or press Ctrl+D)
- Close Terminal when done

## If something breaks

- **Claude says "command not found: claude"** — restart Terminal
- **Git asks for password** — you need a GitHub Personal Access Token; ask Claude Code for help setting it up
- **Edits gone wrong** — "revert index.html to the last commit"

## Useful slash commands inside Claude Code

- `/help` — list all commands
- `/clear` — clear the current conversation
- `/init` — regenerate CLAUDE.md (project context)
- `/exit` — quit
